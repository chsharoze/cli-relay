import { EXPECTED_BACKENDS } from '../adapter-loader.mjs';
import { discover, discoverText, runListing } from '../core/discovery.mjs';
import { RelayError } from '../core/errors.mjs';
import { parseModelListing } from '../core/model-listing.mjs';
import { realWhichCheck, resolveBinaryName } from './doctor.mjs';

// Each adapter either exposes a native listing command (agy: `models`, command-code:
// `--list-models`) or accepts any model name with no way to enumerate them (codex,
// claude-code). The spawn and the listing parser live in core/ so adapters can use them;
// both are re-exported here because existing callers import them from this module.
export { parseModelListing, runListing };

// Runs a backend's own listing command. Returns a discriminated result so callers can
// format it (cmdModels) or turn it into candidates (pick) without re-implementing binary
// resolution or the spawn. `kind` is one of:
//   'no-listing'  — backend accepts any model name and exposes no listing command
//   'unavailable' — the backend's binary could not be resolved or failed to spawn
//   'listing'     — raw stdout/stderr and exit code from the listing command
export async function listBackendModels(name, adapter, isAvailable = realWhichCheck) {
  if (!adapter.listModels) return { kind: 'no-listing' };
  const binary = await resolveBinaryName(adapter.binaryCandidates ?? [name], isAvailable);
  if (!binary) return { kind: 'unavailable', reason: 'binary not found' };
  const result = await runListing(binary, adapter.listModels());
  if (result.error) return { kind: 'unavailable', reason: result.error.message };
  return { kind: 'listing', out: result.out, err: result.err, code: result.code };
}

function unknownBackend(name, adapters) {
  return new RelayError(
    'BACKEND_NOT_FOUND',
    `unknown backend "${name}" — choose one of: ${Object.keys(adapters).join(', ')}`,
    { exitCode: 2 },
  );
}

// Builds one backend's menu entry from live discovery: its model listing (when it has a
// listing command) and its optional efforts() hook. Every spawn here is bounded and only
// reads listings or help text. Shape: { status, reason, source, efforts, models }.
export async function describeBackend(name, adapter, isAvailable = realWhichCheck) {
  let binaryPromise = null;
  const binary = () => {
    binaryPromise ??= resolveBinaryName(adapter.binaryCandidates ?? [name], isAvailable);
    return binaryPromise;
  };
  const help = async () => {
    const resolved = await binary();
    return resolved ? discoverText(resolved, ['--help'], { includeStderr: true }) : null;
  };
  const listing = async () => {
    if (!adapter.listModels) return null;
    const resolved = await binary();
    if (!resolved) return { reason: 'binary not found' };
    const result = await discover(resolved, adapter.listModels());
    if (result.text == null) return { reason: result.reason };
    return { ids: (adapter.parseModels ?? parseModelListing)(result.text) };
  };
  const efforts = async () => {
    if (typeof adapter.efforts !== 'function') return null;
    try {
      return await adapter.efforts({ help });
    } catch (error) {
      console.error(`warning: ${name} effort discovery failed (${error.message})`);
      return null;
    }
  };
  const [listed, effortInfo] = await Promise.all([listing(), efforts()]);
  const perModel = effortInfo?.perModel ?? null;
  const modelEntry = (id) => ({
    id,
    efforts: perModel?.[id]?.levels ?? null,
    defaultEffort: perModel?.[id]?.defaultEffort ?? null,
  });
  const entry = {
    status: 'pass-through',
    reason: null,
    source: effortInfo?.source ?? null,
    efforts: effortInfo?.levels ?? null,
    models: null,
  };
  if (listed?.ids) {
    entry.status = 'listing';
    entry.models = listed.ids.map(modelEntry);
  } else if (listed) {
    entry.status = 'unavailable';
    entry.reason = listed.reason;
  } else if (perModel) {
    // No listing command, but the effort source names the models (codex's cache).
    entry.status = 'listing';
    entry.models = Object.keys(perModel).map(modelEntry);
  }
  return entry;
}

function formatEfforts(entry) {
  if (entry.efforts) {
    return `efforts: ${entry.efforts.join(', ')}${entry.source ? ` (${entry.source})` : ''}`;
  }
  if (entry.models?.some((model) => model.efforts)) {
    return `efforts: per model${entry.source ? ` (${entry.source})` : ''}`;
  }
  return `efforts: ${entry.source ?? 'unknown — passed through to the backend'}`;
}

function formatBackend(name, entry) {
  const lines = [];
  if (entry.status === 'pass-through') {
    lines.push(
      `${name}: pass-through — any model name accepted by the backend (no listing command)`,
    );
  } else if (entry.status === 'unavailable') {
    lines.push(`${name}: unavailable (${entry.reason})`);
  } else {
    lines.push(`${name}:`);
  }
  lines.push(`  ${formatEfforts(entry)}`);
  for (const model of entry.models ?? []) {
    const details = [];
    if (model.efforts) details.push(`efforts: ${model.efforts.join(', ')}`);
    if (model.defaultEffort) details.push(`default: ${model.defaultEffort}`);
    lines.push(`  ${model.id}${details.length > 0 ? `  (${details.join('; ')})` : ''}`);
  }
  return lines.join('\n');
}

export async function cmdModels(adapters, args = [], isAvailable = realWhichCheck) {
  const list = Array.isArray(args) ? args : [args].filter(Boolean);
  const json = list.includes('--json');
  const positional = list.filter((arg) => arg !== '--json');
  if (positional.length > 1 || positional.some((arg) => arg.startsWith('-'))) {
    throw new RelayError('USAGE', 'usage: cli-relay models [backend] [--json]', { exitCode: 2 });
  }
  const names = positional.length === 1 ? positional : EXPECTED_BACKENDS;
  for (const name of names) {
    if (!adapters[name]) throw unknownBackend(name, adapters);
  }
  const entries = await Promise.all(
    names.map((name) => describeBackend(name, adapters[name], isAvailable)),
  );
  if (json) {
    const menu = {};
    names.forEach((name, index) => { menu[name] = entries[index]; });
    console.log(JSON.stringify(menu, null, 2));
    return;
  }
  names.forEach((name, index) => console.log(formatBackend(name, entries[index])));
}
