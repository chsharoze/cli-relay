// Hermetic tests for the loop governance module: verdict schema validation, snapshot
// fingerprinting, and approval binding/recheck (plan-hash + repo-tree + exact paths).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'cli-relay-loop-'));
const originalHome = process.env.HOME;
process.env.HOME = join(scratch, 'home');

try {
  const {
    validateVerdict, snapshotTree, diffManifests, recordApproval, checkApproval, getApproval,
    APPROVALS_PATH,
  } = await import('../src/governance/approval.mjs');
  const { LEDGER_PATH } = await import('../src/config.mjs');

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
  const record = await recordApproval({
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
  await recordApproval({
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
  await assert.rejects(
    recordApproval({
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

  // --- FIX B (a): two reviewers, one APPROVED and one REVISE on the same fingerprint ---
  {
    const thread = 'thread-two-reviewers';
    await recordApproval({
      thread, planPath, repoPath: repo, reviewer: 'codex', model: 'm1',
      verdict: { verdict: 'APPROVED', summary: 'ok', findings: [], coverage: 'all' },
    });
    await recordApproval({
      thread, planPath, repoPath: repo, reviewer: 'claude-code', model: null,
      verdict: {
        verdict: 'REVISE', summary: 'fix it', coverage: 'all',
        findings: [{ id: 'a1', severity: 'low', description: 'nit' }],
      },
    });
    const result = checkApproval({ thread, planPath, repoPath: repo });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /REVISE/);
    console.log('PASS: (a) one APPROVED + one REVISE on the same fingerprint blocks');
  }

  // --- FIX B (b): same reviewer re-reviews a new fingerprint; stale record reported ---
  {
    const thread = 'thread-revise-then-approve';
    const planB = join(scratch, 'plan-b.md');
    writeFileSync(planB, '# plan b\n');
    const repoB = join(scratch, 'repo-b');
    mkdirSync(repoB);
    writeFileSync(join(repoB, 'a.py'), 'print(1)\n');

    await recordApproval({
      thread, planPath: planB, repoPath: repoB, reviewer: 'codex', model: 'm1',
      verdict: {
        verdict: 'REVISE', summary: 'fix it', coverage: 'all',
        findings: [{ id: 'b1', severity: 'low', description: 'nit' }],
      },
    });
    // The build changes; the same reviewer re-records against the new fingerprint.
    writeFileSync(join(repoB, 'a.py'), 'print(2)\n');
    await recordApproval({
      thread, planPath: planB, repoPath: repoB, reviewer: 'codex', model: 'm1',
      verdict: { verdict: 'APPROVED', summary: 'now clean', findings: [], coverage: 'all' },
    });

    const result = checkApproval({ thread, planPath: planB, repoPath: repoB });
    assert.equal(result.allowed, true);
    assert.equal(result.stale.length, 1);
    assert.equal(result.stale[0].verdict, 'REVISE');
    console.log('PASS: (b) re-review on a new fingerprint allows and reports the stale verdict');
  }

  // --- FIX A (c): removing the anchored ledger entry refuses the approval ---
  {
    const thread = 'thread-anchor';
    const planC = join(scratch, 'plan-c.md');
    writeFileSync(planC, '# plan c\n');
    const repoC = join(scratch, 'repo-c');
    mkdirSync(repoC);
    writeFileSync(join(repoC, 'a.py'), 'print(1)\n');

    const rec = await recordApproval({
      thread, planPath: planC, repoPath: repoC, reviewer: 'codex', model: 'm1',
      verdict: { verdict: 'APPROVED', summary: 'ok', findings: [], coverage: 'all' },
    });
    assert.ok(rec.ledger_hash, 'record must carry a ledger hash');

    const rows = readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line));
    const kept = rows.filter((row) => row.hash !== rec.ledger_hash);
    assert.equal(kept.length, rows.length - 1, 'the anchored entry must be removable');
    writeFileSync(LEDGER_PATH, `${kept.map((row) => JSON.stringify(row)).join('\n')}\n`);

    const result = checkApproval({ thread, planPath: planC, repoPath: repoC });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /anchor/);

    // audit verify lists the approval whose anchor is now missing.
    const { cmdAuditVerify } = await import('../src/commands/audit.mjs');
    const report = cmdAuditVerify();
    assert.ok(Array.isArray(report.unanchoredApprovals));
    assert.ok(report.unanchoredApprovals.some((entry) => entry.thread === thread));
    console.log('PASS: (c) deleting the anchored ledger entry refuses the approval and audit lists it');
  }

  // --- FIX A (d): a legacy record with no ledger_hash is refused with re-record guidance ---
  {
    const thread = 'thread-legacy';
    const planD = join(scratch, 'plan-d.md');
    writeFileSync(planD, '# plan d\n');
    const repoD = join(scratch, 'repo-d');
    mkdirSync(repoD);
    writeFileSync(join(repoD, 'a.py'), 'print(1)\n');

    const rec = await recordApproval({
      thread, planPath: planD, repoPath: repoD, reviewer: 'codex', model: 'm1',
      verdict: { verdict: 'APPROVED', summary: 'ok', findings: [], coverage: 'all' },
    });
    const store = JSON.parse(readFileSync(APPROVALS_PATH, 'utf8'));
    const legacy = { ...rec };
    delete legacy.ledger_hash;
    store.approvals[thread] = legacy; // legacy shape: a bare record, not a reviewer map
    writeFileSync(APPROVALS_PATH, `${JSON.stringify(store, null, 2)}\n`);

    const result = checkApproval({ thread, planPath: planD, repoPath: repoD });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /re-record/);
    console.log('PASS: (d) a legacy unanchored record is refused with re-record guidance');
  }

  // --- FIX A (e): mutation proof — break the anchor check in a scratch copy ---
  {
    const srcRoot = fileURLToPath(new URL('../src', import.meta.url));
    const mutantSrc = join(scratch, 'mutant-src');
    cpSync(srcRoot, mutantSrc, { recursive: true });
    const anchorCall = 'const violation = anchorViolation(ledgerByHash, { thread, record });';
    const source = readFileSync(join(srcRoot, 'governance', 'approval.mjs'), 'utf8');
    assert.ok(source.includes(anchorCall), 'mutation target must exist in approval.mjs');
    writeFileSync(
      join(mutantSrc, 'governance', 'approval.mjs'),
      source.replace(anchorCall, 'const violation = null;'),
    );

    const worker = `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const approval = await import(process.env.MUTANT_APPROVAL_URL);
const { LEDGER_PATH } = await import(process.env.MUTANT_CONFIG_URL);
const root = process.env.MUTANT_WORK;
mkdirSync(root, { recursive: true });
const plan = join(root, 'plan.md');
writeFileSync(plan, '# plan\\n');
const repo = join(root, 'repo');
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, 'a.py'), 'print(1)\\n');
const rec = await approval.recordApproval({
  thread: 'mutant-thread', planPath: plan, repoPath: repo, reviewer: 'codex', model: 'm1',
  verdict: { verdict: 'APPROVED', summary: 'ok', findings: [], coverage: 'all' },
});
const rows = readFileSync(LEDGER_PATH, 'utf8').split('\\n').filter(Boolean).map(JSON.parse);
writeFileSync(LEDGER_PATH, rows.filter((row) => row.hash !== rec.ledger_hash).map(JSON.stringify).join('\\n') + '\\n');
const result = approval.checkApproval({ thread: 'mutant-thread', planPath: plan, repoPath: repo });
console.log(JSON.stringify({ allowed: result.allowed, reason: result.reason }));
`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', worker], {
      env: {
        ...process.env,
        HOME: join(scratch, 'mutant-home'),
        MUTANT_APPROVAL_URL: pathToFileURL(join(mutantSrc, 'governance', 'approval.mjs')).href,
        MUTANT_CONFIG_URL: pathToFileURL(join(mutantSrc, 'config.mjs')).href,
        MUTANT_WORK: join(scratch, 'mutant-work'),
      },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `mutant worker failed: ${run.stderr}`);
    const mutantResult = JSON.parse(run.stdout.trim().split('\n').at(-1));
    assert.equal(
      mutantResult.allowed,
      true,
      'with the anchor check bypassed scenario (c) must wrongly allow, proving (c) is load-bearing',
    );
    console.log('PASS: (e) mutation proof — bypassing anchorViolation makes scenario (c) wrongly pass');
  }

  // --- FIX A (f): a forged anchor line — same hash string and five checked fields, but a
  // stored hash that no longer recomputes — must be refused ---
  {
    const thread = 'thread-forge';
    const planF = join(scratch, 'plan-f.md');
    writeFileSync(planF, '# plan f\n');
    const repoF = join(scratch, 'repo-f');
    mkdirSync(repoF);
    writeFileSync(join(repoF, 'a.py'), 'print(1)\n');

    const rec = await recordApproval({
      thread, planPath: planF, repoPath: repoF, reviewer: 'codex', model: 'm1',
      verdict: { verdict: 'APPROVED', summary: 'ok', findings: [], coverage: 'all' },
    });

    const ledgerText = readFileSync(LEDGER_PATH, 'utf8');
    const rows = ledgerText.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const index = rows.findIndex((row) => row.hash === rec.ledger_hash);
    assert.ok(index >= 0, 'the anchored entry must be present');
    // Keep hash, thread, plan_hash, snapshot_fingerprint, backend and approval_verdict
    // exactly; change a field the chain hash still covers, so the stored hash no longer
    // recomputes while every field the anchor check compares still matches.
    rows[index] = { ...rows[index], outcome: 'forged' };
    writeFileSync(LEDGER_PATH, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    try {
      const result = checkApproval({ thread, planPath: planF, repoPath: repoF });
      assert.equal(result.allowed, false);
      assert.match(result.reason, /recompute|hash|altered/);
    } finally {
      writeFileSync(LEDGER_PATH, ledgerText); // restore the intact chain for later tests
    }
    console.log('PASS: (f) forged anchor line (matching hash string, bad recompute) is refused');
  }

  // --- FIX B (g): two concurrent recordApproval calls on one thread must both persist ---
  {
    const thread = 'thread-concurrent';
    const planG = join(scratch, 'plan-g.md');
    writeFileSync(planG, '# plan g\n');
    const repoG = join(scratch, 'repo-g');
    mkdirSync(repoG);
    writeFileSync(join(repoG, 'a.py'), 'print(1)\n');

    const [approved, revised] = await Promise.all([
      recordApproval({
        thread, planPath: planG, repoPath: repoG, reviewer: 'codex', model: 'm1',
        verdict: { verdict: 'APPROVED', summary: 'ok', findings: [], coverage: 'all' },
      }),
      recordApproval({
        thread, planPath: planG, repoPath: repoG, reviewer: 'claude-code', model: null,
        verdict: {
          verdict: 'REVISE', summary: 'fix it', coverage: 'all',
          findings: [{ id: 'g1', severity: 'low', description: 'nit' }],
        },
      }),
    ]);
    assert.ok(approved.ledger_hash && revised.ledger_hash, 'both records must be anchored');

    const store = JSON.parse(readFileSync(APPROVALS_PATH, 'utf8'));
    const records = Object.values(store.approvals[thread] ?? {}).flat();
    const verdicts = records.map((entry) => entry.verdict.verdict).sort();
    assert.deepEqual(verdicts, ['APPROVED', 'REVISE'], 'the REVISE must not be lost to the APPROVED write');
    const fingerprints = new Set(
      records.map((entry) => `${entry.plan_hash}\u0000${entry.snapshot_fingerprint}`),
    );
    assert.equal(fingerprints.size, 1, 'both records must be on the same fingerprint');
    console.log('PASS: (g) concurrent APPROVED + REVISE both persist on one fingerprint');
  }

  // --- FIX C (h): an unreadable ledger tail refuses approval recording ---
  {
    const thread = 'thread-tail-unreadable';
    const planH = join(scratch, 'plan-h.md');
    writeFileSync(planH, '# plan h\n');
    const repoH = join(scratch, 'repo-h');
    mkdirSync(repoH);
    writeFileSync(join(repoH, 'a.py'), 'print(1)\n');

    const savedLedger = readFileSync(LEDGER_PATH);
    rmSync(LEDGER_PATH, { force: true });
    mkdirSync(LEDGER_PATH); // a directory cannot be read as a ledger tail
    try {
      await assert.rejects(
        recordApproval({
          thread, planPath: planH, repoPath: repoH, reviewer: 'codex', model: 'm1',
          verdict: { verdict: 'APPROVED', summary: 'ok', findings: [], coverage: 'all' },
        }),
        /tail|unknown anchor|refus/i,
      );
      assert.equal(getApproval(thread), null, 'no unanchored approval may be written');
    } finally {
      rmSync(LEDGER_PATH, { recursive: true, force: true });
      writeFileSync(LEDGER_PATH, savedLedger);
    }
    console.log('PASS: (h) unreadable ledger tail refuses approval recording');
  }

  // --- FIX B (i): a record whose model differs from its anchored ledger entry is refused ---
  {
    const thread = 'thread-model-anchor';
    const planI = join(scratch, 'plan-i.md');
    writeFileSync(planI, '# plan i\n');
    const repoI = join(scratch, 'repo-i');
    mkdirSync(repoI);
    writeFileSync(join(repoI, 'a.py'), 'print(1)\n');

    await recordApproval({
      thread, planPath: planI, repoPath: repoI, reviewer: 'codex', model: 'm1',
      verdict: { verdict: 'APPROVED', summary: 'ok', findings: [], coverage: 'all' },
    });
    assert.equal(
      checkApproval({ thread, planPath: planI, repoPath: repoI }).allowed,
      true,
      'the untampered anchor must pass before the record is altered',
    );

    // Alter only the stored record's model; the ledger anchor still records m1.
    const store = JSON.parse(readFileSync(APPROVALS_PATH, 'utf8'));
    for (const records of Object.values(store.approvals[thread])) {
      for (const entry of records) entry.model = 'm2';
    }
    writeFileSync(APPROVALS_PATH, `${JSON.stringify(store, null, 2)}\n`);

    const result = checkApproval({ thread, planPath: planI, repoPath: repoI });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /model/);
    console.log('PASS: (i) a record whose model differs from its anchor is refused');
  }

  // --- FIX B (j): a record whose plan_path differs from its anchored entry is refused ---
  {
    const thread = 'thread-planpath-anchor';
    const planJ = join(scratch, 'plan-j.md');
    const planJAlt = join(scratch, 'plan-j-alt.md');
    const planBytes = '# plan j\nidentical bytes\n';
    writeFileSync(planJ, planBytes);
    writeFileSync(planJAlt, planBytes); // identical bytes, different path
    const repoJ = join(scratch, 'repo-j');
    mkdirSync(repoJ);
    writeFileSync(join(repoJ, 'a.py'), 'print(1)\n');

    await recordApproval({
      thread, planPath: planJ, repoPath: repoJ, reviewer: 'codex', model: 'm1',
      verdict: { verdict: 'APPROVED', summary: 'ok', findings: [], coverage: 'all' },
    });
    assert.equal(checkApproval({ thread, planPath: planJ, repoPath: repoJ }).allowed, true);

    // Move the stored record's plan_path; the plan bytes and repo are unchanged, so only
    // the anchor comparison can catch the mismatch.
    const store = JSON.parse(readFileSync(APPROVALS_PATH, 'utf8'));
    for (const records of Object.values(store.approvals[thread])) {
      for (const entry of records) entry.plan_path = planJAlt;
    }
    writeFileSync(APPROVALS_PATH, `${JSON.stringify(store, null, 2)}\n`);

    const result = checkApproval({ thread, planPath: planJAlt, repoPath: repoJ });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /plan path/);
    console.log('PASS: (j) a record whose plan_path differs from its anchor is refused');
  }

  // --- FIX C (k): a corrupt approvals.json denies with a reason and never throws ---
  {
    const savedApprovals = readFileSync(APPROVALS_PATH, 'utf8');
    let result;
    try {
      writeFileSync(APPROVALS_PATH, '{ this is not valid json\n');
      result = checkApproval({ thread: 'thread-a' });
    } catch (error) {
      assert.fail(`checkApproval must not throw on a corrupt approvals.json: ${error.message}`);
    } finally {
      writeFileSync(APPROVALS_PATH, savedApprovals);
    }
    assert.equal(result.allowed, false);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0, 'a denial from a corrupt store must carry a reason');
    console.log('PASS: (k) corrupt approvals.json denies with a reason and does not throw');
  }

  // --- T2: scoped fingerprint via --files ---
  {
    const thread = 'thread-scoped-files';
    const planT2 = join(scratch, 'plan-t2.md');
    writeFileSync(planT2, '# plan t2\n');
    const repoT2 = join(scratch, 'repo-t2');
    mkdirSync(join(repoT2, 'sub'), { recursive: true });
    writeFileSync(join(repoT2, 'a.py'), 'print(1)\n');
    writeFileSync(join(repoT2, 'sub', 'b.py'), 'print(2)\n');

    await recordApproval({
      thread, planPath: planT2, repoPath: repoT2, reviewer: 'codex', model: 'm1',
      files: ['a.py'],
      verdict: { verdict: 'APPROVED', summary: 'ok', findings: [], coverage: 'a.py' },
    });

    // A change outside the reviewed scope must not invalidate the approval.
    writeFileSync(join(repoT2, 'sub', 'b.py'), 'print(999)\n');
    assert.equal(
      checkApproval({ thread, planPath: planT2, repoPath: repoT2 }).allowed,
      true,
      'an unlisted change must keep the approval allowed',
    );

    // A change to a listed file must invalidate it.
    writeFileSync(join(repoT2, 'a.py'), 'print(1000)\n');
    const denied = checkApproval({ thread, planPath: planT2, repoPath: repoT2 });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /repository tree has changed/);
    console.log('PASS: T2 scoped fingerprint — unlisted change ignored, listed change denies');
  }

  // --- T2: a thread whose records disagree on --files scope denies ---
  {
    const thread = 'thread-mixed-scope';
    const planT2b = join(scratch, 'plan-t2b.md');
    writeFileSync(planT2b, '# plan t2b\n');
    const repoT2b = join(scratch, 'repo-t2b');
    mkdirSync(repoT2b);
    writeFileSync(join(repoT2b, 'a.py'), 'print(1)\n');
    writeFileSync(join(repoT2b, 'b.py'), 'print(2)\n');

    const approved = { verdict: 'APPROVED', summary: 'ok', findings: [], coverage: 'all' };
    await recordApproval({
      thread, planPath: planT2b, repoPath: repoT2b, reviewer: 'codex', model: 'm1',
      files: ['a.py'], verdict: approved,
    });
    await recordApproval({
      thread, planPath: planT2b, repoPath: repoT2b, reviewer: 'claude-code', model: null,
      files: ['b.py'], verdict: approved,
    });

    const result = checkApproval({ thread, planPath: planT2b, repoPath: repoT2b });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /scope/);
    console.log('PASS: T2 mixed-scope thread denies');
  }

  // --- FIX 1: --files . is the whole tree, not an empty scope ---
  {
    const thread = 'thread-files-dot';
    const planDot = join(scratch, 'plan-dot.md');
    writeFileSync(planDot, '# plan dot\n');
    const repoDot = join(scratch, 'repo-dot');
    mkdirSync(repoDot);
    writeFileSync(join(repoDot, 'a.py'), 'print(1)\n');
    writeFileSync(join(repoDot, 'b.py'), 'print(2)\n');

    await recordApproval({
      thread, planPath: planDot, repoPath: repoDot, reviewer: 'codex', model: 'm1',
      files: ['.'],
      verdict: { verdict: 'APPROVED', summary: 'ok', findings: [], coverage: 'all' },
    });
    const stored = getApproval(thread);
    assert.deepEqual(stored.files, [], "'.' must normalize to the whole-tree scope");
    assert.equal(stored.file_count, 2, "'.' must fingerprint the whole tree, not nothing");
    assert.equal(checkApproval({ thread, planPath: planDot, repoPath: repoDot }).allowed, true);

    // With the fix, '.' is the whole tree: a change to any repo file must deny.
    writeFileSync(join(repoDot, 'b.py'), 'print(999)\n');
    const denied = checkApproval({ thread, planPath: planDot, repoPath: repoDot });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /repository tree has changed/);
    console.log('PASS: FIX 1 --files . is the whole tree; a later change denies');
  }

  // --- FIX 1: a scoped walk matching zero files refuses the record with exit 2 ---
  {
    const { cmdLoopRecord } = await import('../src/commands/loop.mjs');
    const planZero = join(scratch, 'plan-zero.md');
    writeFileSync(planZero, '# plan zero\n');
    const repoZero = join(scratch, 'repo-zero');
    mkdirSync(repoZero);
    writeFileSync(join(repoZero, 'a.py'), 'print(1)\n');

    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    process.exitCode = 0;
    try {
      await cmdLoopRecord('thread-zero-scope', [
        '--plan', planZero, '--repo', repoZero, '--reviewer', 'codex',
        '--files', 'does-not-exist.py',
        '--verdict', 'APPROVED', '--summary', 'ok', '--coverage', 'all',
      ]);
    } finally {
      console.error = original;
    }
    assert.equal(process.exitCode, 2, 'an empty scoped walk must exit 2');
    assert.ok(errors.some((line) => /matched no files/.test(line)), errors.join('\n'));
    assert.equal(getApproval('thread-zero-scope'), null, 'nothing may be recorded');
    console.log('PASS: FIX 1 a --files scope matching zero files refuses with exit 2');
  }

  // --- T3: --verdict-file input and its exit codes ---
  {
    const { cmdLoopRecord } = await import('../src/commands/loop.mjs');
    const planT3 = join(scratch, 'plan-t3.md');
    writeFileSync(planT3, '# plan t3\n');
    const repoT3 = join(scratch, 'repo-t3');
    mkdirSync(repoT3);
    writeFileSync(join(repoT3, 'a.py'), 'print(1)\n');

    const captureErrors = async (fn) => {
      const errors = [];
      const original = console.error;
      console.error = (...args) => errors.push(args.join(' '));
      try { await fn(); } finally { console.error = original; }
      return errors;
    };

    // A valid verdict file records.
    const goodFile = join(scratch, 'verdict-good.json');
    writeFileSync(goodFile, `${JSON.stringify({
      verdict: 'APPROVED', summary: 'file ok', findings: [], coverage: 'all',
    })}\n`);
    process.exitCode = 0;
    await captureErrors(() => cmdLoopRecord('thread-verdict-file', [
      '--plan', planT3, '--repo', repoT3, '--reviewer', 'codex', '--verdict-file', goodFile,
    ]));
    assert.equal(process.exitCode ?? 0, 0, 'a valid verdict file must record with exit 0');
    assert.ok(getApproval('thread-verdict-file'), 'the file verdict must be recorded');
    assert.equal(getApproval('thread-verdict-file').verdict.verdict, 'APPROVED');

    // A parseable file that fails the schema exits 1 and records nothing.
    const badFile = join(scratch, 'verdict-bad.json');
    writeFileSync(badFile, `${JSON.stringify({
      verdict: 'APPROVED',
      summary: 'bad',
      coverage: 'all',
      findings: [{ id: 'f1', severity: 'high', description: 'x' }],
    })}\n`);
    process.exitCode = 0;
    const badErrors = await captureErrors(() => cmdLoopRecord('thread-verdict-bad', [
      '--plan', planT3, '--repo', repoT3, '--reviewer', 'codex', '--verdict-file', badFile,
    ]));
    assert.equal(process.exitCode, 1, 'an invalid verdict file must exit 1');
    assert.ok(badErrors.some((line) => /cannot contradict its own findings/.test(line)));
    assert.equal(getApproval('thread-verdict-bad'), null);

    // A missing file exits 2.
    process.exitCode = 0;
    await captureErrors(() => cmdLoopRecord('thread-verdict-missing', [
      '--plan', planT3, '--repo', repoT3, '--reviewer', 'codex',
      '--verdict-file', join(scratch, 'does-not-exist.json'),
    ]));
    assert.equal(process.exitCode, 2, 'a missing verdict file must exit 2');

    // --verdict-file combined with --verdict exits 2.
    process.exitCode = 0;
    await captureErrors(() => cmdLoopRecord('thread-verdict-conflict', [
      '--plan', planT3, '--repo', repoT3, '--reviewer', 'codex',
      '--verdict-file', goodFile, '--verdict', 'APPROVED',
    ]));
    assert.equal(process.exitCode, 2, '--verdict-file combined with --verdict must exit 2');
    console.log('PASS: T3 --verdict-file records; invalid=1, missing=2, conflict=2');
  }

  // --- T4: --quiet prints exactly one line for record and check ---
  {
    const { cmdLoopRecord, cmdLoopCheck } = await import('../src/commands/loop.mjs');
    const planT4 = join(scratch, 'plan-t4.md');
    writeFileSync(planT4, '# plan t4\n');
    const repoT4 = join(scratch, 'repo-t4');
    mkdirSync(repoT4);
    writeFileSync(join(repoT4, 'a.py'), 'print(1)\n');

    const captureLogs = async (fn) => {
      const logs = [];
      const original = console.log;
      console.log = (...args) => logs.push(args.join(' '));
      try { await fn(); } finally { console.log = original; }
      return logs;
    };

    process.exitCode = 0;
    const recordLines = await captureLogs(() => cmdLoopRecord('thread-quiet', [
      '--plan', planT4, '--repo', repoT4, '--reviewer', 'codex',
      '--verdict', 'APPROVED', '--summary', 'ok', '--coverage', 'all', '--quiet',
    ]));
    assert.deepEqual(recordLines, ['recorded APPROVED for thread-quiet']);

    process.exitCode = 0;
    const approveLines = await captureLogs(() => cmdLoopCheck('thread-quiet', ['--quiet']));
    assert.deepEqual(approveLines, ['approved']);
    assert.equal(process.exitCode, 0);

    // A denied check prints one `denied: <reason>` line and exits 1.
    process.exitCode = 0;
    const denyLines = await captureLogs(() => cmdLoopCheck('no-such-quiet-thread', ['--quiet']));
    assert.equal(denyLines.length, 1);
    assert.match(denyLines[0], /^denied: /);
    assert.equal(process.exitCode, 1);
    console.log('PASS: T4 --quiet prints one line for record and check');
  }

  // --- T4: cli-relay list shows loop-only threads and survives a corrupt store ---
  {
    const { cmdList } = await import('../src/commands/list.mjs');
    const captureLogs = async (fn) => {
      const logs = [];
      const original = console.log;
      console.log = (...args) => logs.push(args.join(' '));
      try { await fn(); } finally { console.log = original; }
      return logs;
    };

    const lines = await captureLogs(() => cmdList());
    assert.ok(lines.some((line) => /loop-only threads/.test(line)), 'loop-only section must print');
    assert.ok(
      lines.some((line) => line.includes('thread-quiet')),
      'a loop-only thread must appear in list output',
    );

    const saved = readFileSync(APPROVALS_PATH, 'utf8');
    try {
      writeFileSync(APPROVALS_PATH, 'this is not valid json\n');
      const corruptLines = await captureLogs(() => cmdList());
      assert.ok(corruptLines.length > 0, 'list must still produce output with a corrupt store');
    } finally {
      writeFileSync(APPROVALS_PATH, saved);
    }
    console.log('PASS: T4 list shows loop-only threads and tolerates a corrupt approvals store');
  }

  // --- T6: orphaned loop-review ledger entry reported after its approval is removed ---
  {
    const thread = 'thread-orphan';
    const planT6 = join(scratch, 'plan-t6.md');
    writeFileSync(planT6, '# plan t6\n');
    const repoT6 = join(scratch, 'repo-t6');
    mkdirSync(repoT6);
    writeFileSync(join(repoT6, 'a.py'), 'print(1)\n');

    const rec = await recordApproval({
      thread, planPath: planT6, repoPath: repoT6, reviewer: 'codex', model: 'm1',
      verdict: { verdict: 'APPROVED', summary: 'ok', findings: [], coverage: 'all' },
    });
    // Simulate a failed approvals save: drop the record, keep its ledger line.
    const store = JSON.parse(readFileSync(APPROVALS_PATH, 'utf8'));
    delete store.approvals[thread];
    writeFileSync(APPROVALS_PATH, `${JSON.stringify(store, null, 2)}\n`);

    const { cmdAuditVerify } = await import('../src/commands/audit.mjs');
    const original = console.log;
    let report;
    console.log = () => {};
    try { report = cmdAuditVerify(); } finally { console.log = original; }

    assert.ok(Array.isArray(report.orphanedApprovalEntries));
    const orphan = report.orphanedApprovalEntries.find((entry) => entry.hash === rec.ledger_hash);
    assert.ok(orphan, 'the orphaned loop-review ledger line must be reported');
    assert.equal(orphan.thread, thread);
    assert.equal(orphan.approval_verdict, 'APPROVED');
    console.log('PASS: T6 orphaned loop-review ledger entry reported after approval removal');
  }

  process.exitCode = 0;
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(scratch, { recursive: true, force: true });
}
