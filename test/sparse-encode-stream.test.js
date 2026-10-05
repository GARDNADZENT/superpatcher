// Tests src/sparse-encode.js (the production streaming sparse encoder) by
// round-tripping its output through this project's OWN sparse decoder
// (src/sparse.js + virtual-disk.js) -- the only correctness bar that
// matters is "the decoder we already ship agrees with what the encoder
// produces", mirroring how lp-writer.test.js validates against lp.js.
import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeSparseStream, wrapSourceForRealPassOnly } from '../src/sparse-encode.js';
import { indexSparseOrRaw } from '../src/sparse.js';
import { VirtualDisk } from '../src/virtual-disk.js';

function deterministicBytes(n, seed) {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 2654435761 + seed) & 0xff;
  return a;
}

async function collect(asyncIter) {
  const chunks = [];
  for await (const c of asyncIter) chunks.push(c);
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Streams a plain in-memory Uint8Array in pieces (simulating a real
 * chunked source like streamEditedSuperImage). */
function makeSourceFromBytes(bytes, pieceSize) {
  return async function* () {
    let off = 0;
    while (off < bytes.length) {
      const take = Math.min(pieceSize, bytes.length - off);
      yield bytes.subarray(off, off + take);
      off += take;
    }
  };
}

/** Decodes sparse-encoded bytes back to raw content via this project's own
 * decoder, for round-trip verification. */
async function decodeViaOwnDecoder(sparseBytes) {
  const file = new Blob([sparseBytes]);
  const index = await indexSparseOrRaw(file);
  assert.equal(index.sparse, true, 'the decoder must recognize this as a real sparse image');
  const disk = new VirtualDisk([{ file, index }]);
  return disk.read(0, disk.totalSize);
}

test('encodeSparseStream(): round-trips an all-zero image as a single DONT_CARE chunk', async () => {
  const blockSize = 4096;
  const original = new Uint8Array(blockSize * 10); // all zero
  const sparse = await collect(encodeSparseStream(makeSourceFromBytes(original, 4096), original.length, blockSize));
  const decoded = await decodeViaOwnDecoder(sparse);
  assert.deepEqual(decoded, original);
});

test('encodeSparseStream(): round-trips a mix of zero, fill, and real (raw) data', async () => {
  const blockSize = 4096;
  const zeroPart = new Uint8Array(blockSize * 3);
  const fillPart = new Uint8Array(blockSize * 2);
  for (let i = 0; i < fillPart.length; i += 4) new DataView(fillPart.buffer).setUint32(i, 0xdeadbeef, true);
  const rawPart = deterministicBytes(blockSize * 4, 7);
  const moreZero = new Uint8Array(blockSize * 1);

  const original = new Uint8Array(zeroPart.length + fillPart.length + rawPart.length + moreZero.length);
  let o = 0;
  for (const part of [zeroPart, fillPart, rawPart, moreZero]) {
    original.set(part, o);
    o += part.length;
  }

  const sparse = await collect(
    encodeSparseStream(makeSourceFromBytes(original, 1000 /* deliberately NOT block-aligned piece size */), original.length, blockSize)
  );
  const decoded = await decodeViaOwnDecoder(sparse);
  assert.deepEqual(decoded, original);
});

test('encodeSparseStream(): round-trips fully random/incompressible content (all RAW chunks)', async () => {
  const blockSize = 4096;
  const original = deterministicBytes(blockSize * 50, 123);
  const sparse = await collect(encodeSparseStream(makeSourceFromBytes(original, 16384), original.length, blockSize));
  const decoded = await decodeViaOwnDecoder(sparse);
  assert.deepEqual(decoded, original);
});

test('encodeSparseStream(): handles a single-block image', async () => {
  const blockSize = 4096;
  const original = deterministicBytes(blockSize, 55);
  const sparse = await collect(encodeSparseStream(makeSourceFromBytes(original, blockSize), original.length, blockSize));
  const decoded = await decodeViaOwnDecoder(sparse);
  assert.deepEqual(decoded, original);
});

test('encodeSparseStream(): source pieces that split blocks in awkward places still decode correctly', async () => {
  const blockSize = 4096;
  const original = deterministicBytes(blockSize * 20, 3);
  // Deliberately tiny, prime-sized pieces so block boundaries almost never
  // line up with input piece boundaries.
  const sparse = await collect(encodeSparseStream(makeSourceFromBytes(original, 997), original.length, blockSize));
  const decoded = await decodeViaOwnDecoder(sparse);
  assert.deepEqual(decoded, original);
});

test('encodeSparseStream(): calling makeSource() more than twice (progress-wrapped) still works', async () => {
  // Mirrors how main.js would wrap the source with progress callbacks --
  // confirms there's nothing stateful in the caller-provided factory that
  // would break on repeated invocation.
  const blockSize = 4096;
  const original = deterministicBytes(blockSize * 12, 9);
  let callCount = 0;
  const baseSource = makeSourceFromBytes(original, 4096);
  const makeSource = () => {
    callCount++;
    return baseSource();
  };
  const sparse = await collect(encodeSparseStream(makeSource, original.length, blockSize));
  assert.equal(callCount, 2, 'encodeSparseStream should call the source factory exactly twice (scan + write)');
  const decoded = await decodeViaOwnDecoder(sparse);
  assert.deepEqual(decoded, original);
});

test('encodeSparseStream(): produces a meaningfully smaller output than raw for highly-compressible content', async () => {
  const blockSize = 4096;
  const original = new Uint8Array(blockSize * 1000); // 4 MiB of zeros
  const sparse = await collect(encodeSparseStream(makeSourceFromBytes(original, 65536), original.length, blockSize));
  assert.ok(sparse.length < original.length / 10, `expected sparse output to be much smaller than raw, got ${sparse.length} vs ${original.length}`);
});

test('encodeSparseStream(): rejects a totalSize that is not a multiple of blockSize', async () => {
  const blockSize = 4096;
  const original = new Uint8Array(blockSize + 10);
  await assert.rejects(() => collect(encodeSparseStream(makeSourceFromBytes(original, 4096), original.length, blockSize)));
});

test('wrapSourceForRealPassOnly(): fires the hook on every chunk of the SECOND call, including the very first chunk', async () => {
  const blockSize = 4096;
  const original = deterministicBytes(blockSize * 6, 4);
  const baseSource = makeSourceFromBytes(original, 4096);

  const seenInRealPass = [];
  const wrapped = wrapSourceForRealPassOnly(baseSource, (chunk) => seenInRealPass.push(chunk.length));

  const sparse = await collect(encodeSparseStream(wrapped, original.length, blockSize));
  const decoded = await decodeViaOwnDecoder(sparse);
  assert.deepEqual(decoded, original);

  // The hook must have seen every byte of the original exactly once --
  // including the very first chunk of the real pass, which is exactly the
  // one a naive "flip a flag inside onProgress" implementation would miss.
  const totalSeen = seenInRealPass.reduce((a, b) => a + b, 0);
  assert.equal(totalSeen, original.length, 'hook must see every real-pass byte exactly once, including the first chunk');
});

test('wrapSourceForRealPassOnly(): never fires the hook during the first (scanning) call', async () => {
  const blockSize = 4096;
  const original = deterministicBytes(blockSize * 3, 2);
  let scanPassSawChunks = false;
  let callCount = 0;
  const baseSource = () => {
    callCount++;
    const isFirstCall = callCount === 1;
    return (async function* () {
      for (let off = 0; off < original.length; off += 4096) {
        if (isFirstCall) scanPassSawChunks = true; // tracked independently of the hook, as a control
        yield original.subarray(off, Math.min(off + 4096, original.length));
      }
    })();
  };
  let hookFiredDuringScan = false;
  let sawAnyHookCall = false;
  const wrapped = wrapSourceForRealPassOnly(baseSource, () => {
    sawAnyHookCall = true;
    if (callCount === 1) hookFiredDuringScan = true;
  });
  await collect(encodeSparseStream(wrapped, original.length, blockSize));
  assert.equal(scanPassSawChunks, true, 'sanity check: the scanning pass did happen');
  assert.equal(hookFiredDuringScan, false, 'the hook must never fire during the scanning pass');
  assert.equal(sawAnyHookCall, true, 'the hook must still fire during the writing pass');
});

test('encodeSparseStream(): reports progress for both the scanning and writing phases', async () => {
  const blockSize = 4096;
  const original = deterministicBytes(blockSize * 8, 1);
  const phases = new Set();
  let lastScanning = 0;
  let lastWriting = 0;
  await collect(
    encodeSparseStream(makeSourceFromBytes(original, 4096), original.length, blockSize, 16 * 1024 * 1024, (phase, done) => {
      phases.add(phase);
      if (phase === 'scanning') lastScanning = done;
      if (phase === 'writing') lastWriting = done;
    })
  );
  assert.deepEqual(phases, new Set(['scanning', 'writing']));
  assert.equal(lastScanning, original.length);
  assert.equal(lastWriting, original.length);
});
