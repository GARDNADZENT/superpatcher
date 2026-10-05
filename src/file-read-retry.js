// Chromium (and other browsers) can throw
// "NotReadableError: The requested file could not be read, typically due
// to permission problems that have occurred after a reference to a file
// was acquired" when reading a File/Blob backed by a huge on-disk file
// (multi-GB super.img) over a long-running operation.
//
// Per the File API spec (https://www.w3.org/TR/FileAPI/#dfn-NotReadableError)
// this covers TWO different situations that look identical from JS:
//   - "FileLock": a genuinely transient concurrent lock (e.g. antivirus
//     briefly scanning the file) -- usually resolves within seconds.
//   - "SnapshotState": the File's underlying snapshot has gone stale and
//     can NEVER be read again, no matter how long you wait or how many
//     times you retry the exact same File object. This is a well-documented
//     real-world failure mode for files held in memory across a long
//     operation, especially (per multiple independent reports) for files
//     over ~2 GiB.
//
// We can't tell these apart in advance, so we retry briefly (to catch the
// first, cheap case) but deliberately do NOT retry for minutes on end --
// per a real upstream bug report fixing this exact error ("Retrying
// arrayBuffer() on the same stale File does not address the problem"),
// doing so just wastes time when the second case applies, which in
// practice is common for the very large files this app works with. Once
// retries are exhausted, the only real fix for the second case is a fresh
// File reference, which for a plain <input type="file"> only comes from
// the user re-selecting the file again -- see TRANSIENT_READ_FAILURE_ADVICE
// and main.js's handling of it.

const DEFAULT_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 400;
const DEFAULT_MAX_DELAY_MS = 4000;

export function isLikelyTransientReadError(err) {
  // DOMException name for this specific failure is "NotReadableError";
  // some browsers/older message text just carries the description, so
  // match defensively on both.
  if (err && err.name === 'NotReadableError') return true;
  const msg = String(err?.message || err || '');
  return /could not be read/i.test(msg) || /permission problems/i.test(msg) || /NotReadableError/i.test(msg);
}

/** A longer, human-readable explanation + remedies for when retries are
 * ultimately exhausted -- meant to be shown directly to the user. Written
 * from the understanding (confirmed against the File API spec and real
 * upstream bug reports) that this is very often a *permanently* stale file
 * reference for the rest of this page's lifetime, not a passing blip --
 * so "just wait and retry" is not the primary advice; getting a genuinely
 * fresh File reference is. */
export const TRANSIENT_READ_FAILURE_ADVICE =
  "Your browser says it can no longer read one of the loaded files. For very large files (especially multi-" +
  'gigabyte ones), this is a known browser limitation, not a bug in this tool: once a File reference has been ' +
  "held for a long time, the browser's internal snapshot of it can become permanently stale for the rest of " +
  'this page load -- no amount of retrying fixes that, only a genuinely fresh reference does.\n\n' +
  'What reliably fixes it: reload this page and re-select the file(s) from scratch, right before building ' +
  '(rather than selecting them and then leaving the tab open for a long time first). If it keeps happening ' +
  'on the same file even right after re-selecting it, also try:\n' +
  '  • Moving the file out of any OneDrive/Dropbox/Google Drive-synced folder into a plain local one first\n' +
  '  • Temporarily pausing real-time antivirus scanning for that file\n' +
  '  • Keeping the tab focused and the computer awake for the whole build (backgrounding/sleep can also ' +
  'invalidate the reference)\n\n' +
  "It's still worth clicking the build button again once first, in case this was actually just a brief " +
  'lock (e.g. a quick antivirus scan) rather than a permanently stale reference -- your queued changes are ' +
  'still here either way, you do not need to redo them.';

/**
 * Reads an exact byte range out of a File/Blob as a Uint8Array, retrying a
 * handful of times with short exponential backoff (capped at maxDelayMs)
 * on the specific browser read failure described above -- enough to catch
 * a brief transient lock, deliberately not enough to meaningfully wait out
 * a permanently-stale file reference, which no amount of retrying the same
 * File object can fix anyway (see module doc comment). Any other error
 * (e.g. a genuine out-of-range slice) propagates immediately, unretried.
 *
 * @param {Blob} file
 * @param {number} offset
 * @param {number} length
 * @param {object} [opts]
 * @param {number} [opts.retries]
 * @param {number} [opts.baseDelayMs]
 * @param {number} [opts.maxDelayMs]
 * @param {(attempt:number, err:Error) => void} [opts.onRetry] called before
 *   each retry attempt (attempt is 1-based), e.g. to log a warning.
 */
export async function readFileRangeWithRetry(file, offset, length, opts = {}) {
  const {
    retries = DEFAULT_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    onRetry,
  } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const buf = await file.slice(offset, offset + length).arrayBuffer();
      return new Uint8Array(buf);
    } catch (err) {
      lastErr = err;
      if (!isLikelyTransientReadError(err) || attempt === retries) throw err;
      onRetry && onRetry(attempt + 1, err);
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable (the loop above always returns or throws), but keeps
  // control-flow analysis happy.
  throw lastErr;
}
