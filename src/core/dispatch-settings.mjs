import { BACKEND_DEFAULTS, BACKEND_DEFAULTS_WARNINGS } from '../config.mjs';
import { discoverText } from './discovery.mjs';
import { RelayError } from './errors.mjs';

// Config warnings: shape problems found while loading config.json, plus entries naming a
// backend no adapter provides. Dispatch and help print each once.
export function backendConfigWarnings(adapters) {
  const warnings = [...BACKEND_DEFAULTS_WARNINGS];
  for (const name of Object.keys(BACKEND_DEFAULTS)) {
    if (!adapters[name]) {
      warnings.push(`config backends.${name}: no backend named "${name}"; ignoring it`);
    }
  }
  return warnings;
}

export function printBackendConfigWarnings(adapters) {
  for (const warning of backendConfigWarnings(adapters)) console.error(`warning: ${warning}`);
}

// Resolves the model and effort one dispatch will use, highest first:
//   model:  --model, then the adapter's `modelEnvVar` when set and non-empty, then
//           config backends.<name>.model;
//   effort: --effort, then config backends.<name>.effort.
// Anything unresolved stays undefined, so the adapter keeps its own built-in default and
// its argv is unchanged.
export function resolveDispatchSettings(name, adapter, { modelFlag, effortFlag } = {}) {
  const configured = BACKEND_DEFAULTS[name] ?? {};
  let model = modelFlag;
  let modelSource = modelFlag !== undefined ? 'flag' : null;
  const envValue = adapter.modelEnvVar ? process.env[adapter.modelEnvVar] : undefined;
  if (model === undefined && envValue) {
    model = envValue;
    modelSource = 'env';
  }
  if (model === undefined && configured.model !== undefined) {
    model = configured.model;
    modelSource = 'config';
  }
  let effort = effortFlag;
  let effortSource = effortFlag !== undefined ? 'flag' : null;
  if (effort === undefined && configured.effort !== undefined) {
    effort = configured.effort;
    effortSource = 'config';
  }
  return { model, modelSource, effort, effortSource };
}

// Applies an adapter's optional dispatch-time effort hook. The hook may change the model
// (agy swaps an effort-suffixed id), omit the effort argument (`effort: undefined`), drop
// the effort entirely (`dropped: true`), add warnings, or refuse a flag value with a usage
// error (`error`). Discovery it needs is bounded and spawned with the
// scrubbed env; a dry run goes through the same path so the printed argv is the real one.
export async function prepareDispatch(name, adapter, settings) {
  const prepared = {
    model: settings.model,
    effort: settings.effort,
    // The effort recorded for the call: the requested level, even when an adapter
    // expresses it through the model id instead of an --effort argument.
    effortUsed: settings.effort,
  };
  if (settings.effort === undefined || typeof adapter.prepareEffort !== 'function') {
    return prepared;
  }
  const binary = adapter.binaryCandidates?.[0] ?? name;
  const result = await adapter.prepareEffort({
    model: settings.model,
    effort: settings.effort,
    source: settings.effortSource,
    discover: (args) => discoverText(binary, args),
  }) ?? {};
  for (const warning of result.warnings ?? []) console.error(`warning: ${warning}`);
  if (result.error) throw new RelayError('INVALID_EFFORT', result.error, { exitCode: 2 });
  prepared.model = Object.hasOwn(result, 'model') ? result.model : settings.model;
  prepared.effort = Object.hasOwn(result, 'effort') ? result.effort : settings.effort;
  if (result.dropped) prepared.effortUsed = undefined;
  return prepared;
}
