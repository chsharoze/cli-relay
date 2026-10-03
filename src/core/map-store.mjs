import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { MAP_PATH, MAP_VERSION } from '../config.mjs';

export function loadMap() {
  if (!existsSync(MAP_PATH)) return { version: MAP_VERSION, sessions: {} };
  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  if (map.version !== MAP_VERSION) {
    throw new Error(
      `${MAP_PATH} version ${map.version} unsupported (router wants ${MAP_VERSION}) — ` +
      'no migration, fix by hand or delete',
    );
  }
  return map;
}

export function saveMap(map) {
  const tmp = `${MAP_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, MAP_PATH);
}

// Cherry-picked idea from paperclip's native-session-resume.ts (its verify-before-resume
// equality check), scoped to what a CLI router actually binds: the directory a session was
// created in. Backend is deliberately not re-checked here — sessionForInvocation's earlier
// THREAD_OWNERSHIP_MISMATCH already guarantees it before this is ever called. Model is
// deliberately not compared either (per-backend pinning is inconsistent — codex rotates
// models across turns by design, agy hardcodes one, command-code is resume-disabled — so a
// model mismatch here would be noise, not signal; revisit only if a real resume-after-model-
// change bug shows up). A session with no recorded `binding` predates this check and is
// grandfathered (returns null) rather than refused, so upgrading cli-relay doesn't break
// every thread created before this field existed.
export function resumeBindingMismatch(entry, req) {
  const binding = entry?.binding;
  if (!binding) return null;
  try {
    if (realpathSync(binding.cwd) !== realpathSync(req.cwd)) return 'cwd';
  } catch {
    return 'cwd';
  }
  return null;
}
