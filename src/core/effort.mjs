// Effort levels are passed to backends verbatim. cli-relay keeps no table of valid levels;
// it only refuses values that could not be a level name at all, before anything spawns.
export const EFFORT_PATTERN = /^[a-z]+$/;

export function isEffortLevel(value) {
  return typeof value === 'string' && EFFORT_PATTERN.test(value);
}
