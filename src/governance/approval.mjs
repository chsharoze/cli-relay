/**
 * cli-relay loop — plan-bound review approval.
 *
 * Ported (deliberately, not wholesale) from claudex-loop (github.com/chaseai-yt/claudex-loop),
 * independently reviewed 2026-09-21 (see ~/Desktop/repo-evaluations-2026-09-21/). What's borrowed:
 * approval cryptographically bound to the plan's exact bytes and the exact repo/plan paths
 * (`checkApproval` mirrors its `check_approval`), a before/after tree fingerprint that catches
 * a repo mutated mid-review or after approval (mirrors its `snapshot`), and a verdict schema
 * that rejects a self-contradictory APPROVED-with-findings result (mirrors `validate_review`).
 * What's deliberately NOT borrowed: claudex-loop treats a read-only shell sandbox as reviewer
 * confinement, which its own docs admit does not cover MCP side effects — this module makes no
 * confinement claim at all. It only answers "does this verdict still apply to what's on disk
 * right now", never "was the reviewer actually sandboxed". Confinement is the caller's job
 * (pick a reviewer backend/flags that don't grant write tools).
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  lstatSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { STATE_DIR } from '../config.mjs';
import { canonicalStringify } from './ledger.mjs';

export const APPROVALS_VERSION = 1;
export const APPROVALS_DIR = join(STATE_DIR, 'governance');
export const APPROVALS_PATH = join(APPROVALS_DIR, 'approvals.json');

export const VERDICTS = Object.freeze(['APPROVED', 'REVISE', 'BLOCKED']);
export const SEVERITIES = Object.freeze(['low', 'medium', 'high']);
const VERDICT_KEYS = new Set(['verdict', 'summary', 'findings', 'coverage', 'limitations']);
const FINDING_KEYS = new Set(['id', 'severity', 'description']);

const DEFAULT_SNAPSHOT_EXCLUDES = Object.freeze(['.git', 'node_modules']);

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Verdict schema, deliberately mirroring claudex-loop's validate_review:
 * exact key set, verdict enum, non-empty summary, unique finding ids with an enum
 * severity, coverage required unless BLOCKED, REVISE needs findings, BLOCKED needs
 * limitations, and — the rule that actually matters — APPROVED cannot carry a
 * medium/high finding, so an approval can never silently contradict its own findings.
 * Returns an array of error strings; empty means valid. Never throws on bad input.
 */
export function validateVerdict(verdict) {
  const errors = [];
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) {
    return ['verdict must be an object'];
  }

  for (const key of Object.keys(verdict)) {
    if (!VERDICT_KEYS.has(key)) errors.push(`unexpected key "${key}"`);
  }

  if (!VERDICTS.includes(verdict.verdict)) {
    errors.push(`verdict.verdict must be one of ${VERDICTS.join('/')}`);
  }
  if (typeof verdict.summary !== 'string' || verdict.summary.trim().length === 0) {
    errors.push('verdict.summary must be a non-empty string');
  }

  const findings = verdict.findings ?? [];
  if (!Array.isArray(findings)) {
    errors.push('verdict.findings must be an array');
  } else {
    const seenIds = new Set();
    for (const [index, finding] of findings.entries()) {
      if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
        errors.push(`findings[${index}] must be an object`);
        continue;
      }
      for (const key of Object.keys(finding)) {
        if (!FINDING_KEYS.has(key)) errors.push(`findings[${index}] has unexpected key "${key}"`);
      }
      if (typeof finding.id !== 'string' || finding.id.trim().length === 0) {
        errors.push(`findings[${index}].id must be a non-empty string`);
      } else if (seenIds.has(finding.id)) {
        errors.push(`findings[${index}].id "${finding.id}" is not unique`);
      } else {
        seenIds.add(finding.id);
      }
      if (!SEVERITIES.includes(finding.severity)) {
        errors.push(`findings[${index}].severity must be one of ${SEVERITIES.join('/')}`);
      }
      if (typeof finding.description !== 'string' || finding.description.trim().length === 0) {
        errors.push(`findings[${index}].description must be a non-empty string`);
      }
    }
  }

  if (verdict.verdict === 'APPROVED' && Array.isArray(findings)) {
    const blocking = findings.filter((f) => f?.severity === 'high' || f?.severity === 'medium');
    if (blocking.length > 0) {
      errors.push(
        `verdict is APPROVED but carries ${blocking.length} medium/high finding(s) ` +
        `(${blocking.map((f) => f.id).join(', ')}) — an approval cannot contradict its own findings`,
      );
    }
  }
  if (verdict.verdict === 'REVISE' && Array.isArray(findings) && findings.length === 0) {
    errors.push('verdict is REVISE but carries no findings');
  }
  if (verdict.verdict === 'BLOCKED') {
    if (typeof verdict.limitations !== 'string' || verdict.limitations.trim().length === 0) {
      errors.push('verdict is BLOCKED but limitations is missing or empty');
    }
  } else if (verdict.coverage !== undefined) {
    if (typeof verdict.coverage !== 'string' || verdict.coverage.trim().length === 0) {
      errors.push('verdict.coverage must be a non-empty string when present');
    }
  } else {
    errors.push(`verdict.coverage is required unless verdict is BLOCKED`);
  }

  return errors;
}

export function assertValidVerdict(verdict) {
  const errors = validateVerdict(verdict);
  if (errors.length > 0) {
    throw new Error(`invalid verdict: ${errors.join('; ')}`);
  }
  return verdict;
}

/**
 * Fingerprints a directory tree deterministically: every regular file's content hash,
 * every symlink's literal target (never followed, mirroring claudex-loop's snapshot),
 * combined into one canonical-JSON manifest and hashed. Same manifest shape in, same
 * fingerprint out — order of traversal never matters because the manifest is sorted
 * before hashing (canonicalStringify, shared with the governance ledger).
 */
export function snapshotTree(rootPath, { exclude = DEFAULT_SNAPSHOT_EXCLUDES } = {}) {
  const root = resolve(rootPath);
  if (!existsSync(root)) {
    throw new Error(`snapshot target does not exist: ${root}`);
  }
  const excludeSet = new Set(exclude);
  const manifest = {};

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (excludeSet.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath).split('\\').join('/');
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        manifest[relPath] = `symlink:${readlinkSync(fullPath)}`;
      } else if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        manifest[relPath] = `file:${sha256Hex(readFileSync(fullPath))}`;
      }
      // Other types (sockets, fifos, devices) are deliberately not fingerprinted;
      // they aren't reviewable source content.
    }
  };
  walk(root);

  return {
    fingerprint: sha256Hex(canonicalStringify(manifest)),
    fileCount: Object.keys(manifest).length,
    manifest,
  };
}

/** Diffs two manifests from snapshotTree for a human-readable mismatch report. */
export function diffManifests(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));
  for (const key of afterKeys) {
    if (!beforeKeys.has(key)) added.push(key);
    else if (before[key] !== after[key]) changed.push(key);
  }
  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) removed.push(key);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

function loadApprovals() {
  if (!existsSync(APPROVALS_PATH)) return { version: APPROVALS_VERSION, approvals: {} };
  const parsed = JSON.parse(readFileSync(APPROVALS_PATH, 'utf8'));
  if (parsed.version !== APPROVALS_VERSION) {
    throw new Error(
      `${APPROVALS_PATH} version ${parsed.version} unsupported (loop wants ${APPROVALS_VERSION})`,
    );
  }
  return parsed;
}

function saveApprovals(store) {
  mkdirSync(APPROVALS_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${APPROVALS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, APPROVALS_PATH);
}

/**
 * Records a verdict, binding it to the plan's exact bytes (SHA-256), the exact
 * repo/plan paths, and a full-tree fingerprint of the repo at review time. This is
 * the artifact checkApproval later re-verifies against — not a claim the review was
 * sandboxed, only a claim that "this verdict was issued against exactly this plan and
 * exactly this tree, and nothing has since diverged from either".
 */
export function recordApproval({
  thread,
  planPath,
  repoPath,
  reviewer,
  model = null,
  verdict,
  snapshotExclude,
}) {
  if (!thread || typeof thread !== 'string') throw new Error('thread is required');
  if (!reviewer || typeof reviewer !== 'string') throw new Error('reviewer is required');
  assertValidVerdict(verdict);

  const resolvedPlanPath = resolve(planPath);
  if (!existsSync(resolvedPlanPath)) throw new Error(`plan not found: ${resolvedPlanPath}`);
  const resolvedRepoPath = resolve(repoPath);
  const planHash = sha256Hex(readFileSync(resolvedPlanPath));
  const snapshot = snapshotTree(resolvedRepoPath, { exclude: snapshotExclude });

  const record = {
    version: APPROVALS_VERSION,
    thread,
    reviewer,
    model,
    plan_path: resolvedPlanPath,
    repo_path: resolvedRepoPath,
    plan_hash: planHash,
    snapshot_fingerprint: snapshot.fingerprint,
    file_count: snapshot.fileCount,
    manifest: snapshot.manifest,
    verdict,
    recorded_at: new Date().toISOString(),
  };

  const store = loadApprovals();
  store.approvals[thread] = record;
  saveApprovals(store);
  return record;
}

export function getApproval(thread) {
  return loadApprovals().approvals[thread] ?? null;
}

/**
 * Re-verifies a recorded approval against what's on disk right now. Mirrors
 * claudex-loop's check_approval: status must be APPROVED, and the plan hash + exact
 * repo/plan paths must still match. Adds the snapshot recheck claudex-loop's binding
 * alone doesn't cover — a plan can be untouched while the reviewed tree was mutated
 * after approval, and that must invalidate the approval too.
 */
export function checkApproval({ thread, planPath, repoPath, snapshotExclude }) {
  const record = getApproval(thread);
  if (!record) {
    return { allowed: false, reason: `no approval recorded for thread "${thread}"` };
  }
  if (record.verdict?.verdict !== 'APPROVED') {
    return { allowed: false, reason: `recorded verdict is ${record.verdict?.verdict ?? 'unknown'}, not APPROVED`, record };
  }

  const resolvedPlanPath = resolve(planPath ?? record.plan_path);
  const resolvedRepoPath = resolve(repoPath ?? record.repo_path);
  if (resolvedPlanPath !== record.plan_path) {
    return {
      allowed: false,
      reason: `plan path mismatch: approved ${record.plan_path}, checking ${resolvedPlanPath}`,
      record,
    };
  }
  if (resolvedRepoPath !== record.repo_path) {
    return {
      allowed: false,
      reason: `repo path mismatch: approved ${record.repo_path}, checking ${resolvedRepoPath}`,
      record,
    };
  }

  if (!existsSync(resolvedPlanPath)) {
    return { allowed: false, reason: `plan file no longer exists: ${resolvedPlanPath}`, record };
  }
  const currentPlanHash = sha256Hex(readFileSync(resolvedPlanPath));
  if (currentPlanHash !== record.plan_hash) {
    return {
      allowed: false,
      reason: 'plan has changed since approval (SHA-256 mismatch)',
      record,
      currentPlanHash,
    };
  }

  const currentSnapshot = snapshotTree(resolvedRepoPath, { exclude: snapshotExclude });
  if (currentSnapshot.fingerprint !== record.snapshot_fingerprint) {
    return {
      allowed: false,
      reason: 'repository tree has changed since approval (mutated mid-review or after)',
      record,
      diff: diffManifests(record.manifest ?? {}, currentSnapshot.manifest),
    };
  }

  return { allowed: true, reason: null, record };
}
