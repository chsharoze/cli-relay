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
