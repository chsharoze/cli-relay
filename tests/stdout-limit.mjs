// Hermetic tests for the stdout buffer limit: default, --max-stdout-mb, CLI_RELAY_MAX_STDOUT_MB,
// config maxStdoutMb (top level and backends.<name>), precedence, and invalid values.
// The only backend is a fake agy script in a temporary directory; nothing real is invoked,
// and each run gets its own temporary HOME. No test generates anywhere near the 64 MiB default.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = join(ROOT, 'cli-relay.mjs');
const MIB = 1024 * 1024;
const scratch = mkdtempSync(join(tmpdir(), 'cli-relay-stdout-limit-'));
let counter = 0;
let passed = 0;

function freshDir(label) {
  counter += 1;
  const dir = join(scratch, `${label}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A fake agy that prints one JSON line of exactly the number of bytes in size.txt.
const bin = freshDir('bin');
writeFileSync(join(bin, 'agy'), `#!${process.execPath}
const { readFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const total = Number(readFileSync(join(dirname(process.argv[1]), 'size.txt'), 'utf8'));
const head = '{"conversation_id":"c1","response":"';
const tail = '"}\\n';
process.stdout.write(head + 'x'.repeat(total - head.length - tail.length) + tail);
`);
chmodSync(join(bin, 'agy'), 0o755);

function run(args, { config, env = {}, size = 1000 } = {}) {
  const home = freshDir('home');
  mkdirSync(join(home, '.cli-relay'), { recursive: true });
  if (config !== undefined) {
    writeFileSync(join(home, '.cli-relay', 'config.json'), JSON.stringify(config));
  }
  writeFileSync(join(bin, 'size.txt'), String(size));
  const result = spawnSync(process.execPath, [ROUTE, ...args], {
    cwd: '/',
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env },
    timeout: 60_000,
    maxBuffer: 16 * MIB,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const call = (extra = [], options) => run([...extra, 'agy', 't', 'fresh', 'go'], options);
const over = 2 * MIB; // larger than every 1 MiB limit below, smaller than every 4 MiB one

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function assertRefused(result, mb) {
  assert.equal(result.code, 1, result.err);
  assert.match(result.err, new RegExp(`stdout exceeded the ${mb} MiB limit`));
  assert.match(result.err, /--max-stdout-mb/);
  assert.match(result.err, /CLI_RELAY_MAX_STDOUT_MB/);
  assert.match(result.err, /maxStdoutMb/);
  assert.match(result.err, /refusing to parse truncated output/);
}

function assertParsed(result) {
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).native_session_id, 'c1');
}

try {
  const limit = await import('../src/core/stdout-limit.mjs');

  await test('the default limit is 64 MiB and the bounds are 1..1024', () => {
    assert.equal(limit.DEFAULT_MAX_STDOUT_MB, 64);
    assert.equal(limit.MIN_MAX_STDOUT_MB, 1);
    assert.equal(limit.MAX_MAX_STDOUT_MB, 1024);
    assert.equal(limit.MAX_STDOUT_ENV, 'CLI_RELAY_MAX_STDOUT_MB');
  });

  await test('help shows the effective limit and the flag', () => {
    const plain = run(['help']);
    assert.equal(plain.code, 0, plain.err);
    assert.match(plain.out, /--max-stdout-mb <n>/);
    assert.match(plain.out, /agy\s+64 MiB \(built-in\)/);
    const env = run(['help'], { env: { CLI_RELAY_MAX_STDOUT_MB: '9' } });
    assert.match(env.out, /agy\s+9 MiB \(env\)/);
    const cfg = run(['help'], { config: { maxStdoutMb: 7, backends: { codex: { maxStdoutMb: 3 } } } });
    assert.match(cfg.out, /agy\s+7 MiB \(config\)/);
    assert.match(cfg.out, /codex\s+3 MiB \(config\)/);
    const bad = run(['help'], { env: { CLI_RELAY_MAX_STDOUT_MB: 'x' } });
    assert.equal(bad.code, 0);
    assert.match(bad.out, /invalid \(CLI_RELAY_MAX_STDOUT_MB must be/);
  });

  await test('the default limit parses ordinary output', () => {
    assertParsed(call([], { size: over }));
  });

  await test('--max-stdout-mb enforces its limit (both spellings)', () => {
    assertRefused(call(['--max-stdout-mb', '1'], { size: over }), 1);
    assertRefused(call(['--max-stdout-mb=1'], { size: over }), 1);
  });

  await test('output just under the limit parses; one byte over is refused', () => {
    assertParsed(call(['--max-stdout-mb', '1'], { size: MIB }));
    assertRefused(call(['--max-stdout-mb', '1'], { size: MIB + 1 }), 1);
  });

  await test('the environment variable enforces its limit', () => {
    assertRefused(call([], { env: { CLI_RELAY_MAX_STDOUT_MB: '1' }, size: over }), 1);
    assertParsed(call([], { env: { CLI_RELAY_MAX_STDOUT_MB: '1' }, size: MIB }));
  });

  await test('config maxStdoutMb (top level and per backend) enforces its limit', () => {
    assertRefused(call([], { config: { maxStdoutMb: 1 }, size: over }), 1);
    assertRefused(call([], { config: { backends: { agy: { maxStdoutMb: 1 } } }, size: over }), 1);
    assertParsed(call([], { config: { maxStdoutMb: '1' }, size: MIB }));
  });

  await test('precedence: flag > env > backend config > top-level config > default', () => {
    // flag 4 beats env 1: a 2 MiB answer parses
    assertParsed(call(['--max-stdout-mb', '4'], { env: { CLI_RELAY_MAX_STDOUT_MB: '1' }, size: over }));
    // flag 1 beats env 4: refused
    assertRefused(call(['--max-stdout-mb', '1'], { env: { CLI_RELAY_MAX_STDOUT_MB: '4' }, size: over }), 1);
    // env 1 beats config 4: refused; env 4 beats config 1: parses
    assertRefused(call([], { env: { CLI_RELAY_MAX_STDOUT_MB: '1' }, config: { maxStdoutMb: 4 }, size: over }), 1);
    assertParsed(call([], { env: { CLI_RELAY_MAX_STDOUT_MB: '4' }, config: { maxStdoutMb: 1 }, size: over }));
    // backend config beats top-level config in both directions
    assertRefused(call([], { config: { maxStdoutMb: 4, backends: { agy: { maxStdoutMb: 1 } } }, size: over }), 1);
    assertParsed(call([], { config: { maxStdoutMb: 1, backends: { agy: { maxStdoutMb: 4 } } }, size: over }));
    // another backend's entry does not apply
    assertParsed(call([], { config: { backends: { codex: { maxStdoutMb: 1 } } }, size: over }));
    // a valid flag is not blocked by an invalid lower source it never reads
    assertParsed(call(['--max-stdout-mb', '4'], { env: { CLI_RELAY_MAX_STDOUT_MB: 'junk' }, size: over }));
  });

  await test('invalid flag values are usage errors (exit 2), also on a dry run', () => {
    for (const value of ['0', '1025', '-1', 'abc', '1.5', '1e2', '08x']) {
      const result = call([`--max-stdout-mb=${value}`]);
      assert.equal(result.code, 2, `${value}: ${result.err}`);
      assert.match(result.err, /--max-stdout-mb must be a whole number of MiB from 1 to 1024/);
      assert.equal(call(['--dry-run', `--max-stdout-mb=${value}`]).code, 2);
    }
    for (const args of [['--max-stdout-mb='], ['--max-stdout-mb', '--dry-run']]) {
      const result = call(args);
      assert.equal(result.code, 2, result.err);
      assert.match(result.err, /--max-stdout-mb requires a whole number of MiB/);
    }
    // A bare flag swallows the next token (the backend name), like --model and --effort.
    assert.equal(call(['--max-stdout-mb']).code, 2);
    const twice = call(['--max-stdout-mb', '2', '--max-stdout-mb', '3']);
    assert.equal(twice.code, 2);
    assert.match(twice.err, /may be provided only once/);
    assertParsed(call(['--max-stdout-mb', '1024']));
    assertParsed(call(['--max-stdout-mb', '1']));
  });

  await test('invalid environment values are usage errors (exit 2)', () => {
    for (const value of ['0', '1025', 'abc', '', '2.5']) {
      const result = call([], { env: { CLI_RELAY_MAX_STDOUT_MB: value } });
      assert.equal(result.code, 2, `"${value}": ${result.err}`);
      assert.match(result.err, /CLI_RELAY_MAX_STDOUT_MB must be a whole number of MiB from 1 to 1024/);
    }
  });

  await test('invalid config values are usage errors (exit 2) for dispatch only', () => {
    for (const value of [0, 1025, 'abc', 1.5, null, true, -3]) {
      const top = call([], { config: { maxStdoutMb: value } });
      assert.equal(top.code, 2, `${JSON.stringify(value)}: ${top.err}`);
      assert.match(top.err, /maxStdoutMb must be a whole number of MiB from 1 to 1024/);
      const perBackend = call([], { config: { backends: { agy: { maxStdoutMb: value } } } });
      assert.equal(perBackend.code, 2, `${JSON.stringify(value)}: ${perBackend.err}`);
      assert.match(perBackend.err, /backends\.agy\.maxStdoutMb must be a whole number/);
    }
    // Other commands are not taken down by a bad value.
    const list = run(['list'], { config: { maxStdoutMb: 'abc' } });
    assert.equal(list.code, 0, list.err);
  });

  console.log(`\n${passed} passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
