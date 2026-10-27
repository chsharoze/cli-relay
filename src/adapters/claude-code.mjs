import { ENV_BASE } from '../core/adapter-env.mjs';
import { parseEffortHelp } from '../core/effort.mjs';
import { parseJsonResult } from '../core/parse-json-result.mjs';

export default {
  name: 'claude-code',
  order: 30,
  binaryCandidates: ['claude'],
  installHint: 'npm install -g @anthropic-ai/claude-code, then run: claude (once, to authenticate)',
  fresh: (prompt, model, _mode, effort) => [
    'claude', '-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
  ],
  resume: (id, prompt, model, _mode, effort) => [
    'claude', '-r', id, '-p', prompt, '--output-format', 'json',
    '--dangerously-skip-permissions',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
  ],
  // claude validates --effort itself at dispatch; its help text is read only by
  // `cli-relay models`.
  async efforts({ help }) {
    const levels = parseEffortHelp(await help());
    return { levels, perModel: null, source: levels ? 'claude --help' : null };
  },
  env: [...ENV_BASE, 'CLAUDE_CODE_OAUTH_TOKEN'],
  parse: (stdout) => parseJsonResult(stdout, { id: 'session_id', answer: 'result' }),
  checkCompaction: () => null,
};
