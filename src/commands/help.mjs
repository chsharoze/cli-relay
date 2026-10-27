import { EXPECTED_BACKENDS } from '../adapter-loader.mjs';
import { printBackendConfigWarnings, resolveDispatchSettings } from '../core/dispatch-settings.mjs';

export const USAGE_LINES = Object.freeze([
  'cli-relay [--dry-run|--print-command] [--tier <1-4|name>] [--model <name>] ' +
    '[--effort <level>] [--mode <name>] [--confirm] <backend> <thread> <fresh|resume> <prompt...>',
  'cli-relay list',
  'cli-relay doctor',
  'cli-relay models [backend] [--json]',
  "cli-relay pick '<task>'",
  'cli-relay audit verify',
  'cli-relay reset <thread>',
  'cli-relay pin <thread> "<fact>"',
  'cli-relay unpin <thread> <index>',
  'cli-relay pins <thread>',
  'cli-relay loop record <thread> --plan <path> --repo <path> --reviewer <backend> ' +
    '--verdict <APPROVED|REVISE|BLOCKED> --summary "<text>" [--model <model>] [...]',
  'cli-relay loop check <thread> [--plan <path>] [--repo <path>]',
  'cli-relay help | --help | -h',
]);

const FLAG_LINES = Object.freeze([
  ['--model <name>', 'model for this call, passed to the backend verbatim'],
  ['--effort <level>', 'reasoning effort for this call (lowercase letters, e.g. low, high)'],
  ['--mode <name>', 'backend mode for this call, passed through (agy: e.g. plan)'],
  ['--tier <1-4|name>', 'read-only (1, default), local (2), reversible-remote (3), irreversible (4)'],
  ['--confirm', 'required to dispatch at tier 3 or 4'],
  ['--dry-run, --print-command', 'print the argv a real call would spawn; writes no state'],
]);

export const EFFORT_GUIDE = `Choosing an effort (--effort <level>). A starting point, not a rule.
  low     lookups, mechanical edits of any size, answering from text you pass in
  medium  reviews of a known diff, builds against a clear spec that you will review
  high    debugging without a known cause, concurrency, architecture, any change
          whose correctness you cannot check by reading the output, and builds
          nobody will review before they ship
  xhigh+  only after a high run came back shallow or wrong
Higher levels cost time (and money on metered backends); defaults differ per
backend, see the table above. A precise prompt at low beats a vague one at max.
Levels vary by backend and model (\`cli-relay models\`); if a backend rejects a
level, retry without --effort.`;

// The model and effort a call with no --model/--effort would use, and where each comes
// from. Display only: nothing here spawns a backend.
export function effectiveDefaults(name, adapter) {
  const settings = resolveDispatchSettings(name, adapter, {});
  let model;
  if (settings.modelSource === 'env') model = `${settings.model} (env ${adapter.modelEnvVar})`;
  else if (settings.modelSource === 'config') model = `${settings.model} (config)`;
  else model = adapter.defaultModel ? `${adapter.defaultModel} (built-in)` : 'backend default';
  // A model id that embeds its effort (agy's `-medium` suffix) sets the effort itself.
  const modelId = settings.model ?? adapter.defaultModel;
  const embedded = modelId && typeof adapter.modelEffort === 'function'
    ? adapter.modelEffort(modelId)
    : null;
  let effort = 'backend default';
  if (settings.effortSource === 'config') effort = `${settings.effort} (config)`;
  else if (embedded) effort = `${embedded} (model id)`;
  return { model, effort };
}

function pad(text, width) {
  return text.length >= width ? `${text}  ` : text.padEnd(width);
}

export function helpText(adapters) {
  const lines = ['usage:'];
  for (const line of USAGE_LINES) lines.push(`  ${line}`);
  lines.push('', 'dispatch flags (before <fresh|resume>; every later token is prompt text):');
  for (const [flag, text] of FLAG_LINES) lines.push(`  ${pad(flag, 28)}${text}`);

  const names = [
    ...EXPECTED_BACKENDS.filter((name) => adapters[name]),
    ...Object.keys(adapters).filter((name) => !EXPECTED_BACKENDS.includes(name)),
  ];
  const rows = names.map((name) => [name, effectiveDefaults(name, adapters[name])]);
  const modelWidth = Math.max('model'.length, ...rows.map(([, row]) => row.model.length)) + 2;
  lines.push('', 'defaults when a call has no --model/--effort:');
  lines.push(`  ${pad('backend', 14)}${pad('model', modelWidth)}effort`);
  for (const [name, row] of rows) {
    lines.push(`  ${pad(name, 14)}${pad(row.model, modelWidth)}${row.effort}`);
  }
  lines.push('', EFFORT_GUIDE);
  lines.push('', 'Live models and effort levels per backend: cli-relay models [backend] [--json]');
  return lines.join('\n');
}

export function cmdHelp(adapters) {
  printBackendConfigWarnings(adapters);
  console.log(helpText(adapters));
}
