import { ENV_BASE } from '../core/adapter-env.mjs';
import { parseJsonResult } from '../core/parse-json-result.mjs';

export default {
  name: 'command-code',
  order: 40,
  binaryCandidates: ['command-code'],
  fresh: (prompt) => [
    'command-code', '-p', prompt, '-m', 'zai-org/glm-5.2', '--output-format', 'json',
    '--trust', '--no-auto-update',
  ],
  // Resume remains deliberately unsupported because the seed turn can disappear silently.
  resume: null,
  env: ENV_BASE,
  parse: (stdout) => parseJsonResult(stdout, { id: 'sessionId', answer: 'finalText' }),
  checkCompaction: (_id, stdout) =>
    stdout.includes('"compaction_start"') || stdout.includes('"compaction_done"'),
};
