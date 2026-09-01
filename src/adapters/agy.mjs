import { ENV_BASE } from '../core/adapter-env.mjs';
import { parseJsonResult } from '../core/parse-json-result.mjs';

export default {
  name: 'agy',
  order: 20,
  binaryCandidates: ['agy'],
  fresh: (prompt) => [
    'agy', '--dangerously-skip-permissions', '--print-timeout', '10m',
    '--model', 'gemini-3.6-flash-medium', '--add-dir', process.cwd(),
    '--output-format', 'json', '-p', prompt,
  ],
  resume: (id, prompt) => [
    'agy', '--dangerously-skip-permissions', '--print-timeout', '10m',
    '--model', 'gemini-3.6-flash-medium', '--add-dir', process.cwd(),
    '--output-format', 'json', '--conversation', id, '-p', prompt,
  ],
  env: ENV_BASE,
  parse: (stdout) => parseJsonResult(stdout, { id: 'conversation_id', answer: 'response' }),
  checkCompaction: () => null,
};
