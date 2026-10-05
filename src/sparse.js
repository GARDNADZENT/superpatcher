// Android sparse image format parser.
// Spec: https://android.googlesource.com/platform/system/core/+/master/libsparse/sparse_format.h
//
// Rather than materializing the "unsparsed" image in memory (which can be
// many GB), this module builds an *index*: a list of chunks, each tagged
// with where its bytes live in the source file (or how to synthesize them,
// for fill/zero chunks) and where they land in the virtual (decompressed)
// output stream. The actual bytes are only read on demand, in bounded
// windows, by virtual-disk.js.

import { readFileRangeWithRetry } from './file-read-retry.js';

export const SPARSE_HEADER_MAGIC = 0xed26ff3a;

const CHUNK_TYPE_RAW = 0xcac1;
const CHUNK_TYPE_FILL = 0xcac2;
const CHUNK_TYPE_DONT_CARE = 0xcac3;
const CHUNK_TYPE_CRC32 = 0xcac4;

/**
 * Read an exact byte range from a File/Blob as a Uint8Array. Retries a
 * bounded number of times on the transient browser read failure described
 * in file-read-retry.js.
 * @param {Blob} file
 * @param {number} offset
 * @param {number} length
 */
async function readFileRange(file, offset, length) {
  return readFileRangeWithRetry(file, offset, length);
}

/**
 * Scans `file` and returns either a sparse-chunk index or a single
 * pass-through "raw" chunk if the file does not look like a sparse image.
 *
 * @param {Blob} file
 * @param {(scanned:number, total:number)=>void} [onProgress]
 * @returns {Promise<{sparse:boolean, outputSize:number, blockSize:number, chunks:Array}>}
 */
export async function indexSparseOrRaw(file, onProgress) {
  if (file.size < 28) {
    return rawPassthrough(file);
  }

  const headerBytes = await readFileRange(file, 0, 28);
  const dv = new DataView(headerBytes.buffer);
  const magic = dv.getUint32(0, true);
  if (magic !== SPARSE_HEADER_MAGIC) {
    return rawPassthrough(file);
  }

  const majorVersion = dv.getUint16(4, true);
  if (majorVersion !== 1) {
    throw new Error(
      `Unsupported sparse image major version ${majorVersion} (only version 1 is supported).`
    );
  }
  const fileHdrSz = dv.getUint16(8, true);
  const chunkHdrSz = dv.getUint16(10, true);
  const blockSize = dv.getUint32(12, true);
  const totalBlocks = dv.getUint32(16, true);
  const totalChunks = dv.getUint32(20, true);

  if (blockSize === 0 || blockSize % 4 !== 0) {
    throw new Error(`Invalid sparse block size: ${blockSize}`);
  }

  const chunks = [];
  let filePos = fileHdrSz;
  let outBlocks = 0;

  // Sliding window so we don't issue one tiny file read per chunk header.
  const WINDOW = 4 * 1024 * 1024;
  let windowBuf = null;
  let windowStart = 0;

  async function viewAt(offset, length) {
    if (
      !windowBuf ||
      offset < windowStart ||
      offset + length > windowStart + windowBuf.length
    ) {
      windowStart = offset;
      const len = Math.min(WINDOW, file.size - offset);
      if (len < length) {
        throw new Error('Unexpected end of file while parsing sparse chunks.');
      }
      windowBuf = await readFileRange(file, offset, len);
    }
    return new DataView(
      windowBuf.buffer,
      windowBuf.byteOffset + (offset - windowStart),
      length
    );
  }

  for (let i = 0; i < totalChunks; i++) {
    if (filePos + chunkHdrSz > file.size) {
      throw new Error(`Sparse image truncated at chunk ${i}.`);
    }
    const ch = await viewAt(filePos, chunkHdrSz);
    const chunkType = ch.getUint16(0, true);
    const chunkSzBlocks = ch.getUint32(4, true);
    const totalSz = ch.getUint32(8, true);
    const dataOffset = filePos + chunkHdrSz;
    const outOffset = outBlocks * blockSize;
    const outLength = chunkSzBlocks * blockSize;

    switch (chunkType) {
      case CHUNK_TYPE_RAW: {
        const expected = chunkHdrSz + outLength;
        if (totalSz !== expected) {
          throw new Error(
            `Malformed RAW chunk ${i}: total_sz ${totalSz} != expected ${expected}`
          );
        }
        chunks.push({ type: 'raw', outOffset, outLength, fileOffset: dataOffset });
        outBlocks += chunkSzBlocks;
        break;
      }
      case CHUNK_TYPE_FILL: {
        const fv = await viewAt(dataOffset, 4);
        chunks.push({
          type: 'fill',
          outOffset,
          outLength,
          fillValue: fv.getUint32(0, true),
        });
        outBlocks += chunkSzBlocks;
        break;
      }
      case CHUNK_TYPE_DONT_CARE: {
        chunks.push({ type: 'zero', outOffset, outLength });
        outBlocks += chunkSzBlocks;
        break;
      }
      case CHUNK_TYPE_CRC32: {
        // Verification-only chunk; does not advance the output stream.
        break;
      }
      default:
        throw new Error(
          `Unknown sparse chunk type 0x${chunkType.toString(16)} at chunk ${i}.`
        );
    }

    filePos += totalSz;
    if (onProgress && (i % 500 === 0 || i === totalChunks - 1)) {
      onProgress(i + 1, totalChunks);
    }
  }

  return {
    sparse: true,
    outputSize: totalBlocks * blockSize,
    blockSize,
    chunks,
  };
}

function rawPassthrough(file) {
  return {
    sparse: false,
    outputSize: file.size,
    blockSize: 1,
    chunks: [{ type: 'raw', outOffset: 0, outLength: file.size, fileOffset: 0 }],
  };
}
