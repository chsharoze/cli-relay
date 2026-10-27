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

// The effort suffix an agy model id carries (`gemini-3.8-flash-medium` -> `medium`), or null.
export function agyModelEffort(modelId) {
  return EFFORT_SUFFIXES.find((suffix) => modelId.endsWith(`-${suffix}`)) ?? null;
}

// agy model ids embed their effort as a suffix (`gemini-3.8-flash-medium`) and agy also
// accepts `--effort`, but rejects a suffixed id combined with a different --effort. So a
// suffixed id is never sent together with --effort. Given the model id the call would use,
// the requested level, where the level came from ('flag' or 'config') and the live
// `agy models` ids (null when the listing was unavailable):
// - no effort suffix: keep the id and add --effort;
// - suffix already equals the level: keep the id, no --effort (needs no listing);
// - listing unavailable: swap the suffix blind, no --effort, and warn;
// - swapped id listed: use it, no --effort;
// - swapped id not listed: a flag level is a usage error naming the levels that model
//   family lists; a config level is dropped with a warning and the id kept.
// Returns `{ model, effort, warning, error, dropped }`; `effort` undefined means no
// --effort argument.
export function agyEffortModel(modelId, level, listedIds, source = 'flag') {
  const suffix = agyModelEffort(modelId);
  if (!suffix) return { model: modelId, effort: level };
  if (suffix === level) return { model: modelId, effort: undefined };
  const prefix = modelId.slice(0, -suffix.length);
  const swapped = `${prefix}${level}`;
  if (!listedIds) {
    return {
      model: swapped,
      effort: undefined,
      warning: `agy model listing unavailable; using "${swapped}" without checking that agy lists it`,
    };
  }
  if (listedIds.includes(swapped)) return { model: swapped, effort: undefined };
  const familyLevels = listedIds
    .filter((id) => id.startsWith(prefix))
    .map((id) => id.slice(prefix.length))
    .filter((tail) => EFFORT_SUFFIXES.includes(tail));
  const family = `${prefix.slice(0, -1)}-*`;
  const message = `agy lists no model "${swapped}" — ${family} is listed with ` +
    (familyLevels.length > 0 ? `efforts: ${familyLevels.join(', ')}` : 'no effort variants');
  if (source === 'flag') return { model: modelId, error: message };
  return {
    model: modelId,
    effort: undefined,
    dropped: true,
    warning: `${message}; ignoring the configured effort and keeping "${modelId}"`,
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
  modelEffort: agyModelEffort,
  async prepareEffort({ model, effort, source, discover }) {
    const modelId = model ?? DEFAULT_MODEL;
    const suffix = agyModelEffort(modelId);
    // The listing is only needed to check a swap; an unsuffixed id or an id already at
    // the requested level spawns nothing.
    const listing = suffix && suffix !== effort ? await discover(['models']) : null;
    const decision = agyEffortModel(
      modelId, effort, listing == null ? null : parseAgyModels(listing), source,
    );
    return {
      // Keep an unset model unset unless the rule chose a different id, so the adapter's
      // own default stays the one in the argv.
      model: decision.model === modelId && model === undefined ? undefined : decision.model,
      effort: decision.effort,
      dropped: decision.dropped === true,
      error: decision.error ?? null,
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
