import { ENV_BASE } from '../core/adapter-env.mjs';
import { EFFORT_SUFFIXES, parseEffortHelp } from '../core/effort.mjs';
import { parseModelListing } from '../core/model-listing.mjs';
import { parseJsonResult } from '../core/parse-json-result.mjs';

const DEFAULT_MODEL = 'gemini-3.8-flash-medium';

// `agy models` prints a progress line before its `id<TAB>Display name` rows.
export function parseAgyModels(text) {
  return parseModelListing(
    text.split('\n').filter((line) => !/^\s*Fetching\b/i.test(line)).join('\n'),
  );
}

// agy model ids embed their effort as a suffix (`gemini-3.8-flash-medium`) and agy also
// accepts `--effort`. Given the model id the call would use, the requested level and the
// live `agy models` ids (null when the listing was unavailable), decide what to pass:
// - an id with an effort suffix whose swapped-suffix sibling is listed: use that id, no
//   --effort;
// - an id with an effort suffix whose sibling is not listed: keep the id, add --effort,
//   and warn;
// - listing unavailable: keep the id and add --effort (the discovery already warned);
// - an id without an effort suffix: keep the id and add --effort.
// Returns `{ model, effort, warning }`; `effort` undefined means no --effort argument.
export function agyEffortModel(modelId, level, listedIds) {
  const suffix = EFFORT_SUFFIXES.find((candidate) => modelId.endsWith(`-${candidate}`));
  if (!suffix || !listedIds) return { model: modelId, effort: level, warning: null };
  const swapped = `${modelId.slice(0, -suffix.length)}${level}`;
  if (listedIds.includes(swapped)) return { model: swapped, effort: undefined, warning: null };
  return {
    model: modelId,
    effort: level,
    warning: `agy lists no model "${swapped}"; keeping "${modelId}" and passing --effort ${level}`,
  };
}

export default {
  name: 'agy',
  order: 20,
  binaryCandidates: ['agy'],
  installHint: 'macOS: brew install --cask antigravity-cli — other platforms: https://antigravity.google/product/antigravity-cli',
  fresh: (prompt, model, mode, effort) => [
    'agy', '--dangerously-skip-permissions', '--print-timeout', '10m',
    '--model', model ?? DEFAULT_MODEL, ...(mode ? ['--mode', mode] : []),
    ...(effort ? ['--effort', effort] : []),
    '--add-dir', process.cwd(),
    '--output-format', 'json', '-p', prompt,
  ],
  resume: (id, prompt, model, mode, effort) => [
    'agy', '--dangerously-skip-permissions', '--print-timeout', '10m',
    '--model', model ?? DEFAULT_MODEL, ...(mode ? ['--mode', mode] : []),
    ...(effort ? ['--effort', effort] : []),
    '--add-dir', process.cwd(),
    '--output-format', 'json', '--conversation', id, '-p', prompt,
  ],
  listModels: () => ['models'],
  parseModels: parseAgyModels,
  defaultModel: DEFAULT_MODEL,
  async prepareEffort({ model, effort, discover }) {
    const modelId = model ?? DEFAULT_MODEL;
    const hasSuffix = EFFORT_SUFFIXES.some((suffix) => modelId.endsWith(`-${suffix}`));
    const listing = hasSuffix ? await discover(['models']) : null;
    const decision = agyEffortModel(modelId, effort, listing == null ? null : parseAgyModels(listing));
    return {
      // Keep an unset model unset unless the rule chose a different id, so the adapter's
      // own default stays the one in the argv.
      model: decision.model === modelId && model === undefined ? undefined : decision.model,
      effort: decision.effort,
      warnings: decision.warning ? [decision.warning] : [],
    };
  },
  async efforts({ help }) {
    const text = await help();
    const levels = parseEffortHelp(text);
    return { levels, perModel: null, source: levels ? 'agy --help' : null };
  },
  env: ENV_BASE,
  parse: (stdout) => parseJsonResult(stdout, { id: 'conversation_id', answer: 'response' }),
  classifyFailure(out, err) {
    // The marker is only an error when it leads a trimmed line; a line that merely
    // mentions "AGY_ERROR:" in passing (for example inside an answer) is not a failure.
    return [...out.split('\n'), ...err.split('\n')]
      .some((line) => line.trim().startsWith('AGY_ERROR:'));
  },
  checkCompaction: () => null,
};
