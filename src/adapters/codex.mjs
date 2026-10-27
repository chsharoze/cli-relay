import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ENV_BASE } from '../core/adapter-env.mjs';

const DEFAULT_MODEL = 'gpt-6.1-sol';

// Both `codex exec` and `codex exec resume` accept `-c key=value` config overrides.
const effortArgs = (effort) => (effort ? ['-c', `model_reasoning_effort=${effort}`] : []);

function findRolloutFile(threadId) {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return null;
  try {
    const entries = readdirSync(root, { recursive: true });
    const match = entries.find((entry) =>
      typeof entry === 'string' && entry.includes(threadId) && entry.endsWith('.jsonl'));
    return match ? join(root, match) : null;
  } catch {
    return null;
  }
}

export default {
  name: 'codex',
  order: 10,
  binaryCandidates: ['codex'],
  installHint: 'npm install -g @openai/codex, then: codex login',
  fresh: (prompt, model, _mode, effort) => [
    'codex', 'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write',
    '-m', model ?? DEFAULT_MODEL, ...effortArgs(effort), '--json', prompt,
  ],
  // `codex exec resume` has no --sandbox flag. This is the only confirmed non-interactive
  // path that restores the write access granted to the fresh invocation.
  resume: (id, prompt, model, _mode, effort) => [
    'codex', 'exec', 'resume', id, '--dangerously-bypass-approvals-and-sandbox',
    '-m', model ?? DEFAULT_MODEL, ...effortArgs(effort), '--json', prompt,
  ],
  env: ENV_BASE,
  parse(stdout) {
    let id = null;
    let answer = null;
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'thread.started' && event.thread_id) id = event.thread_id;
      if (event.type === 'item.completed' &&
          event.item?.type === 'agent_message' && event.item.text) {
        answer = event.item.text;
      }
    }
    return { id, answer };
  },
  classifyFailure(out, err) {
    return [...out.split('\n'), ...err.split('\n')]
      .some((line) => line.startsWith('ERROR: {'));
  },
  checkCompaction(id) {
    if (!id) return false;
    const file = findRolloutFile(id);
    if (!file) return false;
    try {
      return readFileSync(file, 'utf8').includes('"context_compacted"');
    } catch {
      return false;
    }
  },
};
