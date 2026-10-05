// Streaming Android sparse-image encoder -- the write-side counterpart of
// sparse.js's decoder. `fastboot flash super` (and the userspace fastbootd
// path used for dynamic partitions on most Android 10+ devices) expects
// the image it's given to actually be in sparse format; a raw image can be
// rejected outright ("Invalid sparse file format at header magic") even
// when its size is otherwise correct. This lets any build in this app
// produce real multi-chunk sparse output instead of only ever raw.
//
// Format reference (same one sparse.js's decoder implements):
//   https://android.googlesource.com/platform/system/core/+/master/libsparse/sparse_format.h
//
// Why two passes: the sparse file header must declare its total chunk
// count up front, but that count depends entirely on the data's content
// (how many RAW/FILL/DONT_CARE regions it has), which isn't known until
// the data has actually been scanned. Rather than buffering the whole
// (potentially many-GB) output just to find that out, or seeking back to
// patch the header after writing (which would tie this feature to
// particular sink capabilities, and re-introduce exactly the kind of
// long-held-file-handle risk this project just spent real effort fixing --
// see file-read-retry.js), this runs the source TWICE: once to classify
// every block into a compact plan (no byte content kept), and once more to
// actually stream the real bytes out, now that the header can be written
// correctly the first time. The source must be a pure, repeatable function
// (e.g. partition-editor.js's streamEditedSuperImage() over a stable,
// already-loaded disk) -- calling it twice must yield byte-identical
// output both times.

const SPARSE_HEADER_MAGIC = 0xed26ff3a;
const CHUNK_TYPE_RAW = 0xcac1;
const CHUNK_TYPE_FILL = 0xcac2;
const CHUNK_TYPE_DONT_CARE = 0xcac3;
const FILE_HEADER_SIZE = 28;
const CHUNK_HEADER_SIZE = 12;

function concatBytes(a, b) {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Classifies one block: {type:'zero'} (all-zero -- becomes a compact
 * DONT_CARE chunk), {type:'fill', value} (one repeated 4-byte pattern --
 * becomes a compact FILL chunk), or {type:'raw'} (anything else -- its
 * actual bytes must be stored). */
function classifyBlock(block) {
  const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const first = dv.getUint32(0, true);
  for (let i = 4; i < block.length; i += 4) {
    if (dv.getUint32(i, true) !== first) return { type: 'raw' };
  }
  return first === 0 ? { type: 'zero' } : { type: 'fill', value: first };
}

function encodeChunkHeader(type, blocks, totalBytesIncludingHeader) {
  const header = new Uint8Array(CHUNK_HEADER_SIZE);
  const dv = new DataView(header.buffer);
  dv.setUint16(0, type, true);
  dv.setUint16(2, 0, true); // reserved
  dv.setUint32(4, blocks, true);
  dv.setUint32(8, totalBytesIncludingHeader, true);
  return header;
}

function chunkHeaderPieces(entry, blockSize) {
  if (entry.type === 'raw') {
    return [encodeChunkHeader(CHUNK_TYPE_RAW, entry.blocks, CHUNK_HEADER_SIZE + entry.blocks * blockSize)];
  }
  if (entry.type === 'fill') {
    const fillValue = new Uint8Array(4);
    new DataView(fillValue.buffer).setUint32(0, entry.value, true);
    return [encodeChunkHeader(CHUNK_TYPE_FILL, entry.blocks, CHUNK_HEADER_SIZE + 4), fillValue];
  }
  return [encodeChunkHeader(CHUNK_TYPE_DONT_CARE, entry.blocks, CHUNK_HEADER_SIZE)];
}

/**
 * Walks `makeSource()`'s output once, block by block, and returns a
 * compact plan: an array of {type:'raw'|'fill'|'zero', blocks, value?}
 * entries, consecutive same-type (and, for fill, same-value) blocks
 * coalesced into one entry -- without holding any of the actual byte
 * content. Also validates the source's total length is an exact multiple
 * of blockSize, which Android sparse images require.
 */
async function buildChunkPlan(makeSource, blockSize) {
  const plan = [];
  let leftover = new Uint8Array(0);
  let totalBytes = 0;
  for await (const piece of makeSource()) {
    totalBytes += piece.length;
    const buf = leftover.length ? concatBytes(leftover, piece) : piece;
    let offset = 0;
    while (offset + blockSize <= buf.length) {
      const block = buf.subarray(offset, offset + blockSize);
      const info = classifyBlock(block);
      const last = plan[plan.length - 1];
      if (last && last.type === info.type && (info.type !== 'fill' || last.value === info.value)) {
        last.blocks++;
      } else {
        plan.push({ ...info, blocks: 1 });
      }
      offset += blockSize;
    }
    leftover = buf.subarray(offset);
  }
  if (leftover.length > 0) {
    throw new Error(
      `encodeSparseStream: source length (${totalBytes}) is not an exact multiple of blockSize (${blockSize}); ` +
        `Android sparse images require block-aligned content.`
    );
  }
  return { plan, totalBytes };
}

/** Accumulates raw-chunk output bytes and flushes them in pieces of at
 * most `pieceSize`, so a single huge RAW plan entry doesn't have to be
 * held/yielded as one giant buffer. flush(force=true) drains everything
 * (used at the end of an entry), still capped at pieceSize per yielded
 * piece; flush(false) only yields while a full pieceSize is available. */
function createRawBuffer(pieceSize) {
  let chunks = [];
  let length = 0;
  function push(block) {
    chunks.push(block);
    length += block.length;
  }
  function* flush(force) {
    while (force ? length > 0 : length >= pieceSize) {
      if (chunks.length === 1) {
        const only = chunks[0];
        if (only.length <= pieceSize) {
          yield only;
          chunks = [];
          length = 0;
          break;
        }
      }
      const merged = new Uint8Array(length);
      let o = 0;
      for (const c of chunks) {
        merged.set(c, o);
        o += c.length;
      }
      chunks = [];
      length = 0;
      if (merged.length <= pieceSize) {
        yield merged;
      } else {
        yield merged.subarray(0, pieceSize);
        chunks = [merged.subarray(pieceSize)];
        length = chunks[0].length;
      }
    }
  }
  return { push, flush };
}

/**
 * Wraps a `makeSource` factory so that `onRealPassChunk(chunk)` fires on
 * every chunk yielded during the SECOND call to the wrapped factory (the
 * "writing" pass inside encodeSparseStream -- see below) and never during
 * the first ("scanning") pass, which re-reads the identical bytes purely
 * to classify them. Useful for callers that need to see the real logical
 * content exactly once (e.g. to hash it for an integrity report)
 * regardless of whether the output ends up sparse- or raw-encoded.
 *
 * Deliberately counts actual invocations of the factory rather than
 * reacting to encodeSparseStream's onProgress callback: progress for the
 * writing pass is only reported *after* a piece has already been pulled
 * from the generator, so a flag flipped from inside onProgress would miss
 * tagging that very first piece -- an easy, subtle bug to introduce here.
 */
export function wrapSourceForRealPassOnly(makeSource, onRealPassChunk) {
  let callCount = 0;
  return () => {
    callCount++;
    const isRealPass = callCount === 2;
    const gen = makeSource();
    return (async function* () {
      for await (const chunk of gen) {
        if (isRealPass && onRealPassChunk) onRealPassChunk(chunk);
        yield chunk;
      }
    })();
  };
}

/**
 * Streams `makeSource()`'s raw byte content back out re-encoded as a real
 * Android sparse image (RAW/FILL/DONT_CARE chunks), suitable for
 * `fastboot flash`. See the module doc comment for why the source function
 * is called twice.
 *
 * @param {() => AsyncGenerator<Uint8Array>|AsyncIterable<Uint8Array>} makeSource
 *   Called twice; must yield byte-identical content covering exactly
 *   `totalSize` bytes both times (e.g. `() => streamEditedSuperImage(disk,
 *   geo, plan, sources)`).
 * @param {number} totalSize total bytes the source yields; must be an
 *   exact multiple of `blockSize`.
 * @param {number} [blockSize]
 * @param {number} [rawPieceSize] max size of each yielded RAW-chunk data
 *   piece (purely a memory/granularity knob; does not affect the encoded
 *   format).
 * @param {(phase:'scanning'|'writing', bytesProcessed:number, totalBytes:number) => void} [onProgress]
 */
export async function* encodeSparseStream(makeSource, totalSize, blockSize = 4096, rawPieceSize = 16 * 1024 * 1024, onProgress) {
  if (totalSize % blockSize !== 0) {
    throw new Error(`encodeSparseStream: totalSize (${totalSize}) must be a multiple of blockSize (${blockSize})`);
  }

  // Pass 1: classify every block into a compact plan (no byte content kept).
  let scanned = 0;
  const { plan } = await buildChunkPlan(async function* () {
    for await (const piece of makeSource()) {
      scanned += piece.length;
      onProgress && onProgress('scanning', scanned, totalSize);
      yield piece;
    }
  }, blockSize);

  // Emit the file header now that the real chunk count is known.
  const totalBlocks = totalSize / blockSize;
  const fileHeader = new Uint8Array(FILE_HEADER_SIZE);
  const fhdv = new DataView(fileHeader.buffer);
  fhdv.setUint32(0, SPARSE_HEADER_MAGIC, true);
  fhdv.setUint16(4, 1, true); // major_version
  fhdv.setUint16(6, 0, true); // minor_version
  fhdv.setUint16(8, FILE_HEADER_SIZE, true);
  fhdv.setUint16(10, CHUNK_HEADER_SIZE, true);
  fhdv.setUint32(12, blockSize, true);
  fhdv.setUint32(16, totalBlocks, true);
  fhdv.setUint32(20, plan.length, true);
  fhdv.setUint32(24, 0, true); // image_checksum -- optional, 0 means "not present"
  yield fileHeader;

  if (plan.length === 0) return; // degenerate empty-source case

  // Pass 2: re-run the source and emit each plan entry's chunk header (+,
  // for RAW entries, its actual bytes, buffered up to rawPieceSize at a
  // time rather than one block at a time).
  let planIdx = 0;
  let blocksDoneInEntry = 0;
  let inputLeftover = new Uint8Array(0);
  const rawOut = createRawBuffer(rawPieceSize);

  for (const piece of chunkHeaderPieces(plan[0], blockSize)) yield piece;

  let written = 0;
  for await (const piece of makeSource()) {
    written += piece.length;
    onProgress && onProgress('writing', written, totalSize);
    const buf = inputLeftover.length ? concatBytes(inputLeftover, piece) : piece;
    let offset = 0;
    while (offset + blockSize <= buf.length) {
      const entry = plan[planIdx];
      const block = buf.subarray(offset, offset + blockSize);
      if (entry.type === 'raw') rawOut.push(block);
      offset += blockSize;
      blocksDoneInEntry++;

      if (blocksDoneInEntry === entry.blocks) {
        if (entry.type === 'raw') {
          for (const out of rawOut.flush(true)) yield out;
        }
        planIdx++;
        blocksDoneInEntry = 0;
        if (planIdx < plan.length) {
          for (const headerPiece of chunkHeaderPieces(plan[planIdx], blockSize)) yield headerPiece;
        }
      } else if (entry.type === 'raw') {
        for (const out of rawOut.flush(false)) yield out;
      }
    }
    inputLeftover = buf.subarray(offset);
  }
}
