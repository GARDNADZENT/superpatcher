// Presents one or more (possibly sparse) source files as a single,
// contiguous, randomly-readable "virtual disk" — the fully unsparsed
// super.img — without ever materializing it in memory or on disk.
//
// This is what makes it possible to handle multi-gigabyte images in a
// browser tab: reads are served directly from the underlying File objects
// (via Blob.slice()) or synthesized on the fly for fill/zero regions.
import { readFileRangeWithRetry } from './file-read-retry.js';

export class VirtualDisk {
  /**
   * @param {Array<{file: Blob, index: {outputSize:number, chunks:Array}}>} parts
   *   Ordered list of source files (e.g. super.img, super_1.img, ...), each
   *   with its sparse-chunk index. Parts are concatenated in array order.
   * @param {object} [opts]
   * @param {(attempt:number, err:Error) => void} [opts.onReadRetry] called
   *   when a raw file read transiently fails and is about to be retried
   *   (see file-read-retry.js) -- e.g. to surface a log line in the UI
   *   during a long multi-gigabyte build instead of just pausing silently.
   */
  constructor(parts, opts = {}) {
    this.files = parts.map((p) => p.file);
    this.onReadRetry = opts.onReadRetry;
    this.chunks = [];
    let base = 0;
    parts.forEach((part, fileIndex) => {
      for (const c of part.index.chunks) {
        this.chunks.push({
          type: c.type,
          outOffset: base + c.outOffset,
          outLength: c.outLength,
          fileOffset: c.fileOffset,
          fillValue: c.fillValue,
          fileIndex,
        });
      }
      base += part.index.outputSize;
    });
    this.chunks.sort((a, b) => a.outOffset - b.outOffset);
    this.totalSize = base;

    // Sanity-check contiguity (no gaps/overlaps), which should always hold
    // for well-formed sparse files concatenated in the right order.
    let cursor = 0;
    for (const c of this.chunks) {
      if (c.outOffset !== cursor) {
        throw new Error(
          `Virtual disk has a gap or overlap at offset ${cursor} (next chunk starts at ${c.outOffset}). ` +
            `If you selected multiple split super images, make sure they are in the correct order.`
        );
      }
      cursor += c.outLength;
    }
  }

  /** Binary search: index of the last chunk whose outOffset <= offset. */
  _findChunkIndex(offset) {
    let lo = 0;
    let hi = this.chunks.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.chunks[mid].outOffset <= offset) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  async _readFromChunk(c, relOffset, length) {
    if (length === 0) return new Uint8Array(0);
    if (c.type === 'raw') {
      const file = this.files[c.fileIndex];
      const start = c.fileOffset + relOffset;
      return readFileRangeWithRetry(file, start, length, { onRetry: this.onReadRetry });
    }
    if (c.type === 'fill') {
      const out = new Uint8Array(length);
      const pattern = new Uint8Array(4);
      new DataView(pattern.buffer).setUint32(0, c.fillValue, true);
      for (let i = 0; i < length; i++) {
        out[i] = pattern[(relOffset + i) & 3];
      }
      return out;
    }
    // 'zero' (don't-care sparse hole, or a ZERO/dm-zero extent)
    return new Uint8Array(length);
  }

  /**
   * Read [offset, offset+length) into a single Uint8Array. Intended for
   * small reads (metadata parsing), not bulk partition extraction.
   */
  async read(offset, length) {
    if (offset < 0 || length < 0 || offset + length > this.totalSize) {
      throw new Error(
        `Read out of range: offset=${offset} length=${length} totalSize=${this.totalSize}`
      );
    }
    const out = new Uint8Array(length);
    let filled = 0;
    let idx = this._findChunkIndex(offset);
    let pos = offset;
    while (filled < length) {
      const c = this.chunks[idx];
      const chunkEnd = c.outOffset + c.outLength;
      const readEnd = Math.min(offset + length, chunkEnd);
      const len = readEnd - pos;
      const bytes = await this._readFromChunk(c, pos - c.outOffset, len);
      out.set(bytes, filled);
      filled += len;
      pos += len;
      idx++;
    }
    return out;
  }

  /**
   * Async generator yielding sequential Uint8Array pieces (each at most
   * `pieceSize` bytes) covering [offset, offset+length). Use this for bulk
   * extraction so memory stays bounded regardless of partition size.
   */
  async *streamRange(offset, length, pieceSize = 16 * 1024 * 1024) {
    if (offset < 0 || length < 0 || offset + length > this.totalSize) {
      throw new Error(
        `Read out of range: offset=${offset} length=${length} totalSize=${this.totalSize}`
      );
    }
    if (length === 0) return;
    let idx = this._findChunkIndex(offset);
    let pos = offset;
    const end = offset + length;
    while (pos < end) {
      const c = this.chunks[idx];
      const chunkEnd = c.outOffset + c.outLength;
      const segEnd = Math.min(end, chunkEnd);
      let segPos = pos;
      while (segPos < segEnd) {
        const take = Math.min(pieceSize, segEnd - segPos);
        yield await this._readFromChunk(c, segPos - c.outOffset, take);
        segPos += take;
      }
      pos = segEnd;
      idx++;
    }
  }
}

/** Natural (numeric-aware) sort, so super_2.img sorts before super_10.img. */
export function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const aParts = a.match(re) || [];
  const bParts = b.match(re) || [];
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i] ?? '';
    const bp = bParts[i] ?? '';
    if (ap === bp) continue;
    const an = Number(ap);
    const bn = Number(bp);
    const bothNumeric = ap !== '' && bp !== '' && !Number.isNaN(an) && !Number.isNaN(bn);
    if (bothNumeric) {
      if (an !== bn) return an - bn;
      continue;
    }
    return ap < bp ? -1 : 1;
  }
  return 0;
}
