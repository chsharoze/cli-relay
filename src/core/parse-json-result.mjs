export function parseJsonResult(stdout, fields) {
  const hasFields = (value) => value && typeof value === 'object' &&
    (fields.id in value || fields.answer in value);

  const trimmed = stdout.trim();
  try {
    const value = JSON.parse(trimmed);
    if (hasFields(value)) {
      return { id: value[fields.id] ?? null, answer: value[fields.answer] ?? null };
    }
  } catch {
    // Not one JSON object. Fall through to the NDJSON scan.
  }

  const lines = trimmed.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let value;
    try { value = JSON.parse(lines[index]); } catch { continue; }
    if (hasFields(value)) {
      return { id: value[fields.id] ?? null, answer: value[fields.answer] ?? null };
    }
  }
  return { id: null, answer: null };
}
