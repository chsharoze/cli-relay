import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { USER_ADAPTERS_DIR } from './config.mjs';

const BUILTIN_ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'adapters');
const SUPPORTED_EXTENSIONS = new Set(['.mjs', '.js', '.cjs']);
export const EXPECTED_BACKENDS = Object.freeze([
  'codex',
  'agy',
  'claude-code',
  'command-code',
]);
const EXPECTED_BACKEND_SET = new Set(EXPECTED_BACKENDS);

function adapterFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) =>
      (entry.isFile() || entry.isSymbolicLink()) && SUPPORTED_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => join(directory, entry.name))
    .sort();
}

function validateAdapter(adapter, sourcePath) {
  const fallbackName = basename(sourcePath, extname(sourcePath));
  const name = adapter?.name ?? fallbackName;
  if (!adapter || typeof adapter !== 'object') {
    throw new Error(`adapter ${sourcePath} must export an adapter object as default`);
  }
  if (!name || typeof name !== 'string') {
    throw new Error(`adapter ${sourcePath} must have a string name`);
  }
  if (typeof adapter.fresh !== 'function') {
    throw new Error(`adapter "${name}" (${sourcePath}) must provide fresh(prompt)`);
  }
  const resume = adapter.resume ?? null;
  if (resume !== null && typeof resume !== 'function') {
    throw new Error(`adapter "${name}" (${sourcePath}) resume must be a function or null`);
  }
  if (!Array.isArray(adapter.env)) {
    throw new Error(`adapter "${name}" (${sourcePath}) must provide an env array`);
  }
  if (typeof adapter.parse !== 'function') {
    throw new Error(`adapter "${name}" (${sourcePath}) must provide parse(stdout)`);
  }
  if (adapter.checkCompaction != null && typeof adapter.checkCompaction !== 'function') {
    throw new Error(`adapter "${name}" (${sourcePath}) checkCompaction must be a function`);
  }
  if (adapter.binaryCandidates != null &&
      (!Array.isArray(adapter.binaryCandidates) || adapter.binaryCandidates.length === 0 ||
       adapter.binaryCandidates.some((candidate) => typeof candidate !== 'string' || !candidate))) {
    throw new Error(
      `adapter "${name}" (${sourcePath}) binaryCandidates must be a non-empty string array`,
    );
  }
  return {
    ...adapter,
    name,
    resume,
    checkCompaction: adapter.checkCompaction ?? (() => null),
  };
}

async function loadDirectory(directory, adapters, registryIssues) {
  const loadedAdapters = [];
  for (const file of adapterFiles(directory)) {
    const fallbackName = basename(file, extname(file));
    let suspectedName = fallbackName;
    try {
      const loaded = await import(pathToFileURL(file).href);
      const exported = loaded.default ?? loaded.adapter;
      if (typeof exported?.name === 'string') suspectedName = exported.name;
      const adapter = validateAdapter(exported, file);
      registryIssues.delete(adapter.name);
      loadedAdapters.push(adapter);
    } catch (error) {
      // Any adapter file's load/validation failure is recorded, not fatal — a broken
      // built-in-name override is what assertAdapterRegistry's completeness check reports;
      // a broken CUSTOM-named user adapter isn't one of the 4 required backends, so it's
      // not blocking by definition, but it was previously re-thrown here and crashed the
      // entire load anyway — taking down `doctor`, the one command you'd reach for to
      // diagnose exactly this, along with every other backend (found in review).
      if (EXPECTED_BACKEND_SET.has(suspectedName)) delete adapters[suspectedName];
      registryIssues.set(suspectedName, error.message);
    }
  }
  loadedAdapters.sort((left, right) => (left.order ?? 1_000) - (right.order ?? 1_000));
  for (const adapter of loadedAdapters) {
    adapters[adapter.name] = adapter;
  }
}

export function assertAdapterRegistry(adapters, registryIssues = new Map()) {
  const problems = [];
  for (const name of EXPECTED_BACKENDS) {
    if (registryIssues.has(name)) {
      problems.push(`${name} (malformed: ${registryIssues.get(name)})`);
    } else if (!adapters[name]) {
      problems.push(`${name} (missing)`);
    } else {
      const adapter = adapters[name];
      const malformed = [];
      if (typeof adapter.fresh !== 'function') malformed.push('fresh must be a function');
      if (typeof adapter.parse !== 'function') malformed.push('parse must be a function');
      if (!Array.isArray(adapter.env)) malformed.push('env must be an array');
      if (adapter.resume != null && typeof adapter.resume !== 'function') {
        malformed.push('resume must be a function or null');
      }
      if (adapter.checkCompaction != null && typeof adapter.checkCompaction !== 'function') {
        malformed.push('checkCompaction must be a function when provided');
      }
      if (malformed.length > 0) problems.push(`${name} (malformed: ${malformed.join(', ')})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Adapter registry incomplete: missing or malformed adapter(s) for ${problems.join('; ')}`,
    );
  }
}

export async function loadAdapters() {
  const adapters = Object.create(null);
  const registryIssues = new Map();
  await loadDirectory(BUILTIN_ADAPTERS_DIR, adapters, registryIssues);
  await loadDirectory(USER_ADAPTERS_DIR, adapters, registryIssues);
  // assertAdapterRegistry only enforces the 4 required backends — a broken adapter under
  // a custom name isn't required, so it must not block anything, but it should still be
  // visible rather than silently dropped.
  for (const [name, message] of registryIssues) {
    if (!EXPECTED_BACKEND_SET.has(name)) {
      console.error(`warning: adapter "${name}" failed to load and was skipped: ${message}`);
    }
  }
  assertAdapterRegistry(adapters, registryIssues);
  return adapters;
}
