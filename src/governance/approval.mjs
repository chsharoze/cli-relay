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
import {
  appendLedgerEntryLocked, canonicalStringify, computeLedgerHash, readLedgerEntries,
  verifyLedger, withLedgerLock,
} from './ledger.mjs';

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

/** Key that makes one reviewer (backend) plus its model a distinct approver. */
export function reviewerKey(reviewer, model = null) {
  return `${reviewer}:${model ?? ''}`;
}

function isApprovalRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Boolean(value.verdict) && typeof value.verdict === 'object';
}

/**
 * Normalizes a thread's stored value into reviewerKey -> array of records. Handles both
 * the legacy single-record shape (migrated in memory as one reviewer) and the current
 * per-reviewer shape. Each reviewer keeps its own history so a verdict recorded against
 * an older build stays visible as stale rather than being silently overwritten.
 */
function threadReviewerRecords(raw) {
  const byReviewer = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return byReviewer;
  if (isApprovalRecord(raw)) {
    byReviewer[reviewerKey(raw.reviewer, raw.model ?? null)] = [raw];
    return byReviewer;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      const records = value.filter(isApprovalRecord);
      if (records.length > 0) byReviewer[key] = records;
    } else if (isApprovalRecord(value)) {
      byReviewer[key] = [value];
    }
  }
  return byReviewer;
}

function allThreadRecords(raw) {
  return Object.entries(threadReviewerRecords(raw))
    .flatMap(([key, records]) => records.map((record) => ({ key, record })));
}

// Identifies the exact reviewed build: plan bytes plus the repo tree fingerprint.
function recordFingerprint(record) {
  return `${record.plan_hash}\u0000${record.snapshot_fingerprint}`;
}

function newestRecord(records) {
  return records.reduce((latest, record) =>
    Date.parse(record.recorded_at ?? 0) >= Date.parse(latest.recorded_at ?? 0) ? record : latest);
}

function staleReportFor(entries) {
  return entries.map(({ key, record }) => ({
    reviewer_key: key,
    reviewer: record.reviewer ?? null,
    model: record.model ?? null,
    verdict: record.verdict?.verdict ?? null,
    plan_hash: record.plan_hash ?? null,
    snapshot_fingerprint: record.snapshot_fingerprint ?? null,
    plan_path: record.plan_path ?? null,
    repo_path: record.repo_path ?? null,
    recorded_at: record.recorded_at ?? null,
  }));
}

/**
 * Returns a refusal string when a current record's ledger anchor is absent or no longer
 * agrees with the record it is supposed to certify. This is the rollback gate: removing
 * or replacing the anchored ledger entry must make the approval unusable, not silently
 * leave it in force.
 */
function anchorViolation(ledgerByHash, { thread, record }) {
  const hash = record.ledger_hash;
  if (typeof hash !== 'string' || hash.length === 0) {
    return `approval for thread "${thread}" by reviewer "${record.reviewer ?? 'unknown'}" ` +
      'has no ledger anchor (legacy record) — re-record it with "cli-relay loop record"';
  }
  const entry = ledgerByHash.get(hash);
  if (!entry) {
    return `approval anchor ${hash} is missing from the governance ledger ` +
      `(thread "${thread}", reviewer "${record.reviewer ?? 'unknown'}") — the ledger may have ` +
      'been rolled back; re-record the approval';
  }
  // The anchor must not merely be findable: its own hash must recompute from its stored
  // fields. A forged or replayed line carrying a matching hash string is refused here.
  let recomputed;
  try {
    recomputed = computeLedgerHash(entry);
  } catch (error) {
    return `approval anchor ${hash} cannot be hashed (${error.message}) — refusing`;
  }
  if (recomputed !== hash) {
    return `approval anchor ${hash} does not recompute from its stored fields ` +
      '(the ledger entry was altered) — refusing';
  }
  // The anchor is only meaningful inside an intact chain: a self-consistent entry spliced
  // into a broken history (or a rolled-back tail) must not certify an approval.
  const chain = verifyLedger();
  if (!chain.intact) {
    return `governance ledger fails verification (${chain.reason ?? 'broken chain'}) — the ` +
      'approval anchor cannot be trusted';
  }
  if (entry.thread !== thread) {
    return `approval anchor ${hash} records thread ${JSON.stringify(entry.thread)}, not "${thread}"`;
  }
  if (entry.plan_hash !== record.plan_hash) {
    return `approval anchor ${hash} records a different plan hash`;
  }
  if (entry.snapshot_fingerprint !== record.snapshot_fingerprint) {
    return `approval anchor ${hash} records a different repository fingerprint`;
  }
  if (entry.backend !== record.reviewer) {
    return `approval anchor ${hash} records reviewer ${JSON.stringify(entry.backend)}, ` +
      `not "${record.reviewer}"`;
  }
  if ((entry.approval_verdict ?? null) !== (record.verdict?.verdict ?? null)) {
    return `approval anchor ${hash} records verdict ${JSON.stringify(entry.approval_verdict ?? null)}, ` +
      `not "${record.verdict?.verdict ?? 'unknown'}"`;
  }
  return null;
}

/**
 * Records a verdict, binding it to the plan's exact bytes (SHA-256), the exact
 * repo/plan paths, and a full-tree fingerprint of the repo at review time. It is stored
 * per reviewer (backend + model), preserving each reviewer's earlier verdicts as stale
 * history. The approval is anchored in the governance ledger FIRST: the ledger entry is
 * appended through the shared append path, and only its returned hash is stored as
 * `ledger_hash` on the record. If the append cannot produce a hash, no approval is
 * written — an unanchored approval is never created.
 */
export async function recordApproval({
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

  const ledgerEntry = {
    backend: reviewer,
    thread,
    mode: 'loop-review',
    outcome: verdict.verdict.toLowerCase(),
    exit_code: null,
    tier: 1,
    tier_name: 'read-only',
    gate_allowed: verdict.verdict === 'APPROVED',
    model,
    reviewer,
    approval_verdict: verdict.verdict,
    plan_path: resolvedPlanPath,
    repo_path: resolvedRepoPath,
    plan_hash: planHash,
    snapshot_fingerprint: snapshot.fingerprint,
    finding_count: Array.isArray(verdict.findings) ? verdict.findings.length : 0,
  };

  // The ledger append and the approvals read-modify-write share one lock, so two
  // concurrent records on the same thread serialize instead of losing an update. The
  // append is strict: if the existing tail cannot be read, this refuses rather than
  // anchoring the approval to an unknown predecessor.
  return await withLedgerLock(() => {
    const ledgerHash = appendLedgerEntryLocked(ledgerEntry, { strictTail: true });
    if (typeof ledgerHash !== 'string' || ledgerHash.length === 0) {
      throw new Error(
        'could not anchor approval in the governance ledger (append did not return a hash) ' +
        '— refusing to record an unanchored approval',
      );
    }

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
      ledger_hash: ledgerHash,
    };

    const store = loadApprovals();
    const byReviewer = threadReviewerRecords(store.approvals[thread]);
    const key = reviewerKey(reviewer, model);
    const fingerprint = recordFingerprint(record);
    const kept = (byReviewer[key] ?? [])
      .filter((existing) => recordFingerprint(existing) !== fingerprint);
    kept.push(record);
    byReviewer[key] = kept;
    store.approvals[thread] = byReviewer;
    saveApprovals(store);
    return record;
  });
}

/** Returns the most recently recorded approval for a thread, or null. */
export function getApproval(thread) {
  const entries = allThreadRecords(loadApprovals().approvals[thread]);
  if (entries.length === 0) return null;
  return newestRecord(entries.map(({ record }) => record));
}

/**
 * Lists every recorded approval whose ledger anchor cannot be resolved — either a legacy
 * record with no `ledger_hash` at all, or one whose anchored ledger entry is gone. Used by
 * `audit verify` to surface approvals that no longer have a rollback-evident anchor.
 */
export function missingApprovalAnchors() {
  const hashes = new Set();
  for (const entry of readLedgerEntries()) {
    if (typeof entry?.hash === 'string') hashes.add(entry.hash);
  }
  const missing = [];
  for (const [thread, raw] of Object.entries(loadApprovals().approvals)) {
    for (const { key, record } of allThreadRecords(raw)) {
      const hash = record.ledger_hash;
      if (typeof hash !== 'string' || hash.length === 0) {
        missing.push({
          thread,
          reviewer_key: key,
          reviewer: record.reviewer ?? null,
          model: record.model ?? null,
          ledger_hash: null,
          reason: 'no ledger anchor (legacy record)',
        });
      } else if (!hashes.has(hash)) {
        missing.push({
          thread,
          reviewer_key: key,
          reviewer: record.reviewer ?? null,
          model: record.model ?? null,
          ledger_hash: hash,
          reason: 'anchored ledger entry is missing',
        });
      }
    }
  }
  return missing;
}

/**
 * Re-verifies a recorded approval against what's on disk right now. Mirrors
 * claudex-loop's check_approval: status must be APPROVED, and the plan hash + exact
 * repo/plan paths must still match. Adds the snapshot recheck claudex-loop's binding
 * alone doesn't cover — a plan can be untouched while the reviewed tree was mutated
 * after approval, and that must invalidate the approval too.
 *
 * Per-reviewer: records whose fingerprint (plan + repo tree) does not match the current
 * build are ignored but reported as stale. Approval is allowed only when at least one
 * current record exists, every current record is APPROVED, and every current record's
 * ledger anchor still resolves and agrees. There is no override.
 */
export function checkApproval({ thread, planPath, repoPath, snapshotExclude }) {
  const raw = loadApprovals().approvals[thread];
  if (raw === undefined || raw === null) {
    return { allowed: false, reason: `no approval recorded for thread "${thread}"` };
  }
  const entries = allThreadRecords(raw);
  if (entries.length === 0) {
    return { allowed: false, reason: `no approval recorded for thread "${thread}"` };
  }

  const reference = newestRecord(entries.map(({ record }) => record));
  const resolvedPlanPath = resolve(planPath ?? reference.plan_path);
  const resolvedRepoPath = resolve(repoPath ?? reference.repo_path);

  if (resolvedPlanPath !== reference.plan_path) {
    return {
      allowed: false,
      reason: `plan path mismatch: approved ${reference.plan_path}, checking ${resolvedPlanPath}`,
      record: reference,
    };
  }
  if (resolvedRepoPath !== reference.repo_path) {
    return {
      allowed: false,
      reason: `repo path mismatch: approved ${reference.repo_path}, checking ${resolvedRepoPath}`,
      record: reference,
    };
  }
  if (!existsSync(resolvedPlanPath)) {
    return { allowed: false, reason: `plan file no longer exists: ${resolvedPlanPath}`, record: reference };
  }
  if (!existsSync(resolvedRepoPath)) {
    return { allowed: false, reason: `repository no longer exists: ${resolvedRepoPath}`, record: reference };
  }

  const currentPlanHash = sha256Hex(readFileSync(resolvedPlanPath));
  const currentSnapshot = snapshotTree(resolvedRepoPath, { exclude: snapshotExclude });

  const current = [];
  const stale = [];
  for (const entry of entries) {
    const { record } = entry;
    const isCurrent = record.plan_path === resolvedPlanPath &&
      record.repo_path === resolvedRepoPath &&
      record.plan_hash === currentPlanHash &&
      record.snapshot_fingerprint === currentSnapshot.fingerprint;
    (isCurrent ? current : stale).push(entry);
  }
  const staleReport = staleReportFor(stale);

  if (current.length === 0) {
    if (reference.plan_hash !== currentPlanHash) {
      return {
        allowed: false,
        reason: 'plan has changed since approval (SHA-256 mismatch)',
        record: reference,
        currentPlanHash,
        stale: staleReport,
      };
    }
    if (reference.snapshot_fingerprint !== currentSnapshot.fingerprint) {
      return {
        allowed: false,
        reason: 'repository tree has changed since approval (mutated mid-review or after)',
        record: reference,
        diff: diffManifests(reference.manifest ?? {}, currentSnapshot.manifest),
        stale: staleReport,
      };
    }
    return {
      allowed: false,
      reason: 'no approval recorded for the current build (every recorded verdict is stale)',
      record: reference,
      stale: staleReport,
    };
  }

  const ledgerByHash = new Map();
  for (const entry of readLedgerEntries()) {
    if (typeof entry?.hash === 'string' && !ledgerByHash.has(entry.hash)) {
      ledgerByHash.set(entry.hash, entry);
    }
  }
  for (const { record } of current) {
    const violation = anchorViolation(ledgerByHash, { thread, record });
    if (violation) {
      return { allowed: false, reason: violation, record, stale: staleReport };
    }
  }

  const blocked = current.find(({ record }) => record.verdict?.verdict !== 'APPROVED');
  if (blocked) {
    const { record } = blocked;
    const label = record.model ? `"${record.reviewer}" (${record.model})` : `"${record.reviewer}"`;
    return {
      allowed: false,
      reason: `reviewer ${label} recorded ${record.verdict?.verdict ?? 'unknown'} on the current ` +
        'build — approval is blocked until that reviewer records APPROVED on this fingerprint',
      record,
      stale: staleReport,
    };
  }

  const record = newestRecord(current.map(({ record: currentRecord }) => currentRecord));
  return { allowed: true, reason: null, record, stale: staleReport };
}
