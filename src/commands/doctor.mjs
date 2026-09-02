import { spawn } from 'node:child_process';
import { EXPECTED_BACKENDS } from '../adapter-loader.mjs';

const REQUIRED_BACKEND_SET = new Set(EXPECTED_BACKENDS);

export function realWhichCheck(binary) {
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(command, [binary], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

export async function resolveBinaryName(candidates, isAvailable = realWhichCheck) {
  for (const candidate of candidates) {
    if (await isAvailable(candidate)) return candidate;
  }
  return null;
}

function binaryCandidates(adapter) {
  if (adapter.binaryCandidates) return adapter.binaryCandidates;
  const generated = adapter.fresh('');
  return generated.length > 0 ? [generated[0]] : [];
}

export async function cmdDoctor(adapters, isAvailable = realWhichCheck) {
  const checks = Object.values(adapters).map((adapter) => ({
    adapter,
    candidates: binaryCandidates(adapter),
    attempted: [],
  }));
  const results = await Promise.allSettled(checks.map(async (check) => {
    const resolved = await resolveBinaryName(check.candidates, async (candidate) => {
      check.attempted.push(candidate);
      return isAvailable(candidate);
    });
    return resolved;
  }));

  let requiredAvailable = 0;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const check = checks[index];
    const isRequired = REQUIRED_BACKEND_SET.has(check.adapter.name);
    const tried = check.attempted.join(', ') || 'none';
    if (result.status === 'rejected') {
      console.log(
        `${check.adapter.name}: unavailable (check failed; tried: ${tried}; ` +
        `reason: ${result.reason?.message ?? String(result.reason)})`,
      );
      continue;
    }
    const resolved = result.value;
    if (resolved) {
      console.log(
        `${check.adapter.name}: available (found; tried: ${tried}; resolved: ${resolved})`,
      );
      if (isRequired) requiredAvailable += 1;
    } else {
      const hint = check.adapter.installHint ? ` — install: ${check.adapter.installHint}` : '';
      console.log(`${check.adapter.name}: unavailable (not found; tried: ${tried})${hint}`);
    }
  }

  // doctor doubles as a machine-setup gate: the caller (main) exits 1 only when NO backend
  // at all is usable — a genuinely broken install with nothing working. A partial install
  // (1-3 of the four built-in backends present) is the documented normal setup (README,
  // Prerequisites: "you don't need all four") and passes the gate. Custom user adapters are
  // reported in the output above but never affect it — they're optional by definition.
  return requiredAvailable > 0;
}
