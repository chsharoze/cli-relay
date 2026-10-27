import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ENV_BASE } from '../core/adapter-env.mjs';
import { isEffortLevel } from '../core/effort.mjs';

const DEFAULT_MODEL = 'gpt-6.1-sol';

// Both `codex exec` and `codex exec resume` accept `-c key=value` config overrides.
const effortArgs = (effort) => (effort ? ['-c', `model_reasoning_effort=${effort}`] : []);

export function codexModelsCachePath() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  return join(codexHome, 'models_cache.json');
}

function displayPath(path) {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function effortName(level) {
  if (typeof level === 'string') return level;
  if (level && typeof level === 'object') return level.effort ?? level.level ?? level.name;
  return undefined;
}

// codex keeps an undocumented local cache of the models it offers, including each model's
// supported reasoning levels. Parse it defensively: a top-level array or `{ models: [...] }`,
// entries that are plain slugs or objects, and any field possibly missing or malformed.
// Returns `{ "<slug>": { levels: [..] | null, defaultEffort: string | null } }`, or null
// when nothing usable is found.
export function parseCodexModelsCache(raw) {
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.models) ? raw.models : null);
  if (!list) return null;
  const models = Object.create(null);
  for (const entry of list) {
    const slug = typeof entry === 'string'
      ? entry
      : (entry && typeof entry === 'object' ? (entry.slug ?? entry.id ?? entry.model) : undefined);
    if (typeof slug !== 'string' || !slug.trim() || slug in models) continue;
    let levels = null;
    let defaultEffort = null;
    if (entry && typeof entry === 'object') {
      if (Array.isArray(entry.supported_reasoning_levels)) {
        const names = entry.supported_reasoning_levels.map(effortName).filter(isEffortLevel);
        levels = names.length > 0 ? [...new Set(names)] : null;
      }
      if (isEffortLevel(entry.default_reasoning_level)) defaultEffort = entry.default_reasoning_level;
    }
    models[slug] = { levels, defaultEffort };
  }
  return Object.keys(models).length > 0 ? { ...models } : null;
}

export function readCodexModelsCache(path = codexModelsCachePath()) {
  try {
    return parseCodexModelsCache(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

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
  defaultModel: DEFAULT_MODEL,
  // Dispatch-time effort check against the local model cache only — never a spawn. A slug
  // missing from the cache, or no readable cache, passes the level through unchecked.
  prepareEffort({ model, effort, source }) {
    const slug = model ?? DEFAULT_MODEL;
    const levels = readCodexModelsCache()?.[slug]?.levels;
    if (!levels || levels.includes(effort)) return { model, effort };
    const message = `effort "${effort}" is not supported by codex model "${slug}" — ` +
      `choose one of: ${levels.join(', ')}`;
    if (source === 'flag') return { model, error: message };
    return {
      model,
      effort: undefined,
      dropped: true,
      warnings: [`${message}; ignoring the configured effort`],
    };
  },
  efforts() {
    const perModel = readCodexModelsCache();
    return {
      levels: null,
      perModel,
      source: perModel ? `codex model cache (${displayPath(codexModelsCachePath())})` : null,
    };
  },
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
