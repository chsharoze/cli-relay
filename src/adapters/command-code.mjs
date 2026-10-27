import { ENV_BASE } from '../core/adapter-env.mjs';
import { parseModelListing } from '../core/model-listing.mjs';
import { parseJsonResult } from '../core/parse-json-result.mjs';

// --trust alone only skips the initial "trust this project" prompt — it does NOT bypass
// per-tool-call permission checks in headless `-p` mode, so every file read/write silently
// gets `permission_denied` while the process still exits 0 (confirmed 2026-09-11).
// --yolo is required for any task that needs real file access. Model is
// overridable via CLI_RELAY_COMMAND_CODE_MODEL since command-code routes 68 models and
// different threads legitimately want different ones (default kept as the prior hardcoded
// zai-org/glm-5.2 so existing threads are unaffected). A per-call --model takes precedence
// over the env override, which in turn takes precedence over the default.
const DEFAULT_MODEL = 'zai-org/glm-5.2';
// Every command-code model id is provider/model; `--list-models` also prints headers such
// as "Available models · 94 models" and group names, which this filters out.
export function parseCommandCodeModels(text) {
  return parseModelListing(text).filter((id) => id.includes('/'));
}

const resolveModel = (model) => model ?? (process.env.CLI_RELAY_COMMAND_CODE_MODEL || DEFAULT_MODEL);

export default {
  name: 'command-code',
  order: 40,
  binaryCandidates: ['command-code'],
  installHint: 'npm install -g command-code, then: command-code login',
  fresh: (prompt, model, _mode, effort) => [
    'command-code', '-p', prompt,
    '-m', resolveModel(model), ...(effort ? ['--effort', effort] : []),
    '--output-format', 'json', '--yolo', '--no-auto-update',
  ],
  // Resume remains deliberately unsupported because the seed turn can disappear silently.
  resume: null,
  listModels: () => ['--list-models'],
  parseModels: parseCommandCodeModels,
  defaultModel: DEFAULT_MODEL,
  modelEnvVar: 'CLI_RELAY_COMMAND_CODE_MODEL',
  // command-code's accepted levels depend on the routed model and its help shows only an
  // example list, so effort is always passed through and its help is never parsed.
  efforts: () => ({ levels: null, perModel: null, source: 'model-dependent, passed through' }),
  env: ENV_BASE,
  parse: (stdout) => parseJsonResult(stdout, { id: 'sessionId', answer: 'finalText' }),
  checkCompaction: (_id, stdout) =>
    stdout.includes('"compaction_start"') || stdout.includes('"compaction_done"'),
};
