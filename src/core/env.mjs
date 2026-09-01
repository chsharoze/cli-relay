export function scrubEnv(allowlist) {
  const env = {};
  for (const name of allowlist) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}
