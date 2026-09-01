// Native authentication lives in each CLI's own store. These variables preserve binary
// resolution, config-home discovery, git-over-SSH, and normal terminal locale behavior.
export const ENV_BASE = Object.freeze(['PATH', 'HOME', 'SSH_AUTH_SOCK', 'LANG', 'TERM']);
