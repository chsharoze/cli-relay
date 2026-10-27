// Generates the argv snapshot that tests/effort.mjs compares against. Run it against a
// checkout of the commit whose argv is the reference (a `git worktree add` of main), from
// `/` so agy's embedded process.cwd() is the same value the comparison uses:
//
//   (cd / && node <this-file> <reference-checkout>) > tests/fixtures/argv-snapshot.json
//
// Adapter calls cover fresh and resume, with and without a model and a mode. CLI calls
// cover `--print-command` through the real router with a temporary HOME and no config.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) {
  console.error('usage: node gen-argv-snapshot.mjs <reference-checkout>');
  process.exit(2);
}

const BACKENDS = ['codex', 'agy', 'claude-code', 'command-code'];
const PROMPT = 'snapshot prompt';
const ID = 'native-snapshot-id';
const MODEL = 'snapshot-model';
const MODE = 'plan';
const VARIANTS = [
  ['plain', undefined, undefined],
  ['model', MODEL, undefined],
  ['mode', undefined, MODE],
  ['model+mode', MODEL, MODE],
];

const home = mkdtempSync(join(tmpdir(), 'cli-relay-snapshot-'));
const env = { PATH: process.env.PATH, HOME: home };
delete process.env.CLI_RELAY_COMMAND_CODE_MODEL;
process.env.HOME = home;

const snapshot = { cwd: process.cwd(), adapters: {}, cli: {} };
try {
  for (const name of BACKENDS) {
    const { default: adapter } = await import(
      pathToFileURL(join(root, 'src', 'adapters', `${name}.mjs`)).href);
    const entry = {};
    for (const [label, model, mode] of VARIANTS) {
      entry[`fresh:${label}`] = adapter.fresh(PROMPT, model, mode);
      entry[`resume:${label}`] = adapter.resume ? adapter.resume(ID, PROMPT, model, mode) : null;
    }
    snapshot.adapters[name] = entry;
  }

  const stateDir = join(home, '.cli-relay');
  mkdirSync(stateDir, { recursive: true });
  const sessions = {};
  for (const name of BACKENDS) {
    sessions[`snap-${name}`] = {
      backend: name, native_session_id: ID, confirmed: true, status: 'ready',
      binding: { cwd: process.cwd() },
    };
  }
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ version: 1, sessions }));
  for (const name of BACKENDS) {
    const entry = {};
    for (const [label, model, mode] of VARIANTS) {
      for (const verb of ['fresh', 'resume']) {
        const flags = [
          ...(model ? ['--model', model] : []),
          ...(mode ? ['--mode', mode] : []),
        ];
        const result = spawnSync(process.execPath, [
          join(root, 'cli-relay.mjs'), '--print-command', ...flags,
          name, `snap-${name}`, verb, PROMPT,
        ], { env, encoding: 'utf8' });
        entry[`${verb}:${label}`] = result.status === 0
          ? JSON.parse(result.stdout)
          : { exit: result.status };
      }
    }
    snapshot.cli[name] = entry;
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
