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

const EROFS_SUPER_OFFSET = 1024;
const EROFS_MAGIC = 0xe0f5e1e2;

const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const S_IFLNK = 0xa000;

const FEATURE_INCOMPAT_48BIT = 0x80;

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
  constructor(readRange) {
    this.readRange = readRange;
  }

  async init() {
    const sb = await this.readRange(EROFS_SUPER_OFFSET, 144);
    const dv = new DataView(sb.buffer, sb.byteOffset, sb.byteLength);
    const magic = dv.getUint32(0, true);
    if (magic !== EROFS_MAGIC) throw new Error('Not an EROFS filesystem (bad superblock magic).');

    this.blkszbits = dv.getUint8(12);
    this.blockSize = 1 << this.blkszbits;
    this.sbExtslots = dv.getUint8(13);
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
    const bit4 = !!(iFormat & 0x10);

    const xattrIcount = dv.getUint16(2, true);
    const mode = dv.getUint16(4, true);
    const fileType = mode & S_IFMT;

    let size, inodeStructSize, startblkLo, startblkHi;
    if (!extended) {
      // compact (32 bytes)
      inodeStructSize = 32;
      size = dv.getUint32(8, true);
      startblkLo = dv.getUint32(16, true);
      startblkHi = bit4 ? dv.getUint16(6, true) : 0;
    } else {
      // extended (64 bytes)
      inodeStructSize = 64;
      size = Number(dv.getBigUint64(8, true));
      startblkLo = dv.getUint32(16, true);
      startblkHi = bit4 ? dv.getUint16(6, true) : 0;
    }

    const startblk = startblkLo + startblkHi * 4294967296;
    const xattrSize = xattrIbodySize(xattrIcount);
    const dataOffset = base + inodeStructSize + xattrSize;

    return {
      nid,
      mode,
      fileType,
      isDir: fileType === S_IFDIR,
      isRegular: fileType === S_IFREG,
      isSymlink: fileType === S_IFLNK,
      size,
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
      if (name !== '.' && name !== '..' && name.length > 0) {
        entries.push({ name, nid, fileType });
      }
    }
  }
}
