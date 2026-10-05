// Chromium (and other browsers) can throw a transient
// "NotReadableError: The requested file could not be read, typically due
// to permission problems that have occurred after a reference to a file
// was acquired" when reading a File/Blob backed by a huge on-disk file
// (multi-GB super.img) over a long-running operation — commonly triggered
// by antivirus/indexing software scanning the file, a cloud-sync client
// (OneDrive/Dropbox "Files On-Demand" placeholder files needing
// re-hydration), a removable/network drive hiccup, or the system
// sleeping/throttling the tab mid-build. The read is often fine again
// within anywhere from a second to tens of seconds, so the right fix is a
// patient bounded retry with backoff rather than failing the entire
// (possibly many-minutes-long) build over what's frequently a temporary
// condition outside the browser's (or this app's) control.
//
// Reported in practice during real multi-gigabyte "Edit & merge
// partitions" builds: the error surfaced minutes into a single read loop.
// An initial short-backoff retry (5 attempts, ~9s total patience) was NOT
// enough in at least one case -- the underlying block lasted longer than
// that -- so the defaults here are deliberately much more patient (default
// ~2 minutes of cumulative backoff) to ride out a slower antivirus scan or
// similar, while still eventually giving up and surfacing a clear,
// actionable error rather than hanging forever on a truly dead file
// handle (e.g. the user ejected a drive or closed the source file).

const DEFAULT_RETRIES = 10;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 20_000;

export function isLikelyTransientReadError(err) {
  // DOMException name for this specific failure is "NotReadableError";
  // some browsers/older message text just carries the description, so
  // match defensively on both.
  if (err && err.name === 'NotReadableError') return true;
  const msg = String(err?.message || err || '');
  return /could not be read/i.test(msg) || /permission problems/i.test(msg) || /NotReadableError/i.test(msg);
}

/** A longer, human-readable explanation + remedies for when retries are
 * ultimately exhausted -- meant to be shown directly to the user, since by
 * this point it's very unlikely to be a one-off blip. */
export const TRANSIENT_READ_FAILURE_ADVICE =
  'Your browser repeatedly failed to read bytes from one of the loaded files during this build. This is a ' +
  "browser/OS-level issue, not a bug in this tool's logic -- common causes:\n" +
  '  • Antivirus (e.g. Windows Defender) real-time-scanning a large file while it is being read\n' +
  '  • The file lives in a OneDrive/Dropbox/Google Drive-synced folder ("Files On-Demand" placeholders ' +
  'need to re-download before they can be read)\n' +
  '  • Your computer went to sleep, or the browser tab was backgrounded/throttled, partway through\n' +
  '  • A removable or network drive was briefly disconnected\n\n' +
  'What to try: keep this tab focused and your computer awake for the whole build; if the file is in a ' +
  'cloud-synced folder, copy it to a plain local folder first and reload it from there; temporarily pause ' +
  'real-time antivirus scanning for this file; then click the build button again -- your queued changes are ' +
  'still here, you do not need to redo them. If it still fails, try reloading the page and re-selecting the ' +
  'file(s) fresh (a long-held file reference can itself become stale).';

/**
 * Reads an exact byte range out of a File/Blob as a Uint8Array, retrying
 * with exponential backoff (capped at maxDelayMs) on the specific
 * transient browser read failure described above. Any other error (e.g. a
 * genuine out-of-range slice) propagates immediately, unretried.
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
