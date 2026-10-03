// Hermetic tests for the loop governance module: verdict schema validation, snapshot
// fingerprinting, and approval binding/recheck (plan-hash + repo-tree + exact paths).
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'cli-relay-loop-'));
const originalHome = process.env.HOME;
process.env.HOME = join(scratch, 'home');

try {
  const {
    validateVerdict, snapshotTree, diffManifests, recordApproval, checkApproval, getApproval,
  } = await import('../src/governance/approval.mjs');

  // --- validateVerdict ---
  assert.deepEqual(validateVerdict({
    verdict: 'APPROVED', summary: 'ok', findings: [], coverage: 'all files',
  }), []);

  assert.deepEqual(validateVerdict(null), ['verdict must be an object']);

  assert.deepEqual(
    validateVerdict({ verdict: 'MAYBE', summary: 'x', coverage: 'y' }),
    ['verdict.verdict must be one of APPROVED/REVISE/BLOCKED'],
  );

  {
    const errors = validateVerdict({
      verdict: 'APPROVED',
      summary: 'ok',
      coverage: 'all',
      findings: [{ id: 'f1', severity: 'high', description: 'bad' }],
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /cannot contradict its own findings/);
  }

  assert.deepEqual(
    validateVerdict({ verdict: 'REVISE', summary: 'x', coverage: 'y', findings: [] }),
    ['verdict is REVISE but carries no findings'],
  );

  assert.deepEqual(
    validateVerdict({ verdict: 'BLOCKED', summary: 'x' }),
    ['verdict is BLOCKED but limitations is missing or empty'],
  );

  assert.deepEqual(
    validateVerdict({ verdict: 'APPROVED', summary: 'x', extra: 1, coverage: 'y' }),
    ['unexpected key "extra"'],
  );

  {
    const errors = validateVerdict({
      verdict: 'REVISE',
      summary: 'x',
      coverage: 'y',
      findings: [
        { id: 'dup', severity: 'low', description: 'a' },
        { id: 'dup', severity: 'low', description: 'b' },
      ],
    });
    assert.ok(errors.some((e) => /not unique/.test(e)));
  }
  console.log('PASS: validateVerdict schema rules');

  // --- snapshotTree ---
  const repo = join(scratch, 'repo');
  mkdirSync(join(repo, 'sub'), { recursive: true });
  writeFileSync(join(repo, 'a.py'), 'print(1)\n');
  writeFileSync(join(repo, 'sub', 'b.py'), 'print(2)\n');
  mkdirSync(join(repo, '.git'));
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  symlinkSync('a.py', join(repo, 'link.py'));

  const snap1 = snapshotTree(repo);
  assert.equal(snap1.fileCount, 3); // a.py, sub/b.py, link.py — .git excluded by default
  assert.equal(snap1.manifest['link.py'], 'symlink:a.py');
  assert.ok(snap1.manifest['a.py'].startsWith('file:'));
  assert.ok(!('/.git/HEAD' in snap1.manifest) && !('.git/HEAD' in snap1.manifest));

  const snap2 = snapshotTree(repo);
  assert.equal(snap1.fingerprint, snap2.fingerprint, 'unchanged tree must fingerprint identically');

  writeFileSync(join(repo, 'sub', 'b.py'), 'print(3)\n');
  const snap3 = snapshotTree(repo);
  assert.notEqual(snap1.fingerprint, snap3.fingerprint);
  const diff = diffManifests(snap1.manifest, snap3.manifest);
  assert.deepEqual(diff, { added: [], removed: [], changed: ['sub/b.py'] });
  console.log('PASS: snapshotTree fingerprint + symlink-as-text + diff');

  // --- recordApproval / checkApproval binding ---
  const planPath = join(scratch, 'plan.md');
  writeFileSync(planPath, '# plan\nstep one\n');
  writeFileSync(join(repo, 'sub', 'b.py'), 'print(2)\n'); // restore to match snap1-equivalent tree

  const goodVerdict = {
    verdict: 'APPROVED', summary: 'clean', findings: [], coverage: 'read everything',
  };
  const record = recordApproval({
    thread: 'thread-a', planPath, repoPath: repo, reviewer: 'codex', model: 'gpt-6-astra', verdict: goodVerdict,
  });
  assert.equal(record.reviewer, 'codex');
  assert.equal(getApproval('thread-a').thread, 'thread-a');

  {
    const result = checkApproval({ thread: 'thread-a', planPath, repoPath: repo });
    assert.equal(result.allowed, true);
  }

  {
    const result = checkApproval({ thread: 'no-such-thread' });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /no approval recorded/);
  }

  // Plan mutated after approval invalidates it, even though the repo is untouched.
  writeFileSync(planPath, '# plan\nstep one (revised)\n');
  {
    const result = checkApproval({ thread: 'thread-a', planPath, repoPath: repo });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /plan has changed/);
  }
  writeFileSync(planPath, '# plan\nstep one\n'); // restore

  // Repo mutated after approval invalidates it, even though the plan is untouched —
  // this is the check claudex-loop's plan-hash-only binding does not by itself cover.
  writeFileSync(join(repo, 'a.py'), 'print("tampered")\n');
  {
    const result = checkApproval({ thread: 'thread-a', planPath, repoPath: repo });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /repository tree has changed/);
    assert.deepEqual(result.diff.changed, ['a.py']);
  }
  writeFileSync(join(repo, 'a.py'), 'print(1)\n'); // restore
  assert.equal(checkApproval({ thread: 'thread-a', planPath, repoPath: repo }).allowed, true);

  // A different repo/plan path than what was approved must not silently pass.
  const otherRepo = join(scratch, 'other-repo');
  mkdirSync(otherRepo);
  writeFileSync(join(otherRepo, 'a.py'), 'print(1)\n');
  {
    const result = checkApproval({ thread: 'thread-a', planPath, repoPath: otherRepo });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /repo path mismatch/);
  }

  // A non-APPROVED verdict can never pass the check, whatever else matches.
  recordApproval({
    thread: 'thread-b',
    planPath,
    repoPath: repo,
    reviewer: 'claude-code',
    verdict: {
      verdict: 'REVISE',
      summary: 'needs changes',
      coverage: 'all',
      findings: [{ id: 'f1', severity: 'low', description: 'nit' }],
    },
  });
  assert.equal(checkApproval({ thread: 'thread-b', planPath, repoPath: repo }).allowed, false);

  // recordApproval itself refuses a self-contradictory verdict — invalid input never
  // reaches disk as a recorded approval.
  assert.throws(
    () => recordApproval({
      thread: 'thread-c',
      planPath,
      repoPath: repo,
      reviewer: 'codex',
      verdict: {
        verdict: 'APPROVED',
        summary: 'ok',
        coverage: 'all',
        findings: [{ id: 'f1', severity: 'medium', description: 'oops' }],
      },
    }),
    /cannot contradict its own findings/,
  );
  assert.equal(getApproval('thread-c'), null);

  console.log('PASS: recordApproval/checkApproval plan+repo binding and recheck');
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(scratch, { recursive: true, force: true });
}
