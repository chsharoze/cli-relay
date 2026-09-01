import { MAP_PATH } from '../config.mjs';
import { withLock } from '../core/lock.mjs';
import { loadMap, saveMap } from '../core/map-store.mjs';
import { withThreadSuggestions } from '../core/thread-lookup.mjs';

export async function cmdUnpin(thread, indexText) {
  const index = Number(indexText);
  if (!thread || !Number.isInteger(index) || index < 1) {
    console.error('usage: route-cli unpin <thread> <index>  (1-based — see "route-cli pins <thread>")');
    process.exit(2);
  }
  await withLock(() => {
    const map = loadMap();
    const session = map.sessions[thread];
    if (!session) {
      throw new Error(withThreadSuggestions(
        `no such thread "${thread}" in ${MAP_PATH}`,
        map.sessions,
        thread,
      ));
    }
    const pins = session.pinned_facts ?? [];
    if (index > pins.length) {
      throw new Error(`thread "${thread}" has only ${pins.length} pinned fact(s) — no #${index}`);
    }
    const [removed] = pins.splice(index - 1, 1);
    session.pinned_facts = pins;
    map.sessions[thread] = session;
    saveMap(map);
    console.log(`unpinned #${index} from "${thread}": ${removed.text}`);
  });
}
