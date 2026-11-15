import { BACKEND_DEFAULTS, CONFIG_PATH, GLOBAL_MAX_STDOUT_MB } from '../config.mjs';
import { RelayError } from './errors.mjs';

// The most backend stdout one call buffers for parsing. Output beyond it is still
// drained, but the call is refused rather than parsed from truncated text. The cap is
// 256 MiB because output is buffered as one string, which the engine cannot hold much
// beyond that.
export const DEFAULT_MAX_STDOUT_MB = 64;
export const MIN_MAX_STDOUT_MB = 1;
export const MAX_MAX_STDOUT_MB = 256;
export const MAX_STDOUT_ENV = 'CLI_RELAY_MAX_STDOUT_MB';
const MIB = 1024 * 1024;

export const STDOUT_LIMIT_HOW_TO_RAISE =
  `raise it with --max-stdout-mb <n> (before <fresh|resume>), the ${MAX_STDOUT_ENV} ` +
  'environment variable, or "maxStdoutMb" in config.json (top level or under backends.<name>)';

// Accepts a whole number from MIN to MAX, as a number or a plain digit string.
// Anything else is a usage error that names where the value came from.
export function parseMaxStdoutMb(value, source) {
  const text = typeof value === 'number' ? String(value) : value;
  const ok = typeof text === 'string' && /^[0-9]+$/.test(text) &&
    Number(text) >= MIN_MAX_STDOUT_MB && Number(text) <= MAX_MAX_STDOUT_MB;
  if (!ok) {
    throw new RelayError(
      'INVALID_MAX_STDOUT',
      `${source} must be a whole number of MiB from ${MIN_MAX_STDOUT_MB} to ${MAX_MAX_STDOUT_MB}, ` +
      `got ${typeof value === 'string' ? `"${value}"` : JSON.stringify(value)}`,
      { exitCode: 2 },
    );
  }
  return Number(text);
}

// Highest first: --max-stdout-mb, the environment variable, config backends.<name>,
// config top level, then the default. A present but invalid value is an error, never
// skipped in favour of a lower source. An empty or whitespace-only environment value and a
// null config value count as unset.
export function resolveMaxStdout(backend, { flagValue, env = process.env } = {}) {
  let mb;
  let source;
  if (flagValue !== undefined) {
    mb = parseMaxStdoutMb(flagValue, '--max-stdout-mb');
    source = 'flag';
  } else if (env[MAX_STDOUT_ENV] !== undefined && env[MAX_STDOUT_ENV].trim() !== '') {
    mb = parseMaxStdoutMb(env[MAX_STDOUT_ENV].trim(), MAX_STDOUT_ENV);
    source = 'env';
  } else if (BACKEND_DEFAULTS[backend]?.maxStdoutMb != null) {
    mb = parseMaxStdoutMb(BACKEND_DEFAULTS[backend].maxStdoutMb,
      `${CONFIG_PATH}: backends.${backend}.maxStdoutMb`);
    source = 'config';
  } else if (GLOBAL_MAX_STDOUT_MB != null) {
    mb = parseMaxStdoutMb(GLOBAL_MAX_STDOUT_MB, `${CONFIG_PATH}: maxStdoutMb`);
    source = 'config';
  } else {
    mb = DEFAULT_MAX_STDOUT_MB;
    source = 'default';
  }
  return { mb, bytes: mb * MIB, source };
}

// Display text for `help`; never throws on a bad value.
export function describeMaxStdout(backend) {
  try {
    const { mb, source } = resolveMaxStdout(backend);
    return `${mb} MiB (${source === 'default' ? 'built-in' : source})`;
  } catch (error) {
    return `invalid (${error.message})`;
  }
}
