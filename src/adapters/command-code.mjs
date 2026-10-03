import { ENV_BASE } from '../core/adapter-env.mjs';
import { parseJsonResult } from '../core/parse-json-result.mjs';

// --trust alone only skips the initial "trust this project" prompt — it does NOT bypass
// per-tool-call permission checks in headless `-p` mode, so every file read/write silently
// gets `permission_denied` while the process still exits 0 (confirmed 2026-09-11, see
// CLAUDE.md). --yolo is required for any task that needs real file access. Model is
// overridable via CLI_RELAY_COMMAND_CODE_MODEL since command-code routes 68 models and
// different threads legitimately want different ones (default kept as the prior hardcoded
// zai-org/glm-5.2 so existing threads are unaffected).
const DEFAULT_MODEL = 'zai-org/glm-5.2';

export default {
  name: 'command-code',
  order: 40,
  binaryCandidates: ['command-code'],
  installHint: 'npm install -g command-code, then: command-code login',
  fresh: (prompt) => [
    'command-code', '-p', prompt,
    '-m', process.env.CLI_RELAY_COMMAND_CODE_MODEL || DEFAULT_MODEL,
    '--output-format', 'json', '--yolo', '--no-auto-update',
  ],
  // Resume remains deliberately unsupported because the seed turn can disappear silently.
  resume: null,
  env: ENV_BASE,
  parse: (stdout) => parseJsonResult(stdout, { id: 'sessionId', answer: 'finalText' }),
  checkCompaction: (_id, stdout) =>
    stdout.includes('"compaction_start"') || stdout.includes('"compaction_done"'),
};
