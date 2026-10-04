// Minimal read-only EROFS driver, enough to walk directories and read
// uncompressed file contents out of an Android system/vendor/product EROFS
// partition image.
// Reference: erofs-utils `include/erofs_fs.h` (GPL-2.0, Huawei / OpenHarmony
// & Linux kernel community) — an on-disk format header, consulted for
// struct layouts, not copied as code.
//
// Scope / known limitations (documented to the user, not silently wrong):
//  - Only EROFS_INODE_FLAT_PLAIN (0) and EROFS_INODE_FLAT_INLINE (2) data
//    layouts are supported for file *contents*. Compressed layouts
//    (COMPRESSED_FULL=1, COMPRESSED_COMPACT=3) and CHUNK_BASED (4) are
//    detected and reported per-file as unavailable rather than crashing.
//    Directory traversal (names/sizes/types) works regardless, since
//    directories are practically always stored uncompressed.
//  - No 48BIT / metabox / multi-device support (not seen in standard
//    single-image Android partitions; would need real-world fixtures).

import { crc32c } from './crc32c.js';

const EROFS_SUPER_OFFSET = 1024;
const EROFS_MAGIC = 0xe0f5e1e2;
const FEATURE_COMPAT_SB_CHKSUM = 0x1;

const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const S_IFLNK = 0xa000;

const FEATURE_INCOMPAT_48BIT = 0x80;

const EROFS_FT_DIR = 2;
const EROFS_I_DOT_OMITTED_BIT = 0x10; // bit 4 of i_format, directory-only meaning

export const EROFS_INODE_FLAT_PLAIN = 0;
export const EROFS_INODE_COMPRESSED_FULL = 1;
export const EROFS_INODE_FLAT_INLINE = 2;
export const EROFS_INODE_COMPRESSED_COMPACT = 3;
export const EROFS_INODE_CHUNK_BASED = 4;

const LAYOUT_NAMES = {
  0: 'FLAT_PLAIN',
  1: 'COMPRESSED_FULL',
  2: 'FLAT_INLINE',
  3: 'COMPRESSED_COMPACT',
  4: 'CHUNK_BASED',
};

export function looksLikeErofs(headerBytes) {
  // headerBytes must start at the partition's byte offset 1024, >= 4 bytes.
  if (headerBytes.length < 4) return false;
  const dv = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  return dv.getUint32(0, true) === EROFS_MAGIC;
}

function xattrIbodySize(icount) {
  if (icount === 0) return 0;
  return 12 + 4 * (icount - 1);
}

export class ErofsVolume {
  /**
   * @param {(offset:number, length:number) => Promise<Uint8Array>} readRange
   *   Reads bytes relative to the start of THIS partition.
   */
  /**
   * @param {(offset:number, length:number) => Promise<Uint8Array>} readRange
   * @param {(offset:number, bytes:Uint8Array) => void} [writeRange]
   *   Optional. Offsets relative to the start of THIS partition. Required
   *   only for removeDirEntry(); omit for read-only (scan) usage.
   */
  constructor(readRange, writeRange) {
    this.readRange = readRange;
    this.writeRange = writeRange;
  }

  async init() {
    const sb = await this.readRange(EROFS_SUPER_OFFSET, 144);
    const dv = new DataView(sb.buffer, sb.byteOffset, sb.byteLength);
    const magic = dv.getUint32(0, true);
    if (magic !== EROFS_MAGIC) throw new Error('Not an EROFS filesystem (bad superblock magic).');

    this.blkszbits = dv.getUint8(12);
    this.blockSize = 1 << this.blkszbits;
    this.sbExtslots = dv.getUint8(13);
    this.featureCompat = dv.getUint32(8, true);
    this.sbChecksumEnabled = !!(this.featureCompat & FEATURE_COMPAT_SB_CHKSUM);
    this.featureIncompat = dv.getUint32(80, true);
    const is48bit = !!(this.featureIncompat & FEATURE_INCOMPAT_48BIT);
    this.rootNid = is48bit ? Number(dv.getBigUint64(112, true)) : dv.getUint16(14, true);
    this.metaBlkaddr = dv.getUint32(40, true);
    this.dirblkbits = dv.getUint8(90) || this.blkszbits;
    this.dirBlockSize = 1 << this.dirblkbits;

    this.rootInode = await this.readInode(this.rootNid);
  }

  _nidToOffset(nid) {
    return this.metaBlkaddr * this.blockSize + nid * 32;
  }

  async readInode(nid) {
    const base = this._nidToOffset(nid);
    const head = await this.readRange(base, 64); // enough for either format
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const iFormat = dv.getUint16(0, true);
    const extended = !!(iFormat & 0x1);
    const datalayout = (iFormat >> 1) & 0x7;
    const isDirByMode = (dv.getUint16(4, true) & S_IFMT) === S_IFDIR;
    // Bit 4 of i_format means different things for directories ("dot
    // omitted") vs. other inode types ("nlink is implicitly 1, i_nb
    // repurposed for 48-bit startblk high bits") — see EROFS_I_NLINK_1_BIT
    // / EROFS_I_DOT_OMITTED_BIT in erofs_fs.h (same bit, different meaning).
    const bit4 = !!(iFormat & EROFS_I_DOT_OMITTED_BIT);
    const dotOmitted = isDirByMode && bit4;
    const nlinkIsImplicitlyOne = !isDirByMode && bit4;

    const xattrIcount = dv.getUint16(2, true);
    const mode = dv.getUint16(4, true);
    const fileType = mode & S_IFMT;

    let size, inodeStructSize, startblkLo, startblkHi, nlink, nlinkOffset, nlinkSize;
    if (!extended) {
      // compact (32 bytes)
      inodeStructSize = 32;
      size = dv.getUint32(8, true);
      startblkLo = dv.getUint32(16, true);
      startblkHi = nlinkIsImplicitlyOne ? dv.getUint16(6, true) : 0;
      nlink = nlinkIsImplicitlyOne ? 1 : dv.getUint16(6, true);
      nlinkOffset = base + 6;
      nlinkSize = 2;
    } else {
      // extended (64 bytes)
      inodeStructSize = 64;
      size = Number(dv.getBigUint64(8, true));
      startblkLo = dv.getUint32(16, true);
      startblkHi = nlinkIsImplicitlyOne ? dv.getUint16(6, true) : 0;
      nlink = dv.getUint32(44, true);
      nlinkOffset = base + 44;
      nlinkSize = 4;
    }

    const startblk = startblkLo + startblkHi * 4294967296;
    const xattrSize = xattrIbodySize(xattrIcount);
    const dataOffset = base + inodeStructSize + xattrSize;

    return {
      nid,
      byteOffset: base,
      extended,
      inodeStructSize,
      mode,
      fileType,
      isDir: fileType === S_IFDIR,
      isRegular: fileType === S_IFREG,
      isSymlink: fileType === S_IFLNK,
      size,
      sizeFieldOffset: base + 8,
      sizeFieldBytes: extended ? 8 : 4,
      nlink,
      nlinkOffset,
      nlinkSize,
      dotOmitted,
      datalayout,
      datalayoutName: LAYOUT_NAMES[datalayout] ?? `unknown(${datalayout})`,
      startblk,
      dataOffset, // offset right after inode header + inline xattrs (inline tail / inline dirent data lives here)
      supported: datalayout === EROFS_INODE_FLAT_PLAIN || datalayout === EROFS_INODE_FLAT_INLINE,
    };
  }

  /** Reads a FLAT_PLAIN/FLAT_INLINE inode's full data. Throws for compressed/chunked layouts. */
  async readFile(inode) {
    if (!inode.supported) {
      throw new Error(
        `Contents unavailable: EROFS datalayout ${inode.datalayoutName} is compressed/chunked and not supported by this reader.`
      );
    }
    const out = new Uint8Array(inode.size);
    const fullBlocks =
      inode.datalayout === EROFS_INODE_FLAT_INLINE
        ? Math.floor(inode.size / this.blockSize)
        : Math.ceil(inode.size / this.blockSize);
    if (fullBlocks > 0) {
      const fullBytes = Math.min(fullBlocks * this.blockSize, inode.size);
      const data = await this.readRange(inode.startblk * this.blockSize, fullBytes);
      out.set(data.subarray(0, fullBytes), 0);
    }
    if (inode.datalayout === EROFS_INODE_FLAT_INLINE) {
      const tailLen = inode.size % this.blockSize;
      if (tailLen > 0) {
        const tail = await this.readRange(inode.dataOffset, tailLen);
        out.set(tail, inode.size - tailLen);
      }
    }
    return out;
  }

  /** Lists directory entries as [{ name, nid, fileType }]. Directories are always uncompressed in practice. */
  async listDir(inode) {
    const raw = await this._listDirRaw(inode);
    return raw.filter((e) => e.name !== '.' && e.name !== '..');
  }

  /**
   * Walks every block (+ inline tail) of a directory inode and returns
   * every physical dirent in on-disk order, INCLUDING "." and ".." if they
   * are physically present (they normally are — mkfs.erofs only omits them
   * when the DOT_OMITTED inode flag is set). Used by both listDir() and
   * removeDirEntry(), which needs the exact raw layout to rebuild it.
   */
  async _listDirRaw(inode) {
    if (!inode.isDir) throw new Error('Not a directory.');
    if (!inode.supported) {
      throw new Error(`Cannot list directory with datalayout ${inode.datalayoutName}.`);
    }
    const entries = [];
    const fullBlocks =
      inode.datalayout === EROFS_INODE_FLAT_INLINE
        ? Math.floor(inode.size / this.dirBlockSize)
        : Math.ceil(inode.size / this.dirBlockSize);

    for (let b = 0; b < fullBlocks; b++) {
      const isLast = b === fullBlocks - 1 && inode.datalayout !== EROFS_INODE_FLAT_INLINE;
      const blockLen = isLast ? inode.size - b * this.dirBlockSize : this.dirBlockSize;
      const blockBytes = await this.readRange(inode.startblk * this.blockSize + b * this.dirBlockSize, blockLen);
      this._parseDirBlock(blockBytes, entries);
    }
    if (inode.datalayout === EROFS_INODE_FLAT_INLINE) {
      const tailLen = inode.size % this.dirBlockSize;
      if (tailLen > 0) {
        const tail = await this.readRange(inode.dataOffset, tailLen);
        this._parseDirBlock(tail, entries);
      }
    }
    return entries;
  }

  _parseDirBlock(blockBytes, entries) {
    if (blockBytes.length < 12) return;
    const dv = new DataView(blockBytes.buffer, blockBytes.byteOffset, blockBytes.byteLength);
    const firstNameoff = dv.getUint16(8, true);
    const direntCount = Math.floor(firstNameoff / 12);
    const decoder = new TextDecoder('utf-8');
    for (let i = 0; i < direntCount; i++) {
      const off = i * 12;
      const nid = Number(dv.getBigUint64(off, true));
      const nameoff = dv.getUint16(off + 8, true);
      const fileType = dv.getUint8(off + 10);
      const nameEnd = i + 1 < direntCount ? dv.getUint16(off + 12 + 8, true) : blockBytes.length;
      let nameBytes = blockBytes.subarray(nameoff, nameEnd);
      // Names are NUL-padded to the next entry's offset in some encoders; trim trailing NULs.
      let trimEnd = nameBytes.length;
      while (trimEnd > 0 && nameBytes[trimEnd - 1] === 0) trimEnd--;
      nameBytes = nameBytes.subarray(0, trimEnd);
      const name = decoder.decode(nameBytes);
      if (name.length > 0) {
        entries.push({ name, nid, fileType });
      }
    }
  }

  /**
   * Removes one directory entry named `targetName` from `parentInode`, by
   * rebuilding the directory's entire content (minus that one entry) and
   * rewriting it into the SAME already-allocated storage (full blocks at
   * startblk, plus an inline tail at dataOffset for FLAT_INLINE inodes),
   * using the same greedy per-block packing convention mkfs.erofs itself
   * uses (as many whole entries as fit per block; no entry ever spans a
   * block boundary). The directory inode's own i_size is patched in place.
   *
   * EROFS has no per-directory-block or per-inode checksum (unlike ext4's
   * metadata_csum) — only a whole-superblock checksum feature exists,
   * which doesn't cover file/directory data, so no checksum recomputation
   * is needed here. Deliberately does not free the target's own storage or
   * touch any bitmap/free-space accounting (EROFS doesn't track those at
   * all; it's a read-only format with no delete/orphan concept), so the
   * removed entry's inode and data blocks are simply abandoned in place.
   *
   * @param {object} parentInode as returned by readInode()
   * @param {string} targetName exact entry name to remove (not a path)
   * @returns {Promise<boolean>} true if found and removed, false if not found
   */
  async removeDirEntry(parentInode, targetName) {
    if (!this.writeRange) {
      throw new Error('This ErofsVolume was opened read-only; cannot remove entries.');
    }
    if (!parentInode.isDir) {
      throw new Error('removeDirEntry: parent is not a directory.');
    }
    if (!parentInode.supported) {
      throw new Error(`Cannot modify directory with datalayout ${parentInode.datalayoutName}.`);
    }
    if (parentInode.dotOmitted) {
      throw new Error(
        'This directory has the DOT_OMITTED flag set, which removeDirEntry does not support rebuilding.'
      );
    }

    const rawEntries = await this._listDirRaw(parentInode);
    const idx = rawEntries.findIndex((e) => e.name === targetName);
    if (idx === -1) return false;
    if (targetName === '.' || targetName === '..') {
      throw new Error('Refusing to remove "." or ".." — that would corrupt the directory structure.');
    }
    const removedFileType = rawEntries[idx].fileType;
    const newEntries = rawEntries.slice(0, idx).concat(rawEntries.slice(idx + 1));

    await this._rewriteDirectoryContent(parentInode, newEntries);

    if (removedFileType === EROFS_FT_DIR) {
      await this._adjustNlink(parentInode, -1);
    }

    // The whole-superblock checksum (when the SB_CHKSUM compat feature is
    // enabled) covers bytes [1024, blocksize) — normally nowhere near a
    // real Android partition's /app or /priv-app directories, but on tiny
    // test images (or any filesystem whose meta area starts at block 0)
    // an edit can land inside that range. Always recomputing it after a
    // removal is cheap and makes this correct unconditionally.
    await this._recomputeSuperblockChecksum();
    return true;
  }

  /**
   * Recomputes and rewrites the EROFS superblock's own CRC32-C checksum
   * (when the SB_CHKSUM compat feature is enabled): crc32c(0xFFFFFFFF,
   * bytes[1024 : blocksize)) with the 4-byte checksum field itself (at
   * relative offset 4) treated as zero — verified against a real
   * mkfs.erofs-produced superblock.
   */
  async _recomputeSuperblockChecksum() {
    if (!this.sbChecksumEnabled) return;
    const length = this.blockSize - EROFS_SUPER_OFFSET;
    const sbBytes = await this.readRange(EROFS_SUPER_OFFSET, length);
    const copy = new Uint8Array(sbBytes);
    copy.set([0, 0, 0, 0], 4);
    const crc = crc32c(0xffffffff, copy);
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, crc, true);
    this.writeRange(EROFS_SUPER_OFFSET + 4, out);
  }

  /** Greedily packs `entries` into dirBlockSize-sized chunks, mkfs.erofs-style (no entry spans a block boundary). */
  _packDirentBlocks(entries) {
    const encoder = new TextEncoder();
    const prepared = entries.map((e) => ({ nid: e.nid, fileType: e.fileType, nameBytes: encoder.encode(e.name) }));

    const blocks = [];
    let current = [];
    let currentSize = 0;
    for (const e of prepared) {
      const entrySize = 12 + e.nameBytes.length;
      if (entrySize > this.dirBlockSize) {
        throw new Error(`Directory entry name too long to fit in one dirblock (${this.dirBlockSize} bytes).`);
      }
      if (current.length > 0 && currentSize + entrySize > this.dirBlockSize) {
        blocks.push(current);
        current = [];
        currentSize = 0;
      }
      current.push(e);
      currentSize += entrySize;
    }
    blocks.push(current); // always at least one (possibly partial) block, since "." + ".." always remain

    return blocks.map((blockEntries) => {
      const direntArraySize = blockEntries.length * 12;
      let nameCursor = direntArraySize;
      const nameOffsets = blockEntries.map((e) => {
        const off = nameCursor;
        nameCursor += e.nameBytes.length;
        return off;
      });
      const contentSize = nameCursor;
      const buf = new Uint8Array(contentSize); // exact, unpadded size for this block's real content
      const dv = new DataView(buf.buffer);
      blockEntries.forEach((e, i) => {
        const off = i * 12;
        dv.setBigUint64(off, BigInt(e.nid), true);
        dv.setUint16(off + 8, nameOffsets[i], true);
        dv.setUint8(off + 10, e.fileType);
        dv.setUint8(off + 11, 0);
        buf.set(e.nameBytes, nameOffsets[i]);
      });
      return buf; // caller decides whether/how to pad this (only the true last block may stay unpadded)
    });
  }

  /**
   * Rewrites a directory inode's full content (all its dirent blocks, plus
   * inline tail if FLAT_INLINE) to hold exactly `entries`, preserving the
   * inode's existing datalayout (FLAT_PLAIN vs FLAT_INLINE) and physical
   * storage locations (startblk / dataOffset) — this only ever shrinks
   * content (a removal), so it always fits in the already-allocated space.
   */
  async _rewriteDirectoryContent(inode, entries) {
    const packedBlocks = this._packDirentBlocks(entries); // last one may be shorter than dirBlockSize
    const lastBlock = packedBlocks[packedBlocks.length - 1];
    const hasPartialLast = lastBlock.length < this.dirBlockSize;
    const fullBlocks = hasPartialLast ? packedBlocks.slice(0, -1) : packedBlocks;
    const tailContent = hasPartialLast ? lastBlock : new Uint8Array(0);

    // Zero out the OLD full-block region entirely first (always exclusively
    // ours — EROFS never shares a whole data block between inodes), so no
    // stale entries from the larger original directory linger beyond the
    // new content.
    const oldFullBlockCount =
      inode.datalayout === EROFS_INODE_FLAT_INLINE
        ? Math.floor(inode.size / this.dirBlockSize)
        : Math.ceil(inode.size / this.dirBlockSize);
    if (oldFullBlockCount > 0) {
      this.writeRange(inode.startblk * this.blockSize, new Uint8Array(oldFullBlockCount * this.dirBlockSize));
    }

    if (inode.datalayout === EROFS_INODE_FLAT_INLINE) {
      if (fullBlocks.length > 0) {
        this.writeRange(inode.startblk * this.blockSize, concatBytes(fullBlocks));
      }
      if (tailContent.length > 0) {
        this.writeRange(inode.dataOffset, tailContent);
      }
      const newSize = fullBlocks.length * this.dirBlockSize + tailContent.length;
      await this._setInodeSize(inode, newSize);
    } else {
      // FLAT_PLAIN: no separate tail storage location — any partial last
      // block still occupies a full physical block, just padded with
      // zero bytes beyond the logical size (which the reader never looks
      // at, since it bounds every read by i_size).
      const physicalBlocks = tailContent.length > 0 ? fullBlocks.concat([padToBlockSize(tailContent, this.dirBlockSize)]) : fullBlocks;
      if (physicalBlocks.length > 0) {
        this.writeRange(inode.startblk * this.blockSize, concatBytes(physicalBlocks));
      }
      const newSize = fullBlocks.length * this.dirBlockSize + tailContent.length;
      await this._setInodeSize(inode, newSize);
    }
  }

  /** Patches an inode's i_size field in place (compact: 4 bytes; extended: 8 bytes). */
  async _setInodeSize(inode, newSize) {
    const buf = new Uint8Array(inode.sizeFieldBytes);
    const dv = new DataView(buf.buffer);
    if (inode.sizeFieldBytes === 8) {
      dv.setBigUint64(0, BigInt(newSize), true);
    } else {
      dv.setUint32(0, newSize, true);
    }
    this.writeRange(inode.sizeFieldOffset, buf);
    inode.size = newSize;
  }

  /** Adjusts (by `delta`, typically -1) an inode's on-disk nlink field in place. */
  async _adjustNlink(inode, delta) {
    const current = await this._readNlink(inode);
    const next = Math.max(0, current + delta);
    const buf = new Uint8Array(inode.nlinkSize);
    const dv = new DataView(buf.buffer);
    if (inode.nlinkSize === 4) dv.setUint32(0, next, true);
    else dv.setUint16(0, next, true);
    this.writeRange(inode.nlinkOffset, buf);
    inode.nlink = next;
  }

  async _readNlink(inode) {
    const buf = await this.readRange(inode.nlinkOffset, inode.nlinkSize);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return inode.nlinkSize === 4 ? dv.getUint32(0, true) : dv.getUint16(0, true);
  }
}

function concatBytes(arrays) {
  const total = arrays.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

function padToBlockSize(bytes, blockSize) {
  if (bytes.length === blockSize) return bytes;
  const out = new Uint8Array(blockSize);
  out.set(bytes, 0);
  return out;
}
