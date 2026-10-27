// Hermetic tests for --effort, the live capability menu, `cli-relay help`, per-backend
// config defaults, and model/effort recording. No real backend is ever invoked: every
// backend binary is a fake shell script in a temporary directory, PATH holds only that
// directory plus /usr/bin:/bin, and each run gets its own temporary HOME.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = join(ROOT, 'cli-relay.mjs');
const SNAPSHOT = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/argv-snapshot.json'), 'utf8'));
const GENERATOR = join(ROOT, 'tests/fixtures/gen-argv-snapshot.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'cli-relay-effort-'));
const originalHome = process.env.HOME;
const originalCwd = process.cwd();
delete process.env.CLI_RELAY_COMMAND_CODE_MODEL;
delete process.env.CODEX_HOME;
delete process.env.CLI_RELAY_DISCOVERY_TIMEOUT_MS;
process.env.HOME = join(scratch, 'import-home');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS: ${name}`);
}

let counter = 0;
function freshDir(label) {
  counter += 1;
  const dir = join(scratch, `${label}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeExecutable(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
}

// Discovery spawns get a scrubbed env, so the fakes take their behaviour from files next
// to themselves: an `agy-models-mode` file of "fail" or "hang" breaks `agy models`. Every
// invocation is logged, one line per call, to calls.log in the same directory as
// "<binary> <args...>".
const AGY_HELP_TEXT = [
  'Usage: agy [options]',
  '  --model <id>   Model to use',
  '  --effort   Reasoning effort for the current CLI session (low|medium|high|xhigh|max)',
  '  --mode <name>  Session mode',
].join('\n');
const CLAUDE_HELP_TEXT = [
  'Usage: claude [options] [prompt]',
  '  --effort <level>                  Effort level for the current session',
  '                                    (low, medium, high, xhigh, max)',
  '  --fallback-model <model>          Fallback model',
].join('\n');
const COMMAND_CODE_HELP_TEXT = [
  'Usage: command-code [options]',
  '  --effort <level>   Set reasoning effort for the session (e.g. low, medium, high) — depends on the model',
].join('\n');
const AGY_LISTING_TEXT = [
  'Fetching available models...',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (medium)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (high)',
  'gemini-4-argon-low\tGemini 4 Argon (low)',
  'gemini-4-argon-medium\tGemini 4 Argon (medium)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (high)',
].join('\n');

function makeFakes() {
  const bin = freshDir('bin');
  writeFileSync(join(bin, 'agy-help.txt'), `${AGY_HELP_TEXT}\n`);
  writeFileSync(join(bin, 'agy-models.txt'), `${AGY_LISTING_TEXT}\n`);
  writeFileSync(join(bin, 'claude-help.txt'), `${CLAUDE_HELP_TEXT}\n`);
  writeFileSync(join(bin, 'command-code-help.txt'), `${COMMAND_CODE_HELP_TEXT}\n`);
  writeFileSync(join(bin, 'command-code-models.txt'), [
    'Available models · 94 models', '', 'Open Source', '  deepseek/deepseek-v4.1-flash  DeepSeek V4.1 Flash',
    '  zai-org/glm-5.2  GLM 5.2', 'Proprietary:', '  - typesafe/jev',
  ].join('\n'));
  writeExecutable(join(bin, 'agy'), `echo "agy $*" >> "$(dirname "$0")/calls.log"
if [ "$1" = models ]; then
  case "$(cat "$(dirname "$0")/agy-models-mode" 2>/dev/null)" in
    fail) echo "listing broke" >&2; exit 1 ;;
    hang) echo $$ > "$(dirname "$0")/agy-models.pid"; exec sleep 30 ;;
  esac
  cat "$(dirname "$0")/agy-models.txt"; exit 0
fi
if [ "$1" = --help ]; then cat "$(dirname "$0")/agy-help.txt"; exit 0; fi
echo '{"conversation_id":"agy-conv-1","response":"agy answer"}'
`);
  writeExecutable(join(bin, 'claude'), `echo "claude $*" >> "$(dirname "$0")/calls.log"
if [ "$1" = --help ]; then cat "$(dirname "$0")/claude-help.txt"; exit 0; fi
echo '{"session_id":"claude-session-1","result":"claude answer"}'
`);
  writeExecutable(join(bin, 'command-code'), `echo "command-code $*" >> "$(dirname "$0")/calls.log"
if [ "$1" = --list-models ]; then cat "$(dirname "$0")/command-code-models.txt"; exit 0; fi
if [ "$1" = --help ]; then cat "$(dirname "$0")/command-code-help.txt"; exit 0; fi
echo '{"sessionId":"cc-session-1","finalText":"command-code answer"}'
`);
  writeExecutable(join(bin, 'codex'), `echo "codex $*" >> "$(dirname "$0")/calls.log"
echo '{"type":"thread.started","thread_id":"codex-thread-1"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"codex answer"}}'
`);
  return bin;
}

const CODEX_CACHE = {
  models: [
    {
      slug: 'gpt-6.1-sol',
      supported_reasoning_levels: [
        { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
        { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
      ],
      default_reasoning_level: 'low',
    },
    { slug: 'gpt-6.1-mini', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
  ],
};

function makeHome({ config, codexCache = CODEX_CACHE, sessions } = {}) {
  const home = freshDir('home');
  mkdirSync(join(home, '.cli-relay'), { recursive: true });
  if (config !== undefined) {
    writeFileSync(join(home, '.cli-relay', 'config.json'),
      typeof config === 'string' ? config : JSON.stringify(config));
  }
  if (codexCache !== null) {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'models_cache.json'),
      typeof codexCache === 'string' ? codexCache : JSON.stringify(codexCache));
  }
  if (sessions) {
    writeFileSync(join(home, '.cli-relay', 'sessions.json'), JSON.stringify({ version: 1, sessions }));
  }
  return home;
}

function confirmedSession(backend) {
  return {
    backend, native_session_id: `native-${backend}`, confirmed: true, status: 'ready',
    binding: { cwd: '/' },
  };
}

function run(args, {
  home = makeHome(), bin = makeFakes(), env = {}, cwd = '/', agyModels,
} = {}) {
  const log = join(bin, 'calls.log');
  writeFileSync(log, '');
  writeFileSync(join(bin, 'agy-models-mode'), agyModels ?? 'ok');
  const result = spawnSync(process.execPath, [ROUTE, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env },
    timeout: 60_000,
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { code: result.status, out: result.stdout, err: result.stderr, calls, home, bin };
}

function printed(args, options) {
  const result = run(['--print-command', ...args], options);
  assert.equal(result.code, 0, `${args.join(' ')} failed: ${result.err}`);
  return { argv: JSON.parse(result.out), ...result };
}

function warnings(stderr) {
  return stderr.split('\n').filter((line) => line.startsWith('warning:'));
}

try {
  process.chdir('/');
  const { parseEffortHelp, EFFORT_SUFFIXES } = await import('../src/core/effort.mjs');
  const { DISCOVERY_TIMEOUT_MS, discoveryTimeoutMs } = await import('../src/core/discovery.mjs');
  const { parseCodexModelsCache } = await import('../src/adapters/codex.mjs');
  const { agyEffortModel, agyModelEffort, parseAgyModels } = await import('../src/adapters/agy.mjs');
  const { parseCommandCodeModels } = await import('../src/adapters/command-code.mjs');
  const { parseModelListing } = await import('../src/commands/models.mjs');
  const adapterModules = {};
  for (const name of ['codex', 'agy', 'claude-code', 'command-code']) {
    adapterModules[name] = (await import(pathToFileURL(join(ROOT, 'src/adapters', `${name}.mjs`)).href)).default;
  }

  // --- argv invariant: no flags and no config reproduce main's argv byte for byte ---
  await test('snapshot fixture was generated from /', () => {
    assert.equal(SNAPSHOT.cwd, '/');
  });

  await test('adapters with effort undefined reproduce the snapshot exactly', () => {
    const variants = [
      ['plain', undefined, undefined], ['model', 'snapshot-model', undefined],
      ['mode', undefined, 'plan'], ['model+mode', 'snapshot-model', 'plan'],
    ];
    for (const [name, adapter] of Object.entries(adapterModules)) {
      for (const [label, model, mode] of variants) {
        assert.deepEqual(adapter.fresh('snapshot prompt', model, mode),
          SNAPSHOT.adapters[name][`fresh:${label}`], `${name} fresh:${label}`);
        assert.deepEqual(adapter.fresh('snapshot prompt', model, mode, undefined),
          SNAPSHOT.adapters[name][`fresh:${label}`], `${name} fresh:${label} (explicit undefined)`);
        const resumed = adapter.resume
          ? adapter.resume('native-snapshot-id', 'snapshot prompt', model, mode, undefined)
          : null;
        assert.deepEqual(resumed, SNAPSHOT.adapters[name][`resume:${label}`], `${name} resume:${label}`);
      }
    }
  });

  await test('the full router (--print-command, temp HOME, no config) reproduces the snapshot', () => {
    const result = spawnSync(process.execPath, [GENERATOR, ROOT], {
      cwd: '/', encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: makeHome() },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), SNAPSHOT);
  });

  await test('a config.json without a backends key changes no argv', () => {
    const home = makeHome({ config: { LOCK_RETRY_MS: 100 } });
    for (const name of ['codex', 'agy', 'claude-code', 'command-code']) {
      const { argv, err } = printed([name, 't', 'fresh', 'snapshot prompt'], { home });
      assert.deepEqual(argv, SNAPSHOT.cli[name]['fresh:plain']);
      assert.deepEqual(warnings(err), []);
    }
  });

  // --- per-adapter --effort argv ---
  await test('codex --effort adds -c model_reasoning_effort on fresh and resume', () => {
    const home = makeHome({ sessions: { r: confirmedSession('codex') } });
    assert.deepEqual(printed(['--effort', 'high', 'codex', 't', 'fresh', 'p'], { home }).argv, [
      'codex', 'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write',
      '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '--json', 'p',
    ]);
    assert.deepEqual(printed(['--effort=medium', 'codex', 'r', 'resume', 'p'], { home }).argv, [
      'codex', 'exec', 'resume', 'native-codex', '--dangerously-bypass-approvals-and-sandbox',
      '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=medium', '--json', 'p',
    ]);
  });

  await test('agy --effort on an unsuffixed model adds --effort on fresh and resume, no listing', () => {
    const home = makeHome({ sessions: { r: confirmedSession('agy') } });
    const fresh = printed(['--model', 'plain-model', '--effort', 'high', 'agy', 't', 'fresh', 'p'], { home });
    assert.deepEqual(fresh.argv, [
      'agy', '--dangerously-skip-permissions', '--print-timeout', '10m', '--model', 'plain-model',
      '--effort', 'high', '--add-dir', '/', '--output-format', 'json', '-p', 'p',
    ]);
    assert.deepEqual(fresh.calls, []);
    const resumed = printed(['--model', 'plain-model', '--mode', 'plan', '--effort', 'low', 'agy', 'r', 'resume', 'p'], { home });
    assert.deepEqual(resumed.argv, [
      'agy', '--dangerously-skip-permissions', '--print-timeout', '10m', '--model', 'plain-model',
      '--mode', 'plan', '--effort', 'low', '--add-dir', '/', '--output-format', 'json',
      '--conversation', 'native-agy', '-p', 'p',
    ]);
  });

  await test('claude-code --effort appends --effort on fresh and resume', () => {
    const home = makeHome({ sessions: { r: confirmedSession('claude-code') } });
    assert.deepEqual(printed(['--effort', 'xhigh', 'claude-code', 't', 'fresh', 'p'], { home }).argv, [
      'claude', '-p', 'p', '--output-format', 'json', '--dangerously-skip-permissions',
      '--effort', 'xhigh',
    ]);
    assert.deepEqual(printed(['--model', 'm', '--effort', 'max', 'claude-code', 'r', 'resume', 'p'], { home }).argv, [
      'claude', '-r', 'native-claude-code', '-p', 'p', '--output-format', 'json',
      '--dangerously-skip-permissions', '--model', 'm', '--effort', 'max',
    ]);
  });

  await test('command-code --effort is passed through; resume stays unsupported', () => {
    const home = makeHome({ sessions: { r: confirmedSession('command-code') } });
    assert.deepEqual(printed(['--effort', 'anything', 'command-code', 't', 'fresh', 'p'], { home }).argv, [
      'command-code', '-p', 'p', '-m', 'zai-org/glm-5.2', '--effort', 'anything',
      '--output-format', 'json', '--yolo', '--no-auto-update',
    ]);
    assert.equal(adapterModules['command-code'].resume, null);
    const resumed = run(['--print-command', '--effort', 'low', 'command-code', 'r', 'resume', 'p'], { home });
    assert.equal(resumed.code, 1);
    assert.match(resumed.err, /no supported resume command/);
  });

  await test('--effort after the mode argument is prompt text for every backend', () => {
    for (const name of ['codex', 'agy', 'claude-code', 'command-code']) {
      const { argv } = printed([name, 't', 'fresh', 'snapshot', '--effort', 'high']);
      const expected = SNAPSHOT.cli[name]['fresh:plain']
        .map((token) => (token === 'snapshot prompt' ? 'snapshot --effort high' : token));
      assert.deepEqual(argv, expected, name);
    }
  });

  // --- validation ---
  await test('malformed, duplicate and missing --effort values are usage errors for all backends', () => {
    for (const name of ['codex', 'agy', 'claude-code', 'command-code']) {
      for (const args of [
        ['--effort', 'HIGH'], ['--effort=hi-gh'], ['--effort', 'x1'], ['--effort='],
        ['--effort', 'low', '--effort', 'high'],
      ]) {
        const result = run([...args, name, 't', 'fresh', 'p']);
        assert.equal(result.code, 2, `${name} ${args.join(' ')}: ${result.err}`);
        assert.deepEqual(result.calls, [], 'nothing may spawn on a usage error');
      }
      const missing = run([name, 't', '--effort']);
      assert.equal(missing.code, 2);
    }
  });

  await test('codex rejects a level outside the resolved slug list, naming the allowed values', () => {
    const result = run(['--print-command', '--model', 'gpt-6.1-mini', '--effort', 'high', 'codex', 't', 'fresh', 'p']);
    assert.equal(result.code, 2);
    assert.match(result.err, /not supported by codex model "gpt-6\.1-mini" — choose one of: low, medium/);
    assert.equal(result.out, '');
    const real = run(['--effort', 'nope', 'codex', 't', 'fresh', 'p']);
    assert.equal(real.code, 2);
    assert.deepEqual(real.calls, []);
    assert.equal(existsSync(join(real.home, '.cli-relay', 'sessions.json')), false);
  });

  await test('codex passes through an unknown slug, a missing cache and an unreadable cache', () => {
    assert.ok(printed(['--model', 'unlisted', '--effort', 'ultra', 'codex', 't', 'fresh', 'p'])
      .argv.includes('model_reasoning_effort=ultra'));
    for (const codexCache of [null, '{not json', '{"models":"nope"}']) {
      const home = makeHome({ codexCache });
      assert.ok(printed(['--effort', 'whatever', 'codex', 't', 'fresh', 'p'], { home })
        .argv.includes('model_reasoning_effort=whatever'));
    }
  });

  await test('codex honours CODEX_HOME for its cache', () => {
    const codexHome = freshDir('codex-home');
    writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', supported_reasoning_levels: ['low'] }] }));
    const result = run(['--print-command', '--effort', 'high', 'codex', 't', 'fresh', 'p'], { env: { CODEX_HOME: codexHome } });
    assert.equal(result.code, 2);
    assert.match(result.err, /choose one of: low$/m);
  });

  await test('agy and claude-code never run --help at dispatch (real and dry run)', () => {
    for (const name of ['agy', 'claude-code']) {
      for (const dry of [true, false]) {
        const result = run([...(dry ? ['--print-command'] : []), '--effort', 'high', name, 't', 'fresh', 'p']);
        assert.equal(result.code, 0, result.err);
        assert.ok(!result.calls.some((call) => call.includes('--help')), result.calls.join('\n'));
      }
    }
  });

  await test('a refused dry run or resume spawns no discovery', () => {
    const inFlight = { ...confirmedSession('agy'), status: 'running', run_started_iso: new Date().toISOString() };
    const home = makeHome({ sessions: { busy: inFlight, other: confirmedSession('codex') } });
    const cases = [
      [['--effort', 'high', 'agy', 'missing', 'resume', 'p'], /no confirmed session/],
      [['--effort', 'high', 'agy', 'busy', 'fresh', 'p'], /already in flight/],
      [['--effort', 'high', 'agy', 'other', 'fresh', 'p'], /belongs to backend "codex"/],
    ];
    for (const [args, message] of cases) {
      for (const dry of [true, false]) {
        const result = run([...(dry ? ['--print-command'] : []), ...args], { home });
        assert.equal(result.code, 1, result.err);
        assert.match(result.err, message);
        assert.deepEqual(result.calls, [], `${dry ? 'dry' : 'real'} ${args.join(' ')} spawned ${result.calls}`);
      }
    }
    const ledger = readFileSync(join(home, '.cli-relay', 'ledger.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(ledger.length, 3, 'real refused attempts stay auditable');
    assert.ok(ledger.every((entry) => entry.outcome === 'failed' && entry.model === null && entry.effort === null));
  });

  // --- parsers ---
  await test('help-text parser handles the agy, claude, command-code and no-option fixtures', () => {
    assert.deepEqual(parseEffortHelp(AGY_HELP_TEXT), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(parseEffortHelp(CLAUDE_HELP_TEXT), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(parseEffortHelp(COMMAND_CODE_HELP_TEXT), null);
    assert.equal(parseEffortHelp('Usage: tool [options]\n  --model <id>  (a|b)\n'), null);
  });

  await test('help-text parser rejects malformed inputs', () => {
    for (const input of [
      null, undefined, 42, '', '--effort <level>   no list here',
      '--effort <level>  Effort\n  --other (low|high)',
      '--effort <level>  Effort\n\n\n\n  (low, high)',
      '--effort (Low|High)', '--effort (low|high-ish)', '--effort ()', '--effort (E.G. low, high)',
      '--efforts (low|high)',
    ]) {
      assert.equal(parseEffortHelp(input), null, JSON.stringify(input));
    }
    assert.deepEqual(parseEffortHelp('  -e, --effort <l>  (low | high | low)'), ['low', 'high']);
  });

  await test('codex cache parser reads the observed shape', () => {
    assert.deepEqual(parseCodexModelsCache(CODEX_CACHE), {
      'gpt-6.1-sol': { levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
      'gpt-6.1-mini': { levels: ['low', 'medium'], defaultEffort: null },
    });
  });

  await test('codex cache parser is defensive about malformed inputs', () => {
    for (const input of [null, undefined, 'x', 3, {}, { models: 'x' }, { models: [] }, [null, 4, {}, { slug: '' }, { slug: 5 }]]) {
      assert.equal(parseCodexModelsCache(input), null, JSON.stringify(input));
    }
    assert.deepEqual(parseCodexModelsCache([
      'bare-slug',
      { id: 'by-id', supported_reasoning_levels: ['low', { effort: 'High' }, { level: 'max' }, null, 7], default_reasoning_level: 9 },
      { slug: 'no-levels', supported_reasoning_levels: 'low' },
      { slug: 'bare-slug', supported_reasoning_levels: ['high'] },
    ]), {
      'bare-slug': { levels: null, defaultEffort: null },
      'by-id': { levels: ['low', 'max'], defaultEffort: null },
      'no-levels': { levels: null, defaultEffort: null },
    });
  });

  await test('command-code listing parser keeps only provider/model ids; the shared parser is unchanged', () => {
    const text = 'Available models · 94 models\n\nOpen Source\n  deepseek/deepseek-v4.1-flash  Flash\n' +
      'Proprietary:\n  - typesafe/jev\nzai-org/glm-5.2\n';
    assert.deepEqual(parseCommandCodeModels(text), ['deepseek/deepseek-v4.1-flash', 'typesafe/jev', 'zai-org/glm-5.2']);
    assert.deepEqual(parseModelListing(text),
      ['Available', 'Open', 'deepseek/deepseek-v4.1-flash', 'typesafe/jev', 'zai-org/glm-5.2']);
  });

  await test('agy listing parser drops the progress line and display names', () => {
    assert.deepEqual(parseAgyModels(AGY_LISTING_TEXT), [
      'gemini-3.8-flash-medium', 'gemini-3.8-flash-high', 'gemini-4-argon-low', 'gemini-4-argon-medium',
      'claude-sonnet-5-5-high',
    ]);
  });

  // --- the agy rule ---
  await test('agyEffortModel never pairs a suffixed id with --effort', () => {
    const ids = parseAgyModels(AGY_LISTING_TEXT);
    assert.deepEqual(EFFORT_SUFFIXES, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(agyModelEffort('gemini-3.8-flash-medium'), 'medium');
    assert.equal(agyModelEffort('plain'), null);
    // Swap when listed.
    assert.deepEqual(agyEffortModel('gemini-3.8-flash-medium', 'high', ids),
      { model: 'gemini-3.8-flash-high', effort: undefined });
    // Suffix already at the level: unchanged, listing irrelevant.
    assert.deepEqual(agyEffortModel('gemini-3.8-flash-medium', 'medium', null),
      { model: 'gemini-3.8-flash-medium', effort: undefined });
    // Unlisted sibling from a flag: usage error naming the family's listed levels.
    const flagged = agyEffortModel('gemini-4-argon-low', 'max', ids, 'flag');
    assert.equal(flagged.model, 'gemini-4-argon-low');
    assert.equal(flagged.effort, undefined);
    assert.equal(flagged.error,
      'agy lists no model "gemini-4-argon-max" — gemini-4-argon-* is listed with efforts: low, medium');
    // Unlisted sibling from config: dropped with a warning, id kept, no --effort.
    const configured = agyEffortModel('gemini-4-argon-low', 'max', ids, 'config');
    assert.deepEqual([configured.model, configured.effort, configured.dropped, configured.error],
      ['gemini-4-argon-low', undefined, true, undefined]);
    assert.match(configured.warning, /ignoring the configured effort and keeping "gemini-4-argon-low"/);
    // Listing unavailable: blind swap with one warning.
    const blind = agyEffortModel('gemini-3.8-flash-medium', 'xhigh', null);
    assert.deepEqual([blind.model, blind.effort], ['gemini-3.8-flash-xhigh', undefined]);
    assert.match(blind.warning, /listing unavailable; using "gemini-3\.8-flash-xhigh"/);
    // Unsuffixed id: plain --effort.
    assert.deepEqual(agyEffortModel('plain', 'high', ids), { model: 'plain', effort: 'high' });
    assert.deepEqual(agyEffortModel('plain', 'high', null), { model: 'plain', effort: 'high' });
  });

  const agyArgv = (model, effort, extra = []) => [
    'agy', '--dangerously-skip-permissions', '--print-timeout', '10m', '--model', model,
    ...(effort ? ['--effort', effort] : []),
    '--add-dir', '/', '--output-format', 'json', ...extra, '-p', 'p',
  ];

  await test('agy rule: the default model swaps to its listed sibling with no --effort', () => {
    const result = printed(['--effort', 'high', 'agy', 't', 'fresh', 'p']);
    assert.deepEqual(result.argv, agyArgv('gemini-3.8-flash-high'));
    assert.deepEqual(result.calls, ['agy models']);
    assert.deepEqual(warnings(result.err), []);
  });

  await test('agy rule: an effort equal to the suffix keeps the id and spawns no listing', () => {
    const result = printed(['--effort', 'medium', 'agy', 't', 'fresh', 'p']);
    assert.deepEqual(result.argv, agyArgv('gemini-3.8-flash-medium'));
    assert.deepEqual(result.calls, []);
    assert.deepEqual(warnings(result.err), []);
  });

  await test('agy rule: an explicit suffixed model swaps when listed, also on resume', () => {
    const swap = printed(['--model', 'gemini-3.8-flash-high', '--effort', 'medium', 'agy', 't', 'fresh', 'p']);
    assert.deepEqual(swap.argv, agyArgv('gemini-3.8-flash-medium'));
    assert.deepEqual(warnings(swap.err), []);
    const home = makeHome({ sessions: { r: confirmedSession('agy') } });
    const resumed = printed(['--model', 'gemini-4-argon-low', '--effort', 'medium', 'agy', 'r', 'resume', 'p'], { home });
    assert.deepEqual(resumed.argv, agyArgv('gemini-4-argon-medium', undefined, ['--conversation', 'native-agy']));
  });

  await test('agy rule: an unlisted sibling from --effort is a usage error before any dispatch', () => {
    for (const dry of [true, false]) {
      const result = run([...(dry ? ['--print-command'] : []),
        '--model', 'gemini-4-argon-low', '--effort', 'max', 'agy', 't', 'fresh', 'p']);
      assert.equal(result.code, 2, result.err);
      assert.equal(result.out, '');
      assert.match(result.err, /^agy lists no model "gemini-4-argon-max" — gemini-4-argon-\* is listed with efforts: low, medium$/m);
      assert.deepEqual(result.calls, ['agy models']);
    }
  });

  await test('agy rule: an unlisted sibling from config warns, drops the effort and keeps the id', () => {
    const home = makeHome({ config: { backends: { agy: { model: 'gemini-4-argon-low', effort: 'max' } } } });
    const result = printed(['agy', 't', 'fresh', 'p'], { home });
    assert.deepEqual(result.argv, agyArgv('gemini-4-argon-low'));
    assert.deepEqual(warnings(result.err), [
      'warning: agy lists no model "gemini-4-argon-max" — gemini-4-argon-* is listed with efforts: low, medium; ' +
        'ignoring the configured effort and keeping "gemini-4-argon-low"',
    ]);
  });

  await test('agy rule: a failing listing swaps blind with a warning', () => {
    const result = printed(['--effort', 'high', 'agy', 't', 'fresh', 'p'], { agyModels: 'fail' });
    assert.deepEqual(result.argv, agyArgv('gemini-3.8-flash-high'));
    const lines = warnings(result.err);
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0], /discovery "agy models" failed \(exited 1\)/);
    assert.match(lines[1], /listing unavailable; using "gemini-3\.8-flash-high"/);
  });

  await test('agy rule: a hanging listing times out, swaps blind, and kills the child', () => {
    const started = Date.now();
    const result = printed(['--effort', 'low', 'agy', 't', 'fresh', 'p'], {
      agyModels: 'hang', env: { CLI_RELAY_DISCOVERY_TIMEOUT_MS: '400' },
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10_000, `took ${elapsed}ms`);
    assert.deepEqual(result.argv, agyArgv('gemini-3.8-flash-low'));
    const lines = warnings(result.err);
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0], /discovery "agy models" failed \(timed out after 0\.4s\)/);
  });

  await test('discovery timeout defaults to 15 s and is overridable', () => {
    assert.equal(DISCOVERY_TIMEOUT_MS, 15_000);
    assert.equal(discoveryTimeoutMs(), 15_000);
    process.env.CLI_RELAY_DISCOVERY_TIMEOUT_MS = '250';
    assert.equal(discoveryTimeoutMs(), 250);
    process.env.CLI_RELAY_DISCOVERY_TIMEOUT_MS = 'nonsense';
    assert.equal(discoveryTimeoutMs(), 15_000);
    delete process.env.CLI_RELAY_DISCOVERY_TIMEOUT_MS;
  });

  await test('a hanging --help in cli-relay models times out without failing the command', () => {
    const bin = makeFakes();
    writeExecutable(join(bin, 'claude'), 'exec sleep 30\n');
    const started = Date.now();
    const result = run(['models', 'claude-code', '--json'], { bin, env: { CLI_RELAY_DISCOVERY_TIMEOUT_MS: '400' } });
    assert.ok(Date.now() - started < 10_000);
    assert.equal(result.code, 0, result.err);
    assert.equal(JSON.parse(result.out)['claude-code'].efforts, null);
    assert.equal(warnings(result.err).length, 1);
  });

  await test('Ctrl-C during discovery kills the detached discovery child and exits 130', async () => {
    const bin = makeFakes();
    writeFileSync(join(bin, 'calls.log'), '');
    writeFileSync(join(bin, 'agy-models-mode'), 'hang');
    const pidFile = join(bin, 'agy-models.pid');
    const child = spawn(process.execPath, [ROUTE, 'models', 'agy'], {
      cwd: '/', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: makeHome() }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 10_000;
    while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8').trim()) {
      assert.ok(Date.now() < deadline, 'discovery child never started');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const discoveryPid = Number(readFileSync(pidFile, 'utf8').trim());
    child.kill('SIGINT');
    const { code } = await exited;
    assert.equal(code, 130, stderr);
    assert.match(stderr, /terminating backend discovery/);
    // A killed child whose parent exited before reaping it stays a zombie until init reaps
    // it, and signal 0 still succeeds on a zombie; where /proc exists, count that as dead.
    const isAlive = (pid) => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      try {
        return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
      } catch {
        return true;
      }
    };
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
      alive = isAlive(discoveryPid);
      if (alive) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(alive, false, `discovery child ${discoveryPid} survived Ctrl-C`);
  });

  // --- config defaults ---
  await test('config model and effort apply; flags override them', () => {
    const home = makeHome({ config: { backends: {
      codex: { model: 'gpt-6.1-mini', effort: 'low' },
      'claude-code': { effort: 'high' },
    } } });
    const codex = printed(['codex', 't', 'fresh', 'p'], { home }).argv;
    assert.deepEqual(codex.slice(5, 9), ['-m', 'gpt-6.1-mini', '-c', 'model_reasoning_effort=low']);
    const flagged = printed(['--model', 'gpt-6.1-sol', '--effort', 'xhigh', 'codex', 't', 'fresh', 'p'], { home }).argv;
    assert.deepEqual(flagged.slice(5, 9), ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=xhigh']);
    assert.deepEqual(printed(['claude-code', 't', 'fresh', 'p'], { home }).argv.slice(-2), ['--effort', 'high']);
    // Untouched backends keep main's argv.
    assert.deepEqual(printed(['agy', 't', 'fresh', 'snapshot prompt'], { home }).argv, SNAPSHOT.cli.agy['fresh:plain']);
  });

  await test('command-code model: --model, then env, then config, then built-in', () => {
    const home = makeHome({ config: { backends: { 'command-code': { model: 'deepseek/deepseek-v4.1-flash' } } } });
    const modelOf = (args, env) => {
      const { argv } = printed([...args, 'command-code', 't', 'fresh', 'p'], { home, env });
      return argv[argv.indexOf('-m') + 1];
    };
    assert.equal(modelOf([], {}), 'deepseek/deepseek-v4.1-flash');
    assert.equal(modelOf([], { CLI_RELAY_COMMAND_CODE_MODEL: 'env/model' }), 'env/model');
    assert.equal(modelOf([], { CLI_RELAY_COMMAND_CODE_MODEL: '' }), 'deepseek/deepseek-v4.1-flash');
    assert.equal(modelOf(['--model', 'flag/model'], { CLI_RELAY_COMMAND_CODE_MODEL: 'env/model' }), 'flag/model');
    const bare = makeHome();
    const { argv } = printed(['command-code', 't', 'fresh', 'p'], { home: bare });
    assert.equal(argv[argv.indexOf('-m') + 1], 'zai-org/glm-5.2');
  });

  await test('a configured codex effort the cache rules out warns and is dropped', () => {
    const home = makeHome({ config: { backends: { codex: { model: 'gpt-6.1-mini', effort: 'max' } } } });
    const result = printed(['codex', 't', 'fresh', 'p'], { home });
    assert.ok(!result.argv.includes('-c'));
    assert.deepEqual(warnings(result.err), [
      'warning: effort "max" is not supported by codex model "gpt-6.1-mini" — choose one of: low, medium; ignoring the configured effort',
    ]);
  });

  await test('bad config entries warn once each and are ignored without failing any command', () => {
    const home = makeHome({ config: { backends: {
      codex: { model: '', effort: 'High', colour: 'red' },
      agy: 'fast',
      'claude-code': ['x'],
      nosuch: { model: 'm' },
      'command-code': { model: 'ok/model', effort: 'medium' },
    } } });
    const result = printed(['codex', 't', 'fresh', 'snapshot prompt'], { home });
    assert.deepEqual(result.argv, SNAPSHOT.cli.codex['fresh:plain']);
    const lines = warnings(result.err);
    assert.equal(lines.length, 6, lines.join('\n'));
    for (const fragment of ['backends.codex.model', 'backends.codex.effort', 'backends.codex.colour',
      'backends.agy must be an object', 'backends.claude-code must be an object', 'no backend named "nosuch"']) {
      assert.ok(lines.some((line) => line.includes(fragment)), fragment);
    }
    const cc = printed(['command-code', 't', 'fresh', 'p'], { home }).argv;
    assert.deepEqual(cc.slice(3, 7), ['-m', 'ok/model', '--effort', 'medium']);
    for (const args of [['list'], ['doctor'], ['models', '--json'], ['help']]) {
      const other = run(args, { home });
      assert.ok(other.code === 0, `${args.join(' ')} exited ${other.code}: ${other.err}`);
    }
    const notObject = makeHome({ config: { backends: 'codex' } });
    const single = printed(['codex', 't', 'fresh', 'snapshot prompt'], { home: notObject });
    assert.deepEqual(single.argv, SNAPSHOT.cli.codex['fresh:plain']);
    assert.equal(warnings(single.err).length, 1);
  });

  // --- recording ---
  await test('ledger and session entries carry the model and effort used', () => {
    const home = makeHome();
    const ledgerPath = join(home, '.cli-relay', 'ledger.jsonl');
    const sessionsPath = join(home, '.cli-relay', 'sessions.json');
    // An entry written in the pre-change shape (no model/effort) starts the chain.
    const seeded = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { appendLedgerEntry } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/governance/ledger.mjs')).href)});
      await appendLedgerEntry({ backend: 'agy', thread: 'old', mode: 'fresh', outcome: 'confirmed', exit_code: 0, tier: 1, tier_name: 'read-only', gate_allowed: true });
    `], { env: { PATH: '/usr/bin:/bin', HOME: home }, encoding: 'utf8' });
    assert.equal(seeded.status, 0, seeded.stderr);

    const bin = makeFakes();
    const swapped = run(['--effort', 'high', 'agy', 'a', 'fresh', 'p'], { home, bin });
    assert.equal(swapped.code, 0, swapped.err);
    const plain = run(['claude-code', 'c', 'fresh', 'p'], { home, bin });
    assert.equal(plain.code, 0, plain.err);
    const codex = run(['--model', 'gpt-6.1-mini', '--effort', 'medium', 'codex', 'x', 'fresh', 'p'], { home, bin });
    assert.equal(codex.code, 0, codex.err);
    const defaulted = run(['codex', 'y', 'fresh', 'p'], { home, bin });
    assert.equal(defaulted.code, 0, defaulted.err);

    const entries = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.length, 5);
    assert.equal(Object.hasOwn(entries[0], 'model'), false);
    assert.deepEqual(entries.slice(1).map((entry) => [entry.thread, entry.model, entry.effort]), [
      ['a', 'gemini-3.8-flash-high', 'high'],
      ['c', null, null],
      ['x', 'gpt-6.1-mini', 'medium'],
      ['y', 'gpt-6.1-sol', null],
    ]);
    const sessions = JSON.parse(readFileSync(sessionsPath, 'utf8')).sessions;
    assert.deepEqual([sessions.a.last_model, sessions.a.last_effort], ['gemini-3.8-flash-high', 'high']);
    assert.deepEqual([sessions.c.last_model, sessions.c.last_effort], [null, null]);
    assert.deepEqual([sessions.x.last_model, sessions.x.last_effort], ['gpt-6.1-mini', 'medium']);

    const verify = run(['audit', 'verify'], { home, bin });
    assert.equal(verify.code, 0, verify.out + verify.err);
  });

  await test('a dry run with --effort writes no state', () => {
    const home = makeHome();
    const result = printed(['--effort', 'high', 'agy', 't', 'fresh', 'p'], { home });
    assert.deepEqual(result.calls, ['agy models']);
    assert.equal(existsSync(join(home, '.cli-relay', 'sessions.json')), false);
    assert.equal(existsSync(join(home, '.cli-relay', 'ledger.jsonl')), false);
  });

  // --- help and models ---
  await test('cli-relay help, --help and -h go to stdout and spawn nothing', () => {
    const home = makeHome({ config: { backends: { codex: { model: 'gpt-6.1-mini', effort: 'low' } } } });
    for (const flag of ['help', '--help', '-h']) {
      const result = run([flag], { home, env: { CLI_RELAY_COMMAND_CODE_MODEL: 'env/model' } });
      assert.equal(result.code, 0);
      assert.equal(result.err, '');
      assert.deepEqual(result.calls, []);
      for (const flagName of ['--model', '--effort', '--mode', '--tier', '--confirm', '--dry-run, --print-command']) {
        assert.ok(result.out.includes(`  ${flagName}`), flagName);
      }
      assert.match(result.out, /codex +gpt-6\.1-mini \(config\) +low \(config\)/);
      assert.match(result.out, /agy +gemini-3\.8-flash-medium \(built-in\) +medium \(model id\)/);
      assert.match(result.out, /claude-code +backend default +backend default/);
      assert.match(result.out, /command-code +env\/model \(env CLI_RELAY_COMMAND_CODE_MODEL\) +backend default/);
      assert.ok(result.out.includes('Choosing an effort (--effort <level>). A starting point, not a rule.'));
      assert.ok(result.out.includes('cli-relay models'));
    }
    const extra = run(['--help', 'codex']);
    assert.equal(extra.code, 2);
    const helpExtra = run(['help', 'codex', '--json'], { home });
    assert.equal(helpExtra.code, 0);
    assert.ok(helpExtra.out.includes('Choosing an effort'));
    assert.deepEqual(helpExtra.calls, []);
  });

  await test('cli-relay models --json matches the documented shape', () => {
    const result = run(['models', '--json']);
    assert.equal(result.code, 0, result.err);
    assert.ok(!result.calls.includes('command-code --help'), 'command-code help is never parsed');
    const menu = JSON.parse(result.out);
    assert.deepEqual(Object.keys(menu), ['codex', 'agy', 'claude-code', 'command-code']);
    for (const entry of Object.values(menu)) {
      assert.deepEqual(Object.keys(entry), ['status', 'reason', 'source', 'efforts', 'models']);
      assert.ok(['listing', 'pass-through', 'unavailable'].includes(entry.status));
      for (const model of entry.models ?? []) {
        assert.deepEqual(Object.keys(model), ['id', 'efforts', 'defaultEffort']);
      }
    }
    assert.deepEqual(menu.codex, {
      status: 'listing', reason: null, source: 'codex model cache (~/.codex/models_cache.json)', efforts: null,
      models: [
        { id: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
        { id: 'gpt-6.1-mini', efforts: ['low', 'medium'], defaultEffort: null },
      ],
    });
    assert.equal(menu.agy.status, 'listing');
    assert.equal(menu.agy.source, 'agy --help');
    assert.deepEqual(menu.agy.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(menu.agy.models.map((model) => model.id), parseAgyModels(AGY_LISTING_TEXT));
    assert.deepEqual(menu['claude-code'], {
      status: 'pass-through', reason: null, source: 'claude --help',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: null,
    });
    assert.deepEqual(menu['command-code'], {
      status: 'listing', reason: null, source: 'model-dependent, passed through', efforts: null,
      models: [
        { id: 'deepseek/deepseek-v4.1-flash', efforts: null, defaultEffort: null },
        { id: 'zai-org/glm-5.2', efforts: null, defaultEffort: null },
        { id: 'typesafe/jev', efforts: null, defaultEffort: null },
      ],
    });
    if (process.env.CLI_RELAY_SHOW_SAMPLES) {
      console.log(result.out);
      console.log(run(['models']).out);
      console.log(run(['help']).out);
    }
  });

  await test('cli-relay models reports missing binaries, failing listings and no codex cache', () => {
    const bin = makeFakes();
    rmSync(join(bin, 'command-code'));
    rmSync(join(bin, 'claude'));
    const result = run(['models', '--json'], { bin, home: makeHome({ codexCache: null }), agyModels: 'fail' });
    assert.equal(result.code, 0, result.err);
    const menu = JSON.parse(result.out);
    assert.deepEqual(menu.codex, { status: 'pass-through', reason: null, source: null, efforts: null, models: null });
    assert.equal(menu.agy.status, 'unavailable');
    assert.equal(menu.agy.reason, 'exited 1');
    assert.deepEqual(menu.agy.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(menu['claude-code'], { status: 'pass-through', reason: null, source: null, efforts: null, models: null });
    assert.equal(menu['command-code'].status, 'unavailable');
    assert.equal(menu['command-code'].reason, 'binary not found');
    const single = run(['models', 'agy'], { bin });
    assert.match(single.out, /^agy:\n {2}efforts: low, medium, high, xhigh, max \(agy --help\)\n {2}gemini-3\.8-flash-medium/);
    assert.equal(run(['models', 'nosuch']).code, 2);
    assert.equal(run(['models', 'agy', 'codex']).code, 2);
  });

  console.log(`\n${passed} passed`);
  process.exitCode = 0;
} finally {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(scratch, { recursive: true, force: true });
}
