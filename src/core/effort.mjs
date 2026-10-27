// Effort levels are passed to backends verbatim. cli-relay keeps no table of valid levels;
// it only refuses values that could not be a level name at all, before anything spawns.
export const EFFORT_PATTERN = /^[a-z]+$/;

export function isEffortLevel(value) {
  return typeof value === 'string' && EFFORT_PATTERN.test(value);
}

// Suffixes that some backends (agy) embed at the end of a model id to select its effort.
export const EFFORT_SUFFIXES = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const EFFORT_OPTION = /(^|[\s,])--effort\b/;
const HELP_WINDOW_LINES = 2;

// Finds the `--effort` option in a CLI's help text and returns the levels from the first
// parenthesised list after it, on the same line or within the next couple of lines, split
// on `|` or `,`. Returns null when there is no such option, no list, a list that is only
// an example ("(e.g. low, medium, high)"), or a list containing anything that is not a
// level name. A following line that starts a new option ends the search window.
export function parseEffortHelp(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => EFFORT_OPTION.test(line));
  if (start === -1) return null;
  const first = lines[start];
  const window = [first.slice(first.search(EFFORT_OPTION))];
  for (let offset = 1; offset <= HELP_WINDOW_LINES && start + offset < lines.length; offset += 1) {
    const line = lines[start + offset];
    if (line.trim().startsWith('-')) break;
    window.push(line);
  }
  const match = /\(([^()]*)\)/.exec(window.join('\n'));
  if (!match) return null;
  const body = match[1].trim();
  if (/^e\.g\./i.test(body)) return null;
  const levels = body.split(/[|,]/).map((token) => token.trim());
  if (levels.length === 0 || !levels.every(isEffortLevel)) return null;
  return [...new Set(levels)];
}
