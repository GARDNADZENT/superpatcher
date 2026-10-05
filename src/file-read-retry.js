// Chromium (and other browsers) can throw a transient
// "NotReadableError: The requested file could not be read, typically due
// to permission problems that have occurred after a reference to a file
// was acquired" when reading a File/Blob backed by a huge on-disk file
// (multi-GB super.img) over a long-running operation — commonly triggered
// by antivirus/indexing software briefly touching the file mid-read, a
// removable/network drive hiccup, or the OS momentarily reclaiming the
// file handle under memory pressure. The read is usually perfectly fine a
// moment later, so the right fix is a bounded retry with backoff rather
// than failing the entire (possibly many-minutes-long) build.
//
// Reported in practice during a real ~16 GiB "Edit & merge partitions"
// build: the error surfaced ~4 minutes into a single read loop, well past
// the point of retrying being free -- losing that much progress to a
// transient, often-single-occurrence glitch is exactly what this exists
// to avoid.

const DEFAULT_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 300;

function isLikelyTransientReadError(err) {
  // DOMException name for this specific failure is "NotReadableError";
  // some browsers/older message text just carries the description, so
  // match defensively on both.
  if (err && err.name === 'NotReadableError') return true;
  const msg = String(err?.message || err || '');
  return /could not be read/i.test(msg) || /permission problems/i.test(msg) || /NotReadableError/i.test(msg);
}

/**
 * Reads an exact byte range out of a File/Blob as a Uint8Array, retrying
 * with exponential backoff on the specific transient browser read failure
 * described above. Any other error (e.g. a genuine out-of-range slice)
 * propagates immediately, unretried.
 *
 * @param {Blob} file
 * @param {number} offset
 * @param {number} length
 * @param {object} [opts]
 * @param {number} [opts.retries]
 * @param {number} [opts.baseDelayMs]
 * @param {(attempt:number, err:Error) => void} [opts.onRetry] called before
 *   each retry attempt (attempt is 1-based), e.g. to log a warning.
 */
export async function readFileRangeWithRetry(file, offset, length, opts = {}) {
  const { retries = DEFAULT_RETRIES, baseDelayMs = DEFAULT_BASE_DELAY_MS, onRetry } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const buf = await file.slice(offset, offset + length).arrayBuffer();
      return new Uint8Array(buf);
    } catch (err) {
      lastErr = err;
      if (!isLikelyTransientReadError(err) || attempt === retries) throw err;
      onRetry && onRetry(attempt + 1, err);
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable (the loop above always returns or throws), but keeps
  // control-flow analysis happy.
  throw lastErr;
}
