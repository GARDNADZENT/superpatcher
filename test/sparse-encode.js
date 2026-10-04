// Minimal Android sparse-image encoder, used only to produce test fixtures
// (the real img2simg is obviously not available in this sandbox). Supports
// exactly what the decoder in src/sparse.js needs to be exercised: RAW,
// FILL and DONT_CARE chunks.

const SPARSE_HEADER_MAGIC = 0xed26ff3a;
const CHUNK_TYPE_RAW = 0xcac1;
const CHUNK_TYPE_FILL = 0xcac2;
const CHUNK_TYPE_DONT_CARE = 0xcac3;

/**
 * @param {Uint8Array} data full raw image content
 * @param {Array<{type:'raw'|'fill'|'zero', length:number, fillValue?:number}>} plan
 *   Describes how to chunk `data`, in order, covering it completely.
 *   `length` must be a multiple of blockSize for every entry.
 * @param {number} blockSize
 */
export function encodeSparse(data, plan, blockSize = 4096) {
  const chunkHdrSz = 12;
  const fileHdrSz = 28;
  let totalBlocks = 0;
  for (const p of plan) {
    if (p.length % blockSize !== 0) throw new Error('plan entry not block-aligned');
    totalBlocks += p.length / blockSize;
  }

  const pieces = [];
  let cursor = 0;
  for (const p of plan) {
    const blocks = p.length / blockSize;
    const chunkHeader = new Uint8Array(chunkHdrSz);
    const dv = new DataView(chunkHeader.buffer);
    if (p.type === 'raw') {
      dv.setUint16(0, CHUNK_TYPE_RAW, true);
      dv.setUint16(2, 0, true);
      dv.setUint32(4, blocks, true);
      dv.setUint32(8, chunkHdrSz + p.length, true);
      pieces.push(chunkHeader, data.subarray(cursor, cursor + p.length));
    } else if (p.type === 'fill') {
      dv.setUint16(0, CHUNK_TYPE_FILL, true);
      dv.setUint16(2, 0, true);
      dv.setUint32(4, blocks, true);
      dv.setUint32(8, chunkHdrSz + 4, true);
      const fillBytes = new Uint8Array(4);
      new DataView(fillBytes.buffer).setUint32(0, p.fillValue, true);
      pieces.push(chunkHeader, fillBytes);
    } else if (p.type === 'zero') {
      dv.setUint16(0, CHUNK_TYPE_DONT_CARE, true);
      dv.setUint16(2, 0, true);
      dv.setUint32(4, blocks, true);
      dv.setUint32(8, chunkHdrSz, true);
      pieces.push(chunkHeader);
    } else {
      throw new Error(`unknown plan type ${p.type}`);
    }
    cursor += p.length;
  }

  const fileHeader = new Uint8Array(fileHdrSz);
  const fdv = new DataView(fileHeader.buffer);
  fdv.setUint32(0, SPARSE_HEADER_MAGIC, true);
  fdv.setUint16(4, 1, true); // major
  fdv.setUint16(6, 0, true); // minor
  fdv.setUint16(8, fileHdrSz, true);
  fdv.setUint16(10, chunkHdrSz, true);
  fdv.setUint32(12, blockSize, true);
  fdv.setUint32(16, totalBlocks, true);
  fdv.setUint32(20, plan.length, true);
  fdv.setUint32(24, 0, true); // image_checksum (unused by our decoder)

  const totalLen = [fileHeader, ...pieces].reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const piece of [fileHeader, ...pieces]) {
    out.set(piece, off);
    off += piece.length;
  }
  return out;
}
