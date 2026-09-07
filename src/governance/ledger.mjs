import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  fstatSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { LEDGER_PATH, LEDGER_PATH_CONFIG_ERROR } from '../config.mjs';
import { withLock } from '../core/lock.mjs';

export const LEDGER_VERSION = 1;
export const GENESIS_ANCHOR = 'GENESIS';
export const CHECKPOINT_TYPE = 'checkpoint';

const DISPATCH_TYPE = 'dispatch';
// Bound both recovery and newly written records. Reserve two bytes for the
// preceding and terminating newlines so a record we write is always recoverable.
export const MAX_LEDGER_TAIL_BYTES = 1024 * 1024;
const GOVERNANCE_FIELDS = new Set([
  'version',
  'type',
  'timestamp',
  'backend',
  'thread',
  'mode',
  'outcome',
  'exit_code',
  'exitCode',
  'tier',
  'tier_name',
  'gate_allowed',
  'client',
  'task',
  'operator',
  'previous_hash',
  'hash',
]);

function warn(message) {
  try {
    console.error(`warning: governance ledger ${message}`);
  } catch {
    // A closed stderr must not turn best-effort auditing into a dispatch failure.
  }
}

function canonicalValue(value, ancestors) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'bigint') throw new TypeError('cannot hash a bigint ledger value');
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }

  if (ancestors.has(value)) throw new TypeError('cannot hash a circular ledger value');
  ancestors.add(value);
  try {
    if (typeof value.toJSON === 'function') {
      return canonicalValue(value.toJSON(), ancestors);
    }
    if (Array.isArray(value)) {
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(canonicalValue(value[index], ancestors) ?? 'null');
      }
      return `[${items.join(',')}]`;
    }
    const properties = [];
    for (const key of Object.keys(value).sort()) {
      const encoded = canonicalValue(value[key], ancestors);
      if (encoded !== undefined) properties.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${properties.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

// Hashes represent the logical JSON object, not incidental key order or whitespace in
// the JSONL file. This also makes hashes deterministic for future metadata objects.
export function canonicalStringify(value) {
  const encoded = canonicalValue(value, new Set());
  if (encoded === undefined) throw new TypeError('ledger value is not JSON-serializable');
  return encoded;
}

export function computeLedgerHash(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('ledger entry must be an object');
  }
  const unsigned = Object.create(null);
  for (const key of Object.keys(entry)) {
    if (key !== 'hash') unsigned[key] = entry[key];
  }
  return createHash('sha256').update(canonicalStringify(unsigned)).digest('hex');
}

function isCheckpoint(entry) {
  return entry?.type === CHECKPOINT_TYPE;
}

function readRange(fd, start, length) {
  const data = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = readSync(fd, data, offset, length - offset, start + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return data.subarray(0, offset);
}

function isJsonWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

// Recover only a bounded suffix, even when corruption removes every delimiter.
// Never inspect, recompute, or validate the preceding chain.
function readLedgerTail(ledgerPath) {
  let fd;
  try {
    fd = openSync(ledgerPath, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return { line: null, needsSeparator: false };
    throw error;
  }

  try {
    const size = fstatSync(fd).size;
    if (size === 0) return { line: null, needsSeparator: false };

    const start = Math.max(0, size - MAX_LEDGER_TAIL_BYTES);
    const data = readRange(fd, start, size - start);
    const needsSeparator = data.at(-1) !== 0x0a;
    let lineEnd = data.length;
    while (lineEnd > 0 && isJsonWhitespace(data[lineEnd - 1])) lineEnd -= 1;
    if (lineEnd === 0 && start === 0) return { line: null, needsSeparator };
    const newline = lineEnd > 0 ? data.lastIndexOf(0x0a, lineEnd - 1) : -1;
    if (start > 0 && newline < 0) {
      warn(`tail exceeds ${MAX_LEDGER_TAIL_BYTES}-byte recovery window; appending with a discontinuity`);
      return {
        line: null,
        // A non-genesis fallback cannot silently certify an unknown prefix.
        fallbackHash: createHash('sha256').update('oversized-ledger-tail\0')
          .update(String(size)).update('\0').update(data).digest('hex'),
        needsSeparator,
      };
    }
    return {
      line: data.subarray(newline + 1, lineEnd).toString('utf8'),
      needsSeparator,
    };
  } finally {
    closeSync(fd);
  }
}

function hashMalformedTail(line) {
  return createHash('sha256')
    .update('malformed-ledger-tail\0')
    .update(line)
    .digest('hex');
}

function previousHashFromTail(line) {
  if (line === null) return GENESIS_ANCHOR;
  try {
    const previous = JSON.parse(line);
    if (typeof previous?.hash === 'string' && previous.hash.length > 0) return previous.hash;
  } catch {
    // A malformed tail is existing damage, not a reason to deny a new append.
  }
  warn('tail has no usable hash; appending without repairing or verifying prior entries');
  return hashMalformedTail(line);
}

function extraFields(entry) {
  const extras = Object.create(null);
  for (const key of Object.keys(entry).sort()) {
    if (!GOVERNANCE_FIELDS.has(key)) extras[key] = entry[key];
  }
  return extras;
}

function normalizeEntry(entry, previousHash) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('entry must be an object');
  }
  const timestamp = typeof entry.timestamp === 'string' && entry.timestamp.length > 0
    ? entry.timestamp
    : new Date().toISOString();
  const extras = extraFields(entry);

  if (isCheckpoint(entry)) {
    return {
      version: LEDGER_VERSION,
      type: CHECKPOINT_TYPE,
      timestamp,
      ...extras,
      previous_hash: GENESIS_ANCHOR,
    };
  }

  const tier = entry.tier ?? 1;
  return {
    version: LEDGER_VERSION,
    type: DISPATCH_TYPE,
    timestamp,
    backend: entry.backend ?? null,
    thread: entry.thread ?? null,
    mode: entry.mode ?? null,
    outcome: entry.outcome ?? null,
    exit_code: Object.hasOwn(entry, 'exit_code') ? entry.exit_code : (entry.exitCode ?? null),
    tier,
    tier_name: entry.tier_name ?? (tier === 1 ? 'read-only' : null),
    gate_allowed: entry.gate_allowed ?? true,
    client: entry.client ?? null,
    task: entry.task ?? null,
    operator: entry.operator ?? null,
    ...extras,
    previous_hash: previousHash,
  };
}

// This function is intentionally best-effort and non-throwing. Callers should still await
// it so the append finishes before their short-lived CLI process exits.
export async function appendLedgerEntry(entry) {
  try {
    if (LEDGER_PATH_CONFIG_ERROR) {
      warn(`${LEDGER_PATH_CONFIG_ERROR}; using ${LEDGER_PATH}`);
    }
    // Resolve symlink aliases to the same resource before selecting its lock.
    // Creating a missing empty file publishes no event and makes dangling aliases
    // resolvable too. Failure remains advisory in the outer catch.
    let ledgerPath;
    try {
      ledgerPath = realpathSync(LEDGER_PATH);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      closeSync(openSync(LEDGER_PATH, 'a', 0o600));
      ledgerPath = realpathSync(LEDGER_PATH);
    }
    // Unlike symlinks, hard-link aliases have no unique canonical pathname. Do
    // not silently use independent locks for the same inode through two names.
    if (statSync(ledgerPath).nlink > 1) {
      throw new Error('hard-linked ledger files are unsupported; use one path or symlink aliases');
    }
    await withLock(() => {
      let tail;
      try {
        tail = readLedgerTail(ledgerPath);
      } catch (error) {
        // Failure to inspect existing state must not become a write gate. A conspicuous
        // non-checkpoint link records the discontinuity for verifyLedger() to report.
        warn(`tail could not be read (${error.message}); appending with an unknown anchor`);
        tail = { line: null, needsSeparator: true };
      }
      const previousHash = isCheckpoint(entry)
        ? GENESIS_ANCHOR
        : (tail.fallbackHash ?? previousHashFromTail(tail.line));
      const record = normalizeEntry(entry, previousHash);
      record.hash = computeLedgerHash(record);
      const separator = tail.needsSeparator ? '\n' : '';
      const serialized = JSON.stringify(record);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_LEDGER_TAIL_BYTES - 2) {
        throw new Error(`entry exceeds ${MAX_LEDGER_TAIL_BYTES - 2}-byte record limit`);
      }
      appendFileSync(ledgerPath, `${separator}${serialized}\n`, {
        encoding: 'utf8',
        flag: 'a',
        mode: 0o600,
      });
    }, { lockPath: `${ledgerPath}.lock`, reclaimLive: false });
  } catch (error) {
    warn(`append failed: ${error?.message ?? String(error)}`);
  }
}

function report(totalEntries, intact, breakIndex = null, reason = null) {
  return {
    totalEntries,
    intact,
    breakIndex,
    lineNumber: breakIndex === null ? null : breakIndex + 1,
    reason,
  };
}

// Verification is deliberately read-only and independent from append. In particular, a
// bad line is returned as data and never prevents this diagnostic from examining the file.
export function verifyLedger() {
  if (LEDGER_PATH_CONFIG_ERROR) {
    warn(`${LEDGER_PATH_CONFIG_ERROR}; verifying fallback path ${LEDGER_PATH}`);
  }
  let contents;
  try {
    contents = readFileSync(LEDGER_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return report(0, true);
    return report(0, false, null, `unable to read ledger: ${error.message}`);
  }
  if (contents.length === 0) return report(0, true);

  const lines = contents.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const totalEntries = lines.length;
  let previousHash = GENESIS_ANCHOR;

  for (let index = 0; index < lines.length; index += 1) {
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch (error) {
      return report(totalEntries, false, index, `invalid JSON: ${error.message}`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return report(totalEntries, false, index, 'entry must be a JSON object');
    }

    const expectedPreviousHash = isCheckpoint(entry) ? GENESIS_ANCHOR : previousHash;
    if (entry.previous_hash !== expectedPreviousHash) {
      return report(
        totalEntries,
        false,
        index,
        `previous_hash mismatch: expected ${JSON.stringify(expectedPreviousHash)}, ` +
          `got ${JSON.stringify(entry.previous_hash)}`,
      );
    }
    if (typeof entry.hash !== 'string' || entry.hash.length === 0) {
      return report(totalEntries, false, index, 'entry hash is missing or not a string');
    }

    let expectedHash;
    try {
      expectedHash = computeLedgerHash(entry);
    } catch (error) {
      return report(totalEntries, false, index, `entry cannot be hashed: ${error.message}`);
    }
    if (entry.hash !== expectedHash) {
      return report(
        totalEntries,
        false,
        index,
        `hash mismatch: expected ${expectedHash}, got ${entry.hash}`,
      );
    }
    previousHash = entry.hash;
  }

  return report(totalEntries, true);
}
