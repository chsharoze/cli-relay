import { MAP_PATH } from '../config.mjs';
import { loadMap } from '../core/map-store.mjs';
import { withThreadSuggestions } from '../core/thread-lookup.mjs';

export function cmdPins(thread) {
  if (!thread) {
    console.error('usage: route-cli pins <thread>');
    process.exit(2);
  }
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
  if (pins.length === 0) {
    console.log(`no pinned facts for "${thread}"`);
    return;
  }
  pins.forEach((pin, index) => {
    console.log(`${index + 1}. ${pin.text} (pinned ${pin.pinned_at})`);
  });
}
