import { ENV_BASE } from '../core/adapter-env.mjs';
import { parseJsonResult } from '../core/parse-json-result.mjs';

const DEFAULT_MODEL = 'gemini-3.8-flash-medium';

export default {
  name: 'agy',
  order: 20,
  binaryCandidates: ['agy'],
  installHint: 'macOS: brew install --cask antigravity-cli — other platforms: https://antigravity.google/product/antigravity-cli',
  fresh: (prompt, model) => [
    'agy', '--dangerously-skip-permissions', '--print-timeout', '10m',
    '--model', model ?? DEFAULT_MODEL, '--add-dir', process.cwd(),
    '--output-format', 'json', '-p', prompt,
  ],
  resume: (id, prompt, model) => [
    'agy', '--dangerously-skip-permissions', '--print-timeout', '10m',
    '--model', model ?? DEFAULT_MODEL, '--add-dir', process.cwd(),
    '--output-format', 'json', '--conversation', id, '-p', prompt,
  ],
  listModels: () => ['models'],
  env: ENV_BASE,
  parse: (stdout) => parseJsonResult(stdout, { id: 'conversation_id', answer: 'response' }),
  checkCompaction: () => null,
};
