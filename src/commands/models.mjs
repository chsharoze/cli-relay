import { spawn } from 'node:child_process';
import { EXPECTED_BACKENDS } from '../adapter-loader.mjs';
import { ENV_BASE } from '../core/adapter-env.mjs';
import { scrubEnv } from '../core/env.mjs';
import { RelayError } from '../core/errors.mjs';
import { realWhichCheck, resolveBinaryName } from './doctor.mjs';

// Each adapter either exposes a native listing command (agy: `models`, command-code:
// `--list-models`) or accepts any model name with no way to enumerate them (codex,
// claude-code). The output format of a listing command is backend-owned and not parsed
// here — it is echoed raw so it can't drift out of sync with the backend.
export function runListing(binary, args) {
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

// Model names are extracted one per non-empty line: strip common list markers and an
// optional description column, drop section headers (trailing ":"), and de-duplicate.
// Listing formats are backend-owned, so this is a permissive best-effort parse.
export function parseModelListing(text) {
  const names = [];
  const seen = new Set();
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim();
    if (!line || line.endsWith(':')) continue;
    line = line.replace(/^[-*•]\s+/, '');
    const token = line.split(/\s+/)[0];
    if (!token || !/[A-Za-z]/.test(token) || seen.has(token)) continue;
    seen.add(token);
    names.push(token);
  }
  return names;
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
    const result = await listBackendModels(name, adapter);
    if (result.kind === 'no-listing') {
      console.log(
        `${name}: pass-through — any model name accepted by the backend (no listing command)`,
      );
      continue;
    }
    if (result.kind === 'unavailable') {
      console.log(`${name}: unavailable (${result.reason})`);
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
