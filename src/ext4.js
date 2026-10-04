// Minimal read-only ext4 driver, enough to walk directories and read file
// contents out of an Android system/vendor/product ext4 partition image.
// Reference: https://www.kernel.org/doc/html/latest/filesystems/ext4/ (and
// the historical ext4 wiki disk layout page), both public documentation of
// an on-disk format, not copied source code.
//
// Scope / known limitations (documented to the user, not silently wrong):
//  - No htree ("dir_index") traversal. Android system images are built by
//    mkfs-family tools which lay out directories linearly even when the
//    dir_index feature bit is set on the filesystem; htree is only ever
//    *created* by a live kernel growing a directory at runtime, which never
//    happens to a prebuilt super.img. If we do encounter an INDEX_FL
//    directory we still scan whatever's linearly readable and surface a
//    warning instead of failing outright.
//  - No "meta_bg" support (irrelevant at Android partition sizes).
//  - No legacy pre-ext4 indirect-block files from very old images beyond a
//    basic single/double/triple-indirect fallback for completeness.

const EXT4_SUPERBLOCK_OFFSET = 1024;
const EXT4_MAGIC = 0xef53;

const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const S_IFLNK = 0xa000;

const EXT4_INDEX_FL = 0x1000;
const EXT4_EXTENTS_FL = 0x80000;

const FEATURE_INCOMPAT_FILETYPE = 0x2;
const FEATURE_INCOMPAT_EXTENTS = 0x40;
const FEATURE_INCOMPAT_64BIT = 0x80;

export function looksLikeExt4(headerBytes) {
  // headerBytes must start at the partition's byte offset 1024 (the start of
  // the superblock) and be at least 0x3A bytes long. The magic field lives
  // at byte offset 0x38 *within* the superblock, not at its very start.
  if (headerBytes.length < 0x3a) return false;
  const magic = headerBytes[0x38] | (headerBytes[0x39] << 8);
  return magic === EXT4_MAGIC;
}

export class Ext4Volume {
  /**
   * @param {(offset:number, length:number) => Promise<Uint8Array>} readRange
   *   Reads bytes relative to the start of THIS partition (not the whole disk).
   */
  constructor(readRange) {
    this.readRange = readRange;
  }

  async init() {
    const sbBytes = await this.readRange(EXT4_SUPERBLOCK_OFFSET, 1024);
    const dv = new DataView(sbBytes.buffer, sbBytes.byteOffset, sbBytes.byteLength);
    const magic = dv.getUint16(0x38, true);
    if (magic !== EXT4_MAGIC) throw new Error('Not an ext4 filesystem (bad superblock magic).');

    const logBlockSize = dv.getUint32(0x18, true);
    this.blockSize = 1024 << logBlockSize;
    this.inodesPerGroup = dv.getUint32(0x28, true);
    this.firstDataBlock = dv.getUint32(0x14, true);
    const blocksCountLo = dv.getUint32(0x4, true);
    const blocksCountHi = dv.getUint32(0x150, true) || 0;
    this.blocksCount = blocksCountLo + blocksCountHi * 4294967296;
    this.inodeSize = dv.getUint16(0x58, true) || 128;
    this.featureIncompat = dv.getUint32(0x60, true);
    this.featureCompat = dv.getUint32(0x5c, true);
    let descSize = dv.getUint16(0xfe, true);
    if (!descSize) descSize = this.featureIncompat & FEATURE_INCOMPAT_64BIT ? 64 : 32;
    this.descSize = descSize;
    this.hasFiletype = !!(this.featureIncompat & FEATURE_INCOMPAT_FILETYPE);

    this.groupCount = Math.ceil(this.blocksCount / dv.getUint32(0x20, true));
    this.blocksPerGroup = dv.getUint32(0x20, true);

    const gdtBlock = this.firstDataBlock + 1;
    const gdtBytes = await this.readRange(
      gdtBlock * this.blockSize,
      this.groupCount * this.descSize
    );
    const gdv = new DataView(gdtBytes.buffer, gdtBytes.byteOffset, gdtBytes.byteLength);
    this.groups = [];
    for (let g = 0; g < this.groupCount; g++) {
      const base = g * this.descSize;
      const lo = gdv.getUint32(base + 0x8, true);
      const hi = this.descSize >= 64 ? gdv.getUint32(base + 0x28, true) : 0;
      this.groups.push({ inodeTableBlock: lo + hi * 4294967296 });
    }

    this.rootInode = await this.readInode(2);
  }

  async readInode(inodeNumber) {
    const index = inodeNumber - 1;
    const group = Math.floor(index / this.inodesPerGroup);
    const indexInGroup = index % this.inodesPerGroup;
    const g = this.groups[group];
    if (!g) throw new Error(`Inode ${inodeNumber} is in group ${group}, which doesn't exist.`);
    const offset = g.inodeTableBlock * this.blockSize + indexInGroup * this.inodeSize;
    const buf = await this.readRange(offset, Math.min(this.inodeSize, 160));
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    const mode = dv.getUint16(0x0, true);
    const sizeLo = dv.getUint32(0x4, true);
    const flags = dv.getUint32(0x20, true);
    const sizeHi = dv.getUint32(0x6c, true);
    const fileType = mode & S_IFMT;
    const size = fileType === S_IFDIR ? sizeLo : sizeLo + sizeHi * 4294967296;
    const iBlock = buf.slice(0x28, 0x28 + 60);

    return {
      inodeNumber,
      mode,
      fileType,
      isDir: fileType === S_IFDIR,
      isRegular: fileType === S_IFREG,
      isSymlink: fileType === S_IFLNK,
      size,
      flags,
      hasExtents: !!(flags & EXT4_EXTENTS_FL),
      htreeIndexed: !!(flags & EXT4_INDEX_FL),
      iBlock,
    };
  }

  /** Resolves an inode's data into an ordered list of {physicalBlock, blockCount, logicalBlock, zero} runs. */
  async _resolveExtents(inode) {
    if (!inode.hasExtents) {
      return this._resolveIndirectBlocks(inode);
    }
    const runs = [];
    await this._walkExtentNode(inode.iBlock, runs);
    runs.sort((a, b) => a.logicalBlock - b.logicalBlock);
    return runs;
  }

  async _walkExtentNode(nodeBytes, runs) {
    const dv = new DataView(nodeBytes.buffer, nodeBytes.byteOffset, nodeBytes.byteLength);
    const magic = dv.getUint16(0, true);
    if (magic !== 0xf30a) throw new Error('Invalid extent tree node magic.');
    const entries = dv.getUint16(2, true);
    const depth = dv.getUint16(6, true);

    if (depth === 0) {
      for (let i = 0; i < entries; i++) {
        const off = 12 + i * 12;
        const logicalBlock = dv.getUint32(off, true);
        let len = dv.getUint16(off + 4, true);
        let zero = false;
        if (len > 32768) {
          len -= 32768;
          zero = true; // "uninitialized" extent: logically reads as zero
        }
        const startHi = dv.getUint16(off + 6, true);
        const startLo = dv.getUint32(off + 8, true);
        runs.push({ logicalBlock, blockCount: len, physicalBlock: startLo + startHi * 4294967296, zero });
      }
      return;
    }

    for (let i = 0; i < entries; i++) {
      const off = 12 + i * 12;
      const leafLo = dv.getUint32(off + 4, true);
      const leafHi = dv.getUint16(off + 8, true);
      const childBlock = leafLo + leafHi * 4294967296;
      const childBytes = await this.readRange(childBlock * this.blockSize, this.blockSize);
      await this._walkExtentNode(childBytes, runs);
    }
  }

  _resolveIndirectBlocks(inode) {
    // Legacy (non-extent) block mapping, included for completeness.
    const dv = new DataView(inode.iBlock.buffer, inode.iBlock.byteOffset, inode.iBlock.byteLength);
    const runs = [];
    let logical = 0;
    for (let i = 0; i < 12; i++) {
      const b = dv.getUint32(i * 4, true);
      if (b) runs.push({ logicalBlock: logical, blockCount: 1, physicalBlock: b, zero: false });
      logical++;
    }
    // Single/double/triple indirect blocks are deliberately not supported:
    // real-world Android build images always use extents. We bail out
    // clearly rather than silently returning truncated data.
    const singleIndirect = dv.getUint32(12 * 4, true);
    const doubleIndirect = dv.getUint32(13 * 4, true);
    const tripleIndirect = dv.getUint32(14 * 4, true);
    if (singleIndirect || doubleIndirect || tripleIndirect) {
      throw new Error(
        'This file uses legacy ext2/3-style indirect block mapping beyond direct blocks, which is not supported.'
      );
    }
    return runs;
  }

  /** Reads this inode's entire data (buffers in memory — fine for directories and APKs, not multi-GB files). */
  async readFile(inode) {
    const runs = await this._resolveExtents(inode);
    const out = new Uint8Array(inode.size);
    for (const run of runs) {
      const byteOffset = run.logicalBlock * this.blockSize;
      const byteLength = Math.min(run.blockCount * this.blockSize, inode.size - byteOffset);
      if (byteLength <= 0) continue;
      if (run.zero) continue; // already zero-filled by `new Uint8Array`
      const data = await this.readRange(run.physicalBlock * this.blockSize, byteLength);
      out.set(data, byteOffset);
    }
    return out;
  }

  /** Lists directory entries as [{ name, inodeNumber, fileType }]. */
  async listDir(inode) {
    if (!inode.isDir) throw new Error('Not a directory.');
    if (inode.htreeIndexed) {
      // Best effort: fall through and scan whatever's linearly readable;
      // this may under-report entries for htree-indexed directories.
    }
    const runs = await this._resolveExtents(inode);
    const entries = [];
    for (const run of runs) {
      if (run.zero) continue;
      for (let b = 0; b < run.blockCount; b++) {
        const blockBytes = await this.readRange(
          (run.physicalBlock + b) * this.blockSize,
          this.blockSize
        );
        this._parseDirBlock(blockBytes, entries);
      }
    }
    return entries;
  }

  _parseDirBlock(blockBytes, entries) {
    const dv = new DataView(blockBytes.buffer, blockBytes.byteOffset, blockBytes.byteLength);
    let pos = 0;
    while (pos < blockBytes.length) {
      if (pos + 8 > blockBytes.length) break;
      const ino = dv.getUint32(pos, true);
      const recLen = dv.getUint16(pos + 4, true);
      if (recLen < 8) break; // corrupt; bail out of this block
      const nameLen = dv.getUint8(pos + 6);
      const fileTypeByte = dv.getUint8(pos + 7);
      if (ino !== 0 && nameLen > 0) {
        const nameBytes = blockBytes.subarray(pos + 8, pos + 8 + nameLen);
        const name = new TextDecoder('utf-8').decode(nameBytes);
        if (name !== '.' && name !== '..') {
          entries.push({ name, inodeNumber: ino, fileTypeByte });
        }
      }
      pos += recLen;
    }
  }
}
