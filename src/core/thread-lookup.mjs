export function withThreadSuggestions(message, sessions, thread) {
  if (!thread) return message;
  const needle = thread.toLocaleLowerCase();
  const matches = Object.keys(sessions)
    .filter((name) => {
      const candidate = name.toLocaleLowerCase();
      return candidate.includes(needle) || needle.includes(candidate);
    })
    .sort()
    .slice(0, 3);
  return matches.length === 0 ? message : `${message} — did you mean: ${matches.join(', ')}?`;
}
