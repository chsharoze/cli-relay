import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.mjs';

export const TIER_GATE_CONFIG_PATH = join(STATE_DIR, 'governance', 'tier-gate.json');

export const TIERS = Object.freeze({
  'read-only': 1,
  local: 2,
  'reversible-remote': 3,
  irreversible: 4,
});

const TIER_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(TIERS).map(([name, level]) => [level, name])),
);
const DEFAULT_CONFIRMATION_TIERS = Object.freeze([3, 4]);

export function parseTier(value) {
  if (value == null) return { level: 1, name: TIER_NAMES[1], declared: false };
  const normalized = String(value).trim().toLowerCase();
  const level = /^\d+$/.test(normalized) ? Number(normalized) : TIERS[normalized];
  if (!Number.isInteger(level) || !TIER_NAMES[level]) return null;
  return { level, name: TIER_NAMES[level], declared: true };
}

function validateConfig(raw, configPath) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${configPath} must contain a JSON object`);
  }
  if (raw.version != null && raw.version !== 1) {
    throw new Error(`${configPath}: version must be 1`);
  }
  const tiers = raw.confirmationRequiredTiers;
  if (!Array.isArray(tiers) || tiers.length === 0 ||
      tiers.some((tier) => !Number.isInteger(tier) || !TIER_NAMES[tier])) {
    throw new Error(
      `${configPath}: confirmationRequiredTiers must be a non-empty array of tiers 1-4`,
    );
  }
  const unique = [...new Set(tiers)].sort((left, right) => left - right);
  if (unique.length !== 2 || unique[0] !== 3 || unique[1] !== 4) {
    throw new Error(
      `${configPath}: confirmationRequiredTiers must be exactly [3, 4]`,
    );
  }
  return Object.freeze({ confirmationRequiredTiers: Object.freeze(unique) });
}

function defaultPolicy() {
  return Object.freeze({ confirmationRequiredTiers: DEFAULT_CONFIRMATION_TIERS });
}

// This loader owns every failure from this policy's optional config. A malformed
// tier-gate file is visible, but it cannot abort adapter loading, housekeeping,
// ledger verification, or a dispatch. The fallback is the built-in safe policy,
// so a bad override cannot silently remove the tier 3/4 confirmation requirement.
export function loadTierGate({
  configPath = TIER_GATE_CONFIG_PATH,
  warn = (message) => console.error(message),
} = {}) {
  let policy = defaultPolicy();
  let configStatus = 'default';
  let configError = null;

  if (existsSync(configPath)) {
    try {
      policy = validateConfig(JSON.parse(readFileSync(configPath, 'utf8')), configPath);
      configStatus = 'loaded';
    } catch (error) {
      configStatus = 'invalid';
      configError = error?.message ?? String(error);
      try {
        warn(
          `warning: tier-gate config failed to load (${configError}); ` +
          'using the built-in policy for this module',
        );
      } catch {
        // A diagnostic callback must not turn an isolated policy failure into a CLI failure.
      }
    }
  }

  return Object.freeze({
    configStatus,
    configError,
    evaluate(tier, confirmed) {
      const requiresConfirmation = policy.confirmationRequiredTiers.includes(tier.level);
      const allowed = !requiresConfirmation || confirmed === true;
      return Object.freeze({
        allowed,
        tier,
        confirmationProvided: confirmed === true,
        confirmationRequired: requiresConfirmation,
        reason: allowed
          ? null
          : `tier ${tier.level} (${tier.name}) requires an explicit --confirm flag`,
      });
    },
  });
}
