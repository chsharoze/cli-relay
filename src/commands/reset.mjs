import { MAP_PATH } from '../config.mjs';
import { withLock } from '../core/lock.mjs';
import { loadMap, saveMap } from '../core/map-store.mjs';
import { withThreadSuggestions } from '../core/thread-lookup.mjs';

export async function cmdReset(thread) {
  if (!thread) {
    console.error('usage: route-cli reset <thread>');
    process.exit(2);
  }
  await withLock(() => {
    const map = loadMap();
    const session = map.sessions[thread];
    if (!session) {
      throw new Error(withThreadSuggestions(
        `no such thread "${thread}" in ${MAP_PATH} — nothing to reset`,
        map.sessions,
        thread,
      ));
    }
    if (session.pinned_facts?.length) {
      console.error(
        `warning: thread "${thread}" has ${session.pinned_facts.length} pinned fact(s) that ` +
        `will be destroyed by reset — unlike a fresh restart, reset does not carry them ` +
        `forward. Run "route-cli pins ${thread}" first if they're worth keeping.`,
      );
    }
    delete map.sessions[thread];
    saveMap(map);
    const { pinned_facts: pinnedFacts, ...redacted } = session;
    console.log(
      `removed thread "${thread}": ${JSON.stringify(redacted)}` +
      (pinnedFacts?.length ? ` (+ ${pinnedFacts.length} pinned fact(s), not shown)` : ''),
    );
  });
}
