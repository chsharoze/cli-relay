import { spawn } from 'node:child_process';

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

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const check = checks[index];
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
    } else {
      console.log(`${check.adapter.name}: unavailable (not found; tried: ${tried})`);
    }
  }
}
