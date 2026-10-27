import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = homedir();

export const STATE_DIR = join(home, '.cli-relay');
export const CONFIG_PATH = join(STATE_DIR, 'config.json');
export const MAP_VERSION = 1;

export const DEFAULTS = Object.freeze({
  MAP_PATH: join(STATE_DIR, 'sessions.json'),
  LEDGER_PATH: join(STATE_DIR, 'ledger.jsonl'),
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

function readRawConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

function loadConfig(raw) {
  if (raw === null) return { ...DEFAULTS };
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
  // Governance modules own their optional configuration failures. Keep a bad
  // ledger override out of the fatal shared-config path so auditing can warn and
  // fall back without taking down unrelated commands or a backend dispatch.
  if (typeof merged.LEDGER_PATH === 'string' && merged.LEDGER_PATH) {
    merged.LEDGER_PATH = expandHome(merged.LEDGER_PATH);
  }
  for (const name of Object.keys(DEFAULTS).filter((key) => typeof DEFAULTS[key] === 'number')) {
    if (!Number.isFinite(merged[name]) || merged[name] < 0) {
      throw new Error(`${CONFIG_PATH}: ${name} must be a non-negative number`);
    }
  }
  return merged;
}

const RAW_CONFIG = readRawConfig();
export const CONFIG = Object.freeze(loadConfig(RAW_CONFIG));

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

export const LEDGER_PATH_CONFIG_ERROR =
  typeof CONFIG.LEDGER_PATH === 'string' && CONFIG.LEDGER_PATH
    ? null
    : `${CONFIG_PATH}: LEDGER_PATH must be a non-empty string`;
export const LEDGER_PATH = LEDGER_PATH_CONFIG_ERROR
  ? DEFAULTS.LEDGER_PATH
  : CONFIG.LEDGER_PATH;

// These must follow the configured base values. They are intentionally not independently
// configurable, so a map or timeout override cannot leave its related safety value behind.
export const LOCK_PATH = `${MAP_PATH}.lock`;
export const LOCK_STALE_MS = SPAWN_TIMEOUT_MS + LOCK_STALE_GRACE_MS;

// Optional per-backend defaults: { "backends": { "<name>": { "model"?, "effort"? } } }.
// Read outside the throwing validation above, like LEDGER_PATH: a malformed entry or value
// is reported as a warning and ignored, so it can never take down any command. Backend
// names are checked against the loaded adapters where they are used (core/
// dispatch-settings.mjs), since user adapters can add names.
const EFFORT_VALUE = /^[a-z]+$/;

function loadBackendDefaults(raw) {
  const defaults = Object.create(null);
  const warnings = [];
  const backends = raw?.backends;
  if (backends === undefined) return { defaults, warnings };
  if (!backends || typeof backends !== 'object' || Array.isArray(backends)) {
    warnings.push(`${CONFIG_PATH}: backends must be an object; ignoring it`);
    return { defaults, warnings };
  }
  for (const [name, entry] of Object.entries(backends)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`${CONFIG_PATH}: backends.${name} must be an object; ignoring it`);
      continue;
    }
    const accepted = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'model') {
        if (typeof value === 'string' && value.trim() !== '') accepted.model = value;
        else warnings.push(`${CONFIG_PATH}: backends.${name}.model must be a non-empty string; ignoring it`);
      } else if (key === 'effort') {
        if (typeof value === 'string' && EFFORT_VALUE.test(value)) accepted.effort = value;
        else warnings.push(`${CONFIG_PATH}: backends.${name}.effort must match ^[a-z]+$; ignoring it`);
      } else {
        warnings.push(`${CONFIG_PATH}: backends.${name}.${key} is not a known setting; ignoring it`);
      }
    }
    defaults[name] = Object.freeze(accepted);
  }
  return { defaults, warnings };
}

const backendDefaults = loadBackendDefaults(
  RAW_CONFIG && typeof RAW_CONFIG === 'object' && !Array.isArray(RAW_CONFIG) ? RAW_CONFIG : null,
);
export const BACKEND_DEFAULTS = Object.freeze(backendDefaults.defaults);
export const BACKEND_DEFAULTS_WARNINGS = Object.freeze(backendDefaults.warnings);
