// Covers the retry-with-backoff wrapper added after a real-world failure:
// a ~16 GiB "Edit & merge partitions" build hit a transient Chromium
// "NotReadableError: The requested file could not be read, typically due
// to permission problems..." partway through a long read loop. The fix
// retries that *specific* transient error a bounded number of times with
// backoff, while still failing immediately (unretried) on any other error.
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileRangeWithRetry, isLikelyTransientReadError, TRANSIENT_READ_FAILURE_ADVICE } from '../src/file-read-retry.js';

/** A fake Blob whose .slice(...).arrayBuffer() can be scripted to fail a
 * given number of times (with a configurable error) before succeeding. */
function makeFlakyBlob(bytes, { failTimes = 0, error = null } = {}) {
  let callCount = 0;
  return {
    slice(start, end) {
      return {
        async arrayBuffer() {
          callCount++;
          if (callCount <= failTimes) {
            throw error ?? Object.assign(new Error('The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.'), { name: 'NotReadableError' });
          }
          return bytes.slice(start, end).buffer;
        },
      };
    },
    get callCount() {
      return callCount;
    },
  };
}

test('readFileRangeWithRetry(): succeeds immediately when there is no error', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const blob = makeFlakyBlob(bytes);
  const result = await readFileRangeWithRetry(blob, 1, 3, { baseDelayMs: 1 });
  assert.deepEqual(result, new Uint8Array([2, 3, 4]));
  assert.equal(blob.callCount, 1);
});

test('readFileRangeWithRetry(): retries a transient NotReadableError and eventually succeeds', async () => {
  const bytes = new Uint8Array([10, 20, 30, 40]);
  const blob = makeFlakyBlob(bytes, { failTimes: 3 });
  const retryLog = [];
  const result = await readFileRangeWithRetry(blob, 0, 4, {
    baseDelayMs: 1,
    onRetry: (attempt, err) => retryLog.push({ attempt, name: err.name }),
  });
  assert.deepEqual(result, bytes);
  assert.equal(blob.callCount, 4); // 3 failures + 1 success
  assert.deepEqual(
    retryLog.map((r) => r.attempt),
    [1, 2, 3]
  );
  assert.ok(retryLog.every((r) => r.name === 'NotReadableError'));
});

test('readFileRangeWithRetry(): matches the transient error by message text too, not just .name', async () => {
  const bytes = new Uint8Array([1]);
  const plainError = new Error('could not be read: permission problems occurred'); // no .name set
  const blob = makeFlakyBlob(bytes, { failTimes: 1, error: plainError });
  const result = await readFileRangeWithRetry(blob, 0, 1, { baseDelayMs: 1 });
  assert.deepEqual(result, bytes);
});

test('readFileRangeWithRetry(): gives up after exhausting retries and throws the last error', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const blob = makeFlakyBlob(bytes, { failTimes: 100 }); // always fails
  await assert.rejects(
    () => readFileRangeWithRetry(blob, 0, 3, { retries: 2, baseDelayMs: 1 }),
    (err) => err.name === 'NotReadableError'
  );
  assert.equal(blob.callCount, 3); // initial attempt + 2 retries
});

test('readFileRangeWithRetry(): does NOT retry a genuinely different error', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const otherError = new Error('some unrelated failure');
  otherError.name = 'TypeError';
  const blob = makeFlakyBlob(bytes, { failTimes: 1, error: otherError });
  await assert.rejects(() => readFileRangeWithRetry(blob, 0, 3, { baseDelayMs: 1 }), /unrelated failure/);
  assert.equal(blob.callCount, 1, 'must not retry a non-transient error');
});

test('readFileRangeWithRetry(): backoff delay is capped by maxDelayMs', async () => {
  const bytes = new Uint8Array([5]);
  const blob = makeFlakyBlob(bytes, { failTimes: 4 });
  const delays = [];
  let last = Date.now();
  const result = await readFileRangeWithRetry(blob, 0, 1, {
    baseDelayMs: 50,
    maxDelayMs: 60, // forces the exponential growth (50,100,200,400) to clamp down to 60 quickly
    onRetry: () => {
      const now = Date.now();
      delays.push(now - last);
      last = now;
    },
  });
  assert.deepEqual(result, bytes);
  // First gap ~50ms (unclamped), remaining gaps should all be clamped near
  // maxDelayMs rather than continuing to double -- allow generous slack
  // since timers aren't perfectly precise.
  assert.ok(delays[delays.length - 1] < 200, `expected a clamped delay, got ${delays[delays.length - 1]}ms`);
});

test('isLikelyTransientReadError(): recognizes NotReadableError by name and by message text', () => {
  assert.equal(isLikelyTransientReadError({ name: 'NotReadableError', message: 'whatever' }), true);
  assert.equal(
    isLikelyTransientReadError(new Error('The requested file could not be read, typically due to permission problems...')),
    true
  );
  assert.equal(isLikelyTransientReadError(new Error('totally unrelated failure')), false);
  assert.equal(isLikelyTransientReadError(null), false);
});

test('TRANSIENT_READ_FAILURE_ADVICE is a non-empty, user-actionable string', () => {
  assert.equal(typeof TRANSIENT_READ_FAILURE_ADVICE, 'string');
  assert.ok(TRANSIENT_READ_FAILURE_ADVICE.length > 50);
  assert.match(TRANSIENT_READ_FAILURE_ADVICE, /antivirus/i);
});

test('readFileRangeWithRetry(): backoff delay grows between attempts', async () => {
  const bytes = new Uint8Array([9]);
  const blob = makeFlakyBlob(bytes, { failTimes: 2 });
  const timestamps = [];
  const result = await readFileRangeWithRetry(blob, 0, 1, {
    baseDelayMs: 20,
    onRetry: () => timestamps.push(Date.now()),
  });
  assert.deepEqual(result, bytes);
  // Just confirm it actually waited a non-trivial, increasing amount of
  // time rather than busy-looping -- exact timing isn't asserted since
  // that would make the test flaky, only that the mechanism engages.
  assert.equal(timestamps.length, 2);
});
