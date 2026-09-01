import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
