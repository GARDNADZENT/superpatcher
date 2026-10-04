// Minimal read-only ZIP reader, just enough to locate and decompress one
// named entry (we use it to pull "AndroidManifest.xml" out of APKs without
// unpacking the whole archive). No ZIP64 support (irrelevant for the single
// small manifest entry we read out of ordinarily-small APKs).

const EOCD_SIG = 0x06054b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const LOCAL_FILE_SIG = 0x04034b50;

/**
 * @param {(offset:number, length:number) => Promise<Uint8Array>} readRange
 *   Random-access byte reader over the ZIP's bytes.
 * @param {number} totalSize
 */
export async function openZip(readRange, totalSize) {
  const maxCommentSearch = Math.min(totalSize, 65557); // 22 + max comment (65535)
  const tail = await readRange(totalSize - maxCommentSearch, maxCommentSearch);
  let eocdRelOffset = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (
      tail[i] === 0x50 &&
      tail[i + 1] === 0x4b &&
      tail[i + 2] === 0x05 &&
      tail[i + 3] === 0x06
    ) {
      eocdRelOffset = i;
      break;
    }
  }
  if (eocdRelOffset === -1) {
    throw new Error('Not a valid ZIP/APK file (End Of Central Directory record not found).');
  }
  const eocd = new DataView(tail.buffer, tail.byteOffset + eocdRelOffset, 22);
  if (eocd.getUint32(0, true) !== EOCD_SIG) throw new Error('EOCD signature mismatch.');
  const totalEntries = eocd.getUint16(10, true);
  const cdSize = eocd.getUint32(12, true);
  const cdOffset = eocd.getUint32(16, true);

  const cdBuf = await readRange(cdOffset, cdSize);
  const cdv = new DataView(cdBuf.buffer, cdBuf.byteOffset, cdBuf.byteLength);

  const entries = [];
  let pos = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > cdBuf.length) break;
    const sig = cdv.getUint32(pos, true);
    if (sig !== CENTRAL_DIR_SIG) break;
    const compressionMethod = cdv.getUint16(pos + 10, true);
    const compressedSize = cdv.getUint32(pos + 20, true);
    const uncompressedSize = cdv.getUint32(pos + 24, true);
    const nameLen = cdv.getUint16(pos + 28, true);
    const extraLen = cdv.getUint16(pos + 30, true);
    const commentLen = cdv.getUint16(pos + 32, true);
    const localHeaderOffset = cdv.getUint32(pos + 42, true);
    const nameBytes = cdBuf.subarray(pos + 46, pos + 46 + nameLen);
    const name = new TextDecoder('utf-8').decode(nameBytes);
    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  return {
    entries,
    async readEntry(entry) {
      // Local file header lengths can legitimately differ from the central
      // directory's (e.g. extra field padding), so re-read them.
      const lh = await readRange(entry.localHeaderOffset, 30);
      const lhv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
      if (lhv.getUint32(0, true) !== LOCAL_FILE_SIG) {
        throw new Error(`Local file header signature mismatch for "${entry.name}".`);
      }
      const nameLen = lhv.getUint16(26, true);
      const extraLen = lhv.getUint16(28, true);
      const dataOffset = entry.localHeaderOffset + 30 + nameLen + extraLen;
      const raw = await readRange(dataOffset, entry.compressedSize);
      if (entry.compressionMethod === 0) {
        return raw;
      }
      if (entry.compressionMethod === 8) {
        return await inflateRaw(raw);
      }
      throw new Error(
        `Unsupported ZIP compression method ${entry.compressionMethod} for "${entry.name}" (only stored/deflate are supported).`
      );
    },
  };
}

async function inflateRaw(compressed) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser does not support DecompressionStream (needed to decompress deflate data).');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([compressed]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export function findEntry(zip, name) {
  return zip.entries.find((e) => e.name === name) || null;
}
