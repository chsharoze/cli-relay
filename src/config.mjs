import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = homedir();

export const STATE_DIR = join(home, '.cli-relay');
export const CONFIG_PATH = join(STATE_DIR, 'config.json');
export const MAP_VERSION = 1;

export const DEFAULTS = Object.freeze({
  MAP_PATH: join(STATE_DIR, 'sessions.json'),
  USER_ADAPTERS_DIR: join(STATE_DIR, 'adapters'),
  SPAWN_TIMEOUT_MS: 20 * 60_000,
  SPAWN_KILL_GRACE_MS: 3_000,
  LOCK_TIMEOUT_MS: 10_000,
  LOCK_RETRY_MS: 100,
  LOCK_STALE_GRACE_MS: 60_000,
  RESUME_FAILURE_THRESHOLD: 3,
  RESUME_WARNING_THRESHOLD: 10,
  PIN_WARNING_THRESHOLD: 8,
  MAX_PIN_LENGTH: 500,
});

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

function camelCase(name) {
  return name.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function configuredValue(raw, name) {
  return raw[name] ?? raw[camelCase(name)] ?? DEFAULTS[name];
}

function expandHome(value) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return value;
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${CONFIG_PATH} must contain a JSON object`);
  }

  const merged = Object.fromEntries(
    Object.keys(DEFAULTS).map((name) => [name, configuredValue(raw, name)]),
  );
  for (const name of ['MAP_PATH', 'USER_ADAPTERS_DIR']) {
    if (typeof merged[name] !== 'string' || !merged[name]) {
      throw new Error(`${CONFIG_PATH}: ${name} must be a non-empty string`);
    }
    merged[name] = expandHome(merged[name]);
  }
  for (const name of Object.keys(DEFAULTS).filter((key) => typeof DEFAULTS[key] === 'number')) {
    if (!Number.isFinite(merged[name]) || merged[name] < 0) {
      throw new Error(`${CONFIG_PATH}: ${name} must be a non-negative number`);
    }
  }
  return merged;
}

export const CONFIG = Object.freeze(loadConfig());

export const {
  MAP_PATH,
  USER_ADAPTERS_DIR,
  SPAWN_TIMEOUT_MS,
  SPAWN_KILL_GRACE_MS,
  LOCK_TIMEOUT_MS,
  LOCK_RETRY_MS,
  LOCK_STALE_GRACE_MS,
  RESUME_FAILURE_THRESHOLD,
  RESUME_WARNING_THRESHOLD,
  PIN_WARNING_THRESHOLD,
  MAX_PIN_LENGTH,
} = CONFIG;

// These must follow the configured base values. They are intentionally not independently
// configurable, so a map or timeout override cannot leave its related safety value behind.
export const LOCK_PATH = `${MAP_PATH}.lock`;
export const LOCK_STALE_MS = SPAWN_TIMEOUT_MS + LOCK_STALE_GRACE_MS;
