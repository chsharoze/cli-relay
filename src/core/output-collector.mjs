import { StringDecoder } from 'node:string_decoder';

const defaultJoin = (left, right) => left + right;

// Buffers a child's output as text, counting the limit in bytes. Past the limit, or when
// appending fails for any reason (for example the engine refusing a string that long), it
// stops accumulating, keeps a bounded tail, and reports overflow so the caller fails closed.
// `join` is a test seam for forcing an append failure without allocating a huge string.
export function collectOutput(limitBytes, tailLength, { join = defaultJoin } = {}) {
  const decoder = new StringDecoder('utf8');
  let text = '';
  let bytes = 0;
  let overflow = false;
  const trim = (value) => {
    const tail = value.slice(-tailLength);
    // A retained tail must not start halfway through a decoded surrogate pair.
    return tail.charCodeAt(0) >= 0xdc00 && tail.charCodeAt(0) <= 0xdfff ? tail.slice(1) : tail;
  };
  const append = (chunk) => {
    if (!overflow) {
      try {
        text = join(text, chunk);
        return;
      } catch {
        overflow = true;
        // `text` still holds everything accepted before the failed append.
        text = trim(text) + trim(chunk);
      }
    } else {
      text += chunk;
    }
    text = trim(text);
  };
  const guarded = (produce) => {
    try {
      append(produce());
    } catch {
      overflow = true;
    }
  };
  return {
    write(data) {
      bytes += data.length;
      if (bytes > limitBytes) {
        if (!overflow) text = trim(text);
        overflow = true;
      }
      guarded(() => decoder.write(data));
    },
    end() { guarded(() => decoder.end()); },
    text: () => text,
    overflowed: () => overflow,
  };
}
