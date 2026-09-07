// Standalone, hermetic reproductions of the ledger field/delimiter audit findings.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync,
  writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'cli-relay-ledger-data-'));
const originalHome = process.env.HOME;
process.env.HOME = join(scratch, 'data-home');
const ledgerUrl = new URL('../src/governance/ledger.mjs', import.meta.url).href;

try {
  const {
    appendLedgerEntry, computeLedgerHash, verifyLedger, MAX_LEDGER_TAIL_BYTES,
  } = await import(ledgerUrl);
  const { LEDGER_PATH } = await import('../src/config.mjs');
  const entries = () => readFileSync(LEDGER_PATH, 'utf8').trim().split('\n').map(JSON.parse);
  const save = (records) => writeFileSync(LEDGER_PATH, records.map(JSON.stringify).join('\n') + '\n');

  // JSON.parse creates an own __proto__ property. Copying through ordinary object
  // assignment used to lose it in BOTH normalization and hash computation.
  for (const value of [{ marker: 'before' }, 'before', null]) {
    const input = JSON.parse(`{"thread":"proto","__proto__":${JSON.stringify(value)}}`);
    const changed = JSON.parse('{"thread":"proto","__proto__":{"marker":"changed"}}');
    assert.notEqual(computeLedgerHash(input), computeLedgerHash(changed));
    await appendLedgerEntry(input);
    assert.ok(Object.hasOwn(entries().at(-1), '__proto__'));
    assert.deepEqual(entries().at(-1).__proto__, value);
  }
  assert.equal(verifyLedger().intact, true);
  const records = entries();
  records[0].__proto__.marker = 'tampered';
  save(records);
  assert.equal(verifyLedger().breakIndex, 0);
  assert.match(verifyLedger().reason, /hash mismatch/);
  await appendLedgerEntry({ thread: 'after-tampering' });
  assert.equal(entries().length, 4);
  assert.equal(verifyLedger().breakIndex, 0);
  console.log('PASS: __proto__ fields persist, affect hashes, and tampering stays diagnosable');

  // Checkpoints still anchor an explicitly retained suffix, never hide damage
  // earlier in a file, and ordinary malformed tails do not block subsequent writes.
  await appendLedgerEntry({ type: 'checkpoint', reason: 'explicit reset' });
  assert.equal(verifyLedger().breakIndex, 0);
  const checkpoint = entries().at(-1);
  save([checkpoint]);
  await appendLedgerEntry({ thread: 'after-checkpoint' });
  assert.equal(verifyLedger().intact, true);
  writeFileSync(LEDGER_PATH, '{truncated');
  await appendLedgerEntry({ thread: 'after-malformed-tail' });
  assert.equal(readFileSync(LEDGER_PATH, 'utf8').split('\n').length, 3);
  assert.equal(verifyLedger().lineNumber, 1);
  console.log('PASS: checkpoints and malformed-tail recovery retain read-only verification semantics');

  // A writer must not create a valid record that its bounded reader cannot later
  // recover. Check the exact byte boundary and one subsequent linked append.
  writeFileSync(LEDGER_PATH, '');
  const sized = { thread: 'sized', timestamp: '2026-09-07T00:00:00.000Z', padding: '' };
  await appendLedgerEntry(sized);
  const overhead = Buffer.byteLength(JSON.stringify(entries()[0]));
  writeFileSync(LEDGER_PATH, '');
  await appendLedgerEntry({ ...sized, padding: 'x'.repeat(MAX_LEDGER_TAIL_BYTES - 2 - overhead) });
  assert.equal(statSync(LEDGER_PATH).size, MAX_LEDGER_TAIL_BYTES - 1);
  await appendLedgerEntry({ thread: 'after-largest-record' });
  assert.equal(verifyLedger().intact, true);
  const priorSize = statSync(LEDGER_PATH).size;
  await appendLedgerEntry({ padding: 'x'.repeat(MAX_LEDGER_TAIL_BYTES) });
  assert.equal(statSync(LEDGER_PATH).size, priorSize, 'oversized record must warn without writing');
  console.log('PASS: largest supported record chains correctly; oversized writes remain advisory');

  // Same-size files differing only in newline bytes. Repeated valid checkpoints
  // keep the control a valid ledger without allocating a large history in memory.
  const checkpointRecord = { type: 'checkpoint', previous_hash: 'GENESIS', pad: 'x'.repeat(950) };
  checkpointRecord.hash = computeLedgerHash(checkpointRecord);
  const line = Buffer.from(JSON.stringify(checkpointRecord) + '\n');
  for (const kind of ['healthy', 'missing-delimiters', 'trailing-whitespace']) {
    const home = join(scratch, kind);
    const state = join(home, '.cli-relay');
    const path = join(state, 'ledger.jsonl');
    mkdirSync(state, { recursive: true });
    const block = Buffer.from(line);
    if (kind === 'missing-delimiters') block[block.length - 1] = 0x20;
    if (kind === 'trailing-whitespace') block.fill(0x20);
    const fd = openSync(path, 'w');
    try {
      for (let index = 0; index < 65536; index += 1) writeSync(fd, block);
    } finally {
      closeSync(fd);
    }
    const size = statSync(path).size;
    const result = spawnSync(process.execPath, ['--max-old-space-size=16', '--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      let bytes = 0;
      const tracked = new Set();
      const open = fs.openSync, read = fs.readSync, close = fs.closeSync;
      fs.openSync = (path, ...args) => {
        const fd = open(path, ...args);
        if (String(path) === process.env.TEST_LEDGER) tracked.add(fd);
        return fd;
      };
      fs.readSync = (fd, ...args) => {
        const count = read(fd, ...args);
        if (tracked.has(fd)) bytes += count;
        return count;
      };
      fs.closeSync = (fd) => { tracked.delete(fd); return close(fd); };
      syncBuiltinESMExports();
      const { appendLedgerEntry } = await import(${JSON.stringify(ledgerUrl)});
      await appendLedgerEntry({thread:'after-large-tail', metadata:Array.from({length:100000},(_,i)=>i)});
      console.log(JSON.stringify({bytes}));
    `], {
      env: { ...process.env, HOME: home, TEST_LEDGER: path },
      encoding: 'utf8', timeout: 20000, maxBuffer: 32768,
    });
    assert.equal(result.status, 0, `${kind}: ${result.signal}\n${result.stderr}`);
    assert.ok(JSON.parse(result.stdout).bytes <= MAX_LEDGER_TAIL_BYTES);
    assert.ok(statSync(path).size > size, `${kind}: append must succeed`);
    if (kind !== 'healthy') assert.match(result.stderr, /recovery window.*discontinuity/);
    else assert.equal(result.stderr, '');
    // Verification is intentionally a separate unconstrained-heap read operation.
    const verified = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const {verifyLedger} = await import(${JSON.stringify(ledgerUrl)});
      console.log(JSON.stringify(verifyLedger()));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20000 });
    assert.equal(verified.status, 0, verified.stderr);
    const report = JSON.parse(verified.stdout);
    assert.equal(report.intact, kind === 'healthy');
    if (kind !== 'healthy') assert.equal(report.breakIndex, 0);
    console.log(`PASS: ${kind}: ${size} bytes, bounded append under 16 MiB heap, verify reachable`);
  }
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(scratch, { recursive: true, force: true });
}
