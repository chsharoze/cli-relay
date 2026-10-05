import { spawn } from 'node:child_process';
import { EXPECTED_BACKENDS } from '../adapter-loader.mjs';
import { ENV_BASE } from '../core/adapter-env.mjs';
import { scrubEnv } from '../core/env.mjs';
import { RelayError } from '../core/errors.mjs';
import { resolveBinaryName } from './doctor.mjs';

// Each adapter either exposes a native listing command (agy: `models`, command-code:
// `--list-models`) or accepts any model name with no way to enumerate them (codex,
// claude-code). The output format of a listing command is backend-owned and not parsed
// here — it is echoed raw so it can't drift out of sync with the backend.
function runListing(binary, args) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      env: scrubEnv(ENV_BASE),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => resolve({ error }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

export async function cmdModels(adapters, backend) {
  const names = backend ? [backend] : EXPECTED_BACKENDS;
  for (const name of names) {
    const adapter = adapters[name];
    if (!adapter) {
      throw new RelayError(
        'BACKEND_NOT_FOUND',
        `unknown backend "${name}" — choose one of: ${Object.keys(adapters).join(', ')}`,
        { exitCode: 2 },
      );
    }
    if (!adapter.listModels) {
      console.log(
        `${name}: pass-through — any model name accepted by the backend (no listing command)`,
      );
      continue;
    }
    const binary = await resolveBinaryName(adapter.binaryCandidates ?? [name]);
    if (!binary) {
      console.log(`${name}: unavailable (binary not found)`);
      continue;
    }
    const result = await runListing(binary, adapter.listModels());
    if (result.error) {
      console.log(`${name}: unavailable (${result.error.message})`);
      continue;
    }
    console.log(`${name}:`);
    if (result.out) {
      process.stdout.write(result.out.endsWith('\n') ? result.out : `${result.out}\n`);
    }
    if (result.code !== 0 && result.err) {
      process.stderr.write(result.err.endsWith('\n') ? result.err : `${result.err}\n`);
    }
  }
}
