import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'cli-relay-ledger-locks-'));
const ledgerUrl = pathToFileURL(join(root, 'src/governance/ledger.mjs')).href;
const lockUrl = pathToFileURL(join(root, 'src/core/lock.mjs')).href;
const children = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stop at the actual append syscall boundary, after the predecessor was captured.
// Built-in export synchronization makes the real ledger module use this barrier.
const workerCode = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
if (process.env.PAUSE === '1') {
  const append = fs.appendFileSync;
  fs.appendFileSync = (...args) => {
    fs.writeSync(1, 'PAUSED\\n');
    process.kill(process.pid, 'SIGSTOP');
    return append(...args);
  };
}
if (process.env.WATCH === '1') {
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = (...args) => {
    try { return mkdir(...args); }
    catch (error) {
      if (error.code === 'EEXIST' && String(args[0]).endsWith('.lock')) {
        fs.writeSync(1, 'BLOCKED\\n');
      }
      throw error;
    }
  };
}
syncBuiltinESMExports();
const { appendLedgerEntry, verifyLedger } = await import(process.env.LEDGER_URL);
if (process.env.ACTION === 'verify') {
  console.log(JSON.stringify(verifyLedger()));
} else if (process.env.ACTION === 'parallel') {
  await Promise.all(Array.from({ length: 24 }, (_, index) =>
    appendLedgerEntry({ thread: 'parallel-' + index })));
  const { withLock } = await import(process.env.LOCK_URL);
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 4 }, () => withLock(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
  }, { lockPath: process.env.SCOPED_LOCK, reclaimLive: false })));
  if (maximum !== 1) throw new Error('same-process scoped lock did not serialize');
} else {
  await appendLedgerEntry({
    backend: 'fake', thread: process.env.THREAD, mode: 'fresh', outcome: 'confirmed',
  });
  console.log('DONE');
}
`;

function makeHome(path, ledgerPath, expires = false) {
  mkdirSync(join(path, '.cli-relay'), { recursive: true });
  writeFileSync(join(path, '.cli-relay/config.json'), JSON.stringify({
    MAP_PATH: join(path, 'private-sessions.json'),
    LEDGER_PATH: ledgerPath,
    LOCK_TIMEOUT_MS: 4000,
    LOCK_RETRY_MS: 10,
    SPAWN_TIMEOUT_MS: expires ? 20 : 60_000,
    LOCK_STALE_GRACE_MS: expires ? 20 : 60_000,
  }));
  return path;
}

function start(home, thread, extra = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerCode], {
    env: {
      ...process.env, HOME: home, LEDGER_URL: ledgerUrl, LOCK_URL: lockUrl,
      THREAD: thread, ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, stdout: '', stderr: '', closed: false };
  children.add(state);
  child.stdout.on('data', (data) => { state.stdout += data; });
  child.stderr.on('data', (data) => { state.stderr += data; });
  child.on('error', (error) => { state.stderr += error.message; });
  const timer = setTimeout(() => {
    state.stderr += '\nworker exceeded 8-second deadline';
    child.kill('SIGCONT');
    child.kill('SIGKILL');
  }, 8000);
  state.done = new Promise((resolve) => child.on('close', (code, signal) => {
    clearTimeout(timer);
    state.closed = true;
    state.code = code;
    state.signal = signal;
    resolve(state);
  }));
  return state;
}

async function waitFor(state, marker) {
  const deadline = Date.now() + 3000;
  while (!state.stdout.includes(marker)) {
    assert(!state.closed, `worker exited before ${marker}: ${state.stderr}`);
    assert(Date.now() < deadline, `timed out waiting for ${marker}: ${state.stderr}`);
    await delay(10);
  }
}

async function success(state) {
  await state.done;
  assert.equal(state.code, 0, `worker failed (${state.signal}): ${state.stderr}`);
  assert.equal(state.stderr, '', `unexpected ledger warning: ${state.stderr}`);
  return state;
}

function rows(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8').trim();
  return text ? text.split('\n').map(JSON.parse) : [];
}

async function verify(home, count) {
  const state = await success(start(home, '', { ACTION: 'verify' }));
  const report = JSON.parse(state.stdout);
  assert.equal(report.intact, true, JSON.stringify(report));
  assert.equal(report.totalEntries, count);
}

async function pausedWriters(label, { sameHome = false, alias = false, seed = true } = {}) {
  const base = join(scratch, label);
  mkdirSync(base);
  const ledger = join(base, 'ledger.jsonl');
  const aliasPath = join(base, 'alias.jsonl');
  if (alias) symlinkSync('ledger.jsonl', aliasPath);
  const homeA = makeHome(join(base, 'a'), alias ? aliasPath : ledger, sameHome);
  const homeB = sameHome ? homeA : makeHome(join(base, 'b'), ledger);
  if (seed) await success(start(homeB, 'seed'));
  if (alias && !seed) assert(!existsSync(aliasPath), 'alias must initially be dangling');

  const a = start(homeA, 'a', { PAUSE: '1' });
  await waitFor(a, 'PAUSED');
  // For the stale-holder case this exceeds the configured 40-ms age window while
  // the real PID remains alive but stopped. B must still wait for its ownership.
  if (sameHome) await delay(100);
  const b = start(homeB, 'b', { WATCH: '1' });
  await waitFor(b, 'BLOCKED');
  await delay(100);
  assert(!b.closed && !b.stdout.includes('DONE'), 'B must wait for the stopped live writer');
  assert.deepEqual(rows(ledger).map((row) => row.thread), seed ? ['seed'] : []);
  a.child.kill('SIGCONT');
  await Promise.all([success(a), success(b)]);
  const expected = seed ? ['seed', 'a', 'b'] : ['a', 'b'];
  assert.deepEqual(rows(ledger).map((row) => row.thread), expected);
  await verify(homeA, expected.length);
  console.log(`PASS: ${label}`);
}

try {
  await pausedWriters('shared-ledger-different-map-locks');
  await pausedWriters('existing-symlink-ledger-alias', { alias: true });
  await pausedWriters('dangling-symlink-ledger-alias', { alias: true, seed: false });
  await pausedWriters('stopped-live-writer-past-stale-window', { sameHome: true });

  // realpath cannot unify hard links. Both aliases must warn and skip auditing
  // rather than append under independent pathname locks and silently fork.
  const hardlinkLedger = join(scratch, 'hardlink.jsonl');
  const hardlinkAlias = join(scratch, 'hardlink-alias.jsonl');
  const hardlinkHomeA = makeHome(join(scratch, 'hardlink-a'), hardlinkLedger);
  const hardlinkHomeB = makeHome(join(scratch, 'hardlink-b'), hardlinkAlias);
  await success(start(hardlinkHomeA, 'seed'));
  linkSync(hardlinkLedger, hardlinkAlias);
  const beforeHardlinkAppends = readFileSync(hardlinkLedger);
  const hardlinkWriters = [start(hardlinkHomeA, 'a'), start(hardlinkHomeB, 'b')];
  await Promise.all(hardlinkWriters.map((state) => state.done));
  for (const state of hardlinkWriters) {
    assert.equal(state.code, 0, `unsupported hard link must remain advisory: ${state.stderr}`);
    assert.match(state.stdout, /DONE/, 'caller must continue after skipped audit append');
    assert.match(state.stderr, /warning: governance ledger append failed: hard-linked ledger files are unsupported/);
  }
  assert.deepEqual(readFileSync(hardlinkLedger), beforeHardlinkAppends);
  assert.deepEqual(readFileSync(hardlinkAlias), beforeHardlinkAppends);
  await verify(hardlinkHomeA, 1);
  await verify(hardlinkHomeB, 1);
  console.log('PASS: hard-link aliases warn without throwing or modifying ledger');

  const home = makeHome(join(scratch, 'parallel'), join(scratch, 'parallel.jsonl'), true);
  await success(start(home, '', { ACTION: 'parallel', SCOPED_LOCK: join(home, 'resource.lock') }));
  await verify(home, 24);
  assert.equal(new Set(rows(join(scratch, 'parallel.jsonl')).map((row) => row.thread)).size, 24);
  console.log('PASS: same-process append and async resource-lock serialization');
} finally {
  for (const state of children) {
    if (!state.closed) {
      state.child.kill('SIGCONT');
      state.child.kill('SIGKILL');
    }
  }
  await Promise.all([...children].map((state) => state.done));
  rmSync(scratch, { recursive: true, force: true });
}
