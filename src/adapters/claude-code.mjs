import { ENV_BASE } from '../core/adapter-env.mjs';
import { parseJsonResult } from '../core/parse-json-result.mjs';

export default {
  name: 'claude-code',
  order: 30,
  binaryCandidates: ['claude'],
  installHint: 'npm install -g @anthropic-ai/claude-code, then run: claude (once, to authenticate)',
  fresh: (prompt) => [
    'claude', '-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions',
  ],
  resume: (id, prompt) => [
    'claude', '-r', id, '-p', prompt, '--output-format', 'json',
    '--dangerously-skip-permissions',
  ],
  env: ENV_BASE,
  parse: (stdout) => parseJsonResult(stdout, { id: 'session_id', answer: 'result' }),
  checkCompaction: () => null,
};
