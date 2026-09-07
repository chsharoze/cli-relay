// Hermetic unit tests. Windows termination is mocked; the smoke suite separately
// exercises real POSIX backend/process-group cleanup on the host platform.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import vm from 'node:vm';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalKill = process.kill;
const originalExecFile = childProcess.execFile;
const originalError = console.error;
let killCalls = [];
let execCalls = [];
let warnings = [];

function reset(platform) {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
  killCalls = [];
  execCalls = [];
  warnings = [];
  process.kill = (...args) => { killCalls.push(args); return true; };
  childProcess.execFile = (...args) => {
    execCalls.push(args);
    args.at(-1)(null, '', '');
    return new EventEmitter();
  };
  console.error = (...args) => warnings.push(args.join(' '));
  syncBuiltinESMExports();
}

function assertTaskkill(pid) {
  assert.equal(execCalls.length, 1, 'one taskkill process per termination');
  assert.deepEqual(execCalls[0].slice(0, 3), [
    'taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, shell: false },
  ]);
  assert.equal(typeof execCalls[0][3], 'function');
  assert.deepEqual(killCalls, [], 'Windows must never signal a negative PID');
}

try {
  const { killProcessTree, isProcessGroupAlive } = await import('../src/core/process-tree.mjs');

  for (const platform of ['darwin', 'linux']) {
    reset(platform);
    assert.equal(killProcessTree(4321, 'SIGTERM'), undefined);
    assert.equal(isProcessGroupAlive(4321), true);
    assert.equal(killProcessTree(4321, 'SIGKILL'), undefined);
    assert.deepEqual(killCalls, [[-4321, 'SIGTERM'], [-4321, 0], [-4321, 'SIGKILL']]);
    assert.deepEqual(execCalls, []);
    assert.deepEqual(warnings, []);

    process.kill = () => { throw Object.assign(new Error('already exited'), { code: 'ESRCH' }); };
    assert.doesNotThrow(() => killProcessTree(4321, 'SIGTERM'));
    assert.equal(isProcessGroupAlive(4321), false);
    assert.deepEqual(warnings, [], 'a missing POSIX process group is benign');

    process.kill = () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); };
    assert.doesNotThrow(() => killProcessTree(4321, 'SIGKILL'));
    assert.match(warnings.join('\n'), /warning.*permission denied/i);
    warnings = [];
    isProcessGroupAlive(4321);
    assert.match(warnings.join('\n'), /warning.*permission denied/i);
    console.log(`PASS: ${platform} preserves exact group signals and surfaces non-ESRCH failures`);
  }

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    reset('win32');
    await killProcessTree(4321, signal);
    assertTaskkill(4321);
    assert.equal(isProcessGroupAlive(4321), false);
    assert.deepEqual(killCalls, []);
    assert.deepEqual(warnings, []);
  }
  console.log('PASS: Windows uses exact shell-free taskkill /T /F /PID argv for either signal');

  for (const failure of [
    Object.assign(new Error('taskkill executable missing'), { code: 'ENOENT' }),
    Object.assign(new Error('taskkill exited with code 1'), { code: 1 }),
  ]) {
    reset('win32');
    childProcess.execFile = (...args) => {
      execCalls.push(args);
      queueMicrotask(() => args.at(-1)(failure, '', 'Access is denied.'));
      return new EventEmitter();
    };
    syncBuiltinESMExports();
    await assert.doesNotReject(() => killProcessTree(4321, 'SIGTERM'));
    assertTaskkill(4321);
    assert.ok(warnings.some((warning) => /warning/i.test(warning) && warning.includes(failure.message)));
  }
  reset('win32');
  childProcess.execFile = () => { throw new Error('taskkill spawn threw synchronously'); };
  syncBuiltinESMExports();
  await assert.doesNotReject(() => killProcessTree(4321, 'SIGTERM'));
  assert.match(warnings.join('\n'), /warning.*taskkill spawn threw synchronously/i);
  console.log('PASS: Windows spawn errors, nonzero exits, and synchronous throws all warn and settle');

  for (const platform of ['darwin', 'linux', 'win32']) {
    reset(platform);
    await killProcessTree(undefined, 'SIGTERM');
    await killProcessTree(null, 'SIGKILL');
    assert.equal(isProcessGroupAlive(undefined), false);
    assert.deepEqual(killCalls, []);
    assert.deepEqual(execCalls, []);
  }
  console.log('PASS: an unspawned child never triggers a process-tree kill');

  // Evaluate the real lifecycle functions, not a duplicate implementation. Fake
  // children and timers keep Windows branch checks runnable without Windows or a
  // real taskkill command, and expose races between child close and kill completion.
  const source = readFileSync(new URL('../cli-relay.mjs', import.meta.url), 'utf8');
  const lifecycleStart = source.indexOf('let activeChildPgid =');
  const lifecycleEnd = source.indexOf('\nasync function runHousekeeping');
  const signalStart = source.indexOf('function onSignal(signal)');
  const signalEnd = source.indexOf("\nprocess.on('SIGINT'");
  assert.ok(lifecycleStart >= 0 && lifecycleEnd > lifecycleStart);
  assert.ok(signalStart >= 0 && signalEnd > signalStart);
  const lifecycleSource = source.slice(lifecycleStart, lifecycleEnd) + '\n' +
    source.slice(signalStart, signalEnd);

  function fixture(platform, pid = 4321) {
    reset(platform);
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const timers = [];
    const exits = [];
    const spawns = [];
    const context = vm.createContext({
      StringDecoder,
      console,
      process: { platform, exit: (code) => exits.push(code) },
      killProcessTree,
      isProcessGroupAlive,
      SPAWN_TIMEOUT_MS: 100,
      SPAWN_KILL_GRACE_MS: 10,
      spawn: (...args) => { spawns.push(args); return child; },
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, active: true };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { if (timer) timer.active = false; },
    });
    vm.runInContext(lifecycleSource, context, { filename: 'cli-relay-lifecycle-unit.mjs' });
    const promise = vm.runInContext("runChild(['fake-backend', 'prompt'], {})", context);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0][2].detached, true);
    return {
      child, timers, exits, promise, context,
      signal: (signal) => vm.runInContext(`onSignal(${JSON.stringify(signal)})`, context),
      fire: (delay) => {
        const timer = timers.find((candidate) => candidate.delay === delay && candidate.active);
        assert.ok(timer, `missing active ${delay}ms timer`);
        timer.active = false;
        timer.callback();
      },
    };
  }

  for (const trigger of ['timeout', 'SIGINT', 'SIGTERM']) {
    const test = fixture('win32');
    let callback;
    childProcess.execFile = (...args) => {
      execCalls.push(args);
      callback = args.at(-1);
      return new EventEmitter();
    };
    syncBuiltinESMExports();
    let settled = false;
    test.promise.then(() => { settled = true; });
    if (trigger === 'timeout') test.fire(100);
    else test.signal(trigger);
    test.signal('SIGINT');
    test.signal('SIGINT');
    assertTaskkill(4321);
    assert.equal(test.timers.length, 1, 'Windows must not schedule a POSIX grace/escalation timer');
    assert.deepEqual(test.exits, [], 'repeated interrupts must wait for taskkill');
    test.child.emit('close', null, 'SIGTERM');
    await Promise.resolve();
    assert.equal(settled, false, 'child close must not finish before taskkill callback');
    assert.deepEqual(test.exits, []);
    callback(null, '', '');
    const result = await test.promise;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, trigger === 'timeout');
    assert.ok(test.exits.length > 0);
    assert.ok(test.exits.every((code) => code === (trigger === 'SIGTERM' ? 143 : 130)));
    assertTaskkill(4321);
    console.log(`PASS: mocked Windows ${trigger}, repeated interrupts, and close-before-taskkill race`);
  }

  {
    const test = fixture('win32');
    let callback;
    childProcess.execFile = (...args) => {
      execCalls.push(args);
      callback = args.at(-1);
      return new EventEmitter();
    };
    syncBuiltinESMExports();
    let settled = false;
    test.promise.then(() => { settled = true; });
    test.fire(100);
    callback(Object.assign(new Error('taskkill refused the target'), { code: 1 }), '', 'Access denied');
    await Promise.resolve();
    await Promise.resolve();
    assert.match(warnings.join('\n'), /warning.*taskkill refused the target/i);
    assert.equal(settled, false, 'a failed taskkill must not manufacture backend completion');
    assert.deepEqual(test.exits, []);
    test.child.emit('close', 1, null);
    assert.equal((await test.promise).code, 1);
    assertTaskkill(4321);
    console.log('PASS: Windows kill failure warns while an open backend remains tracked');
  }

  for (const platform of ['darwin', 'win32']) {
    const test = fixture(platform, null);
    const error = Object.assign(new Error('backend not found'), { code: 'ENOENT' });
    test.child.emit('error', error);
    test.child.emit('close', -2, null);
    const result = await test.promise;
    assert.equal(result.error, error);
    assert.match(result.err, /spawn error: backend not found/);
    assert.deepEqual(execCalls, []);
    assert.deepEqual(killCalls, []);
    assert.ok(test.timers.every((timer) => !timer.active));
  }
  console.log('PASS: spawn errors without a child PID finish without attempting a kill');

  for (const platform of ['darwin', 'linux']) {
    const test = fixture(platform);
    let settled = false;
    test.promise.then(() => { settled = true; });
    test.fire(100);
    assert.deepEqual(killCalls, [[-4321, 'SIGTERM']]);
    assert.deepEqual(test.timers.map((timer) => timer.delay), [100, 10]);
    test.child.emit('close', null, 'SIGTERM');
    await Promise.resolve();
    assert.equal(settled, false, 'live descendants retain the existing POSIX grace period');
    assert.deepEqual(killCalls, [[-4321, 'SIGTERM'], [-4321, 0]]);
    test.fire(10);
    const result = await test.promise;
    assert.equal(result.timedOut, true);
    assert.deepEqual(killCalls, [[-4321, 'SIGTERM'], [-4321, 0], [-4321, 'SIGKILL']]);
    assert.deepEqual(execCalls, []);
    assert.deepEqual(test.exits, []);
    console.log(`PASS: mocked ${platform} lifecycle preserves TERM, liveness probe, grace, then KILL`);
  }

  for (const platform of ['darwin', 'linux']) {
    const test = fixture(platform);
    test.signal('SIGINT');
    test.signal('SIGINT');
    assert.deepEqual(killCalls, [[-4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
    assert.deepEqual(test.exits, [130], 'a repeated POSIX interrupt retains its immediate force exit');
    assert.deepEqual(execCalls, []);
    process.kill = (...args) => {
      killCalls.push(args);
      throw Object.assign(new Error('already exited'), { code: 'ESRCH' });
    };
    test.child.emit('close', null, 'SIGKILL');
    assert.equal((await test.promise).cancelled, true);
  }
  console.log('PASS: repeated POSIX Ctrl-C retains its immediate SIGKILL and exit-130 behavior');
} finally {
  Object.defineProperty(process, 'platform', originalPlatform);
  process.kill = originalKill;
  childProcess.execFile = originalExecFile;
  console.error = originalError;
  syncBuiltinESMExports();
}
