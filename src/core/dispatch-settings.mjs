import { discoverText } from './discovery.mjs';
import { RelayError } from './errors.mjs';

// Resolves the model and effort one dispatch will use. Flag values win; with neither flag
// the model and effort stay undefined so every adapter produces its unchanged argv.
export function resolveDispatchSettings(_name, _adapter, { modelFlag, effortFlag } = {}) {
  return {
    model: modelFlag,
    modelSource: modelFlag !== undefined ? 'flag' : null,
    effort: effortFlag,
    effortSource: effortFlag !== undefined ? 'flag' : null,
  };
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
