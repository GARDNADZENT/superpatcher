import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { sha256, createSha256Stream, toHex } from '../src/sha256.js';

function deterministicBytes(n) {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 2654435761) & 0xff;
  return a;
}

test('sha256() matches Node crypto across sizes spanning block-boundary edge cases', () => {
  for (const size of [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 129, 1000, 100000]) {
    const msg = deterministicBytes(size);
    const expected = createHash('sha256').update(Buffer.from(msg)).digest('hex');
    assert.equal(toHex(sha256(msg)), expected, `size=${size}`);
  }
});

test('createSha256Stream() matches sha256() regardless of how the message is chunked', () => {
  const size = 1234567;
  const msg = deterministicBytes(size);
  const expected = toHex(sha256(msg));

  for (const chunkSize of [1, 3, 7, 64, 65, 1000, size + 1]) {
    const stream = createSha256Stream();
    for (let off = 0; off < msg.length; off += chunkSize) {
      stream.update(msg.subarray(off, Math.min(msg.length, off + chunkSize)));
    }
    assert.equal(toHex(stream.digest()), expected, `chunkSize=${chunkSize}`);
  }
});

test('createSha256Stream() handles zero updates (empty message) and rejects misuse', () => {
  const empty = createSha256Stream();
  assert.equal(toHex(empty.digest()), toHex(sha256(new Uint8Array(0))));

  const s = createSha256Stream();
  s.update(new Uint8Array([1, 2, 3]));
  s.digest();
  assert.throws(() => s.digest());
  assert.throws(() => s.update(new Uint8Array([4])));
});
