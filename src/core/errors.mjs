export class RelayError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RelayError';
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
  }
}
