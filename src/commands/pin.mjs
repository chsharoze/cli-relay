import { MAP_PATH, PIN_WARNING_THRESHOLD } from '../config.mjs';
import { withLock } from '../core/lock.mjs';
import { loadMap, saveMap } from '../core/map-store.mjs';
import { validatePinText } from '../core/pins.mjs';
import { withThreadSuggestions } from '../core/thread-lookup.mjs';

export async function cmdPin(thread, factText) {
  const invalid = validatePinText(factText);
  if (!thread || invalid) {
    console.error(`usage: route-cli pin <thread> "<fact>"${invalid ? ` — ${invalid}` : ''}`);
    process.exit(2);
  }
  await withLock(() => {
    const map = loadMap();
    const session = map.sessions[thread];
    if (!session) {
      throw new Error(withThreadSuggestions(
        `no such thread "${thread}" in ${MAP_PATH} — run fresh first, then pin`,
        map.sessions,
        thread,
      ));
    }
    session.pinned_facts = session.pinned_facts ?? [];
    session.pinned_facts.push({ text: factText, pinned_at: new Date().toISOString() });
    if (session.pinned_facts.length >= PIN_WARNING_THRESHOLD) {
      console.error(
        `warning: thread "${thread}" now has ${session.pinned_facts.length} pinned facts ` +
        `(advisory threshold ${PIN_WARNING_THRESHOLD}) — a long, growing pin list defeats ` +
        `its own purpose; consider consolidating into fewer, more curated facts instead of ` +
        `appending indefinitely.`,
      );
    }
    map.sessions[thread] = session;
    saveMap(map);
    console.log(`pinned to "${thread}" (${session.pinned_facts.length} total): ${factText}`);
  });
}
