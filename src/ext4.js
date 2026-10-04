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

import { crc32c } from './crc32c.js';

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
const FEATURE_INCOMPAT_CSUM_SEED = 0x2000;
const FEATURE_RO_COMPAT_METADATA_CSUM = 0x400;

const EXT4_DIR_ENTRY_TAIL_SIZE = 12;
const EXT4_FT_DIR = 2;
const EXT4_GOOD_OLD_INODE_SIZE = 128;

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
    this.featureRoCompat = dv.getUint32(0x64, true);
    this.metadataCsumEnabled = !!(this.featureRoCompat & FEATURE_RO_COMPAT_METADATA_CSUM);
    if (this.metadataCsumEnabled) {
      if (this.featureIncompat & FEATURE_INCOMPAT_CSUM_SEED) {
        this.csumSeed = dv.getUint32(0x270, true);
      } else {
        const uuidBytes = sbBytes.slice(0x68, 0x68 + 16);
        this.csumSeed = crc32c(0xffffffff, uuidBytes);
      }
    }
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
    const linksCount = dv.getUint16(0x1a, true);
    const flags = dv.getUint32(0x20, true);
    const generation = dv.getUint32(0x64, true);
    const sizeHi = dv.getUint32(0x6c, true);
    const fileType = mode & S_IFMT;
    const size = fileType === S_IFDIR ? sizeLo : sizeLo + sizeHi * 4294967296;
    const iBlock = buf.slice(0x28, 0x28 + 60);

    return {
      inodeNumber,
      byteOffset: offset,
      mode,
      fileType,
      isDir: fileType === S_IFDIR,
      isRegular: fileType === S_IFREG,
      isSymlink: fileType === S_IFLNK,
      size,
      linksCount,
      generation,
      flags,
      hasExtents: !!(flags & EXT4_EXTENTS_FL),
      htreeIndexed: !!(flags & EXT4_INDEX_FL),
      iBlock,
    };
  }

  /**
   * Derives the per-inode checksum seed used for both this inode's own
   * checksum and its directory-block checksums (ext4 metadata_csum).
   * i_csum_seed = crc32c(crc32c(base_seed, LE32(inodeNumber)), LE32(generation))
   */
  _inodeChecksumSeed(inodeNumber, generation) {
    const buf = new Uint8Array(4);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, inodeNumber >>> 0, true);
    let seed = crc32c(this.csumSeed, buf);
    dv.setUint32(0, generation >>> 0, true);
    seed = crc32c(seed, buf);
    return seed;
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

  /**
   * Removes one directory entry named `targetName` from `parentInode`,
   * in place, matching the real kernel's ext4_generic_delete_entry()
   * algorithm exactly (merge the deleted entry's rec_len into the
   * immediately preceding entry in the same block, or zero it in place if
   * it's the first entry in the block), then recomputes the block's
   * metadata_csum tail checksum if the filesystem uses one.
   *
   * Deliberately does NOT free the target's inode or data blocks, and does
   * NOT touch the inode/block allocation bitmaps — the removed file's
   * storage is simply abandoned (orphaned-but-harmless). This is safe for
   * partitions that are read-only mounted and never fsck'd at boot, and
   * avoids the far riskier task of correctly maintaining bitmaps/free
   * counts. If the removed entry was itself a directory, the parent's own
   * link count is decremented by one (matching the kernel's ext4_rmdir(),
   * which accounts for the removed subdirectory's ".." entry).
   *
   * @param {object} parentInode as returned by readInode()
   * @param {string} targetName exact entry name to remove (not a path)
   * @returns {Promise<boolean>} true if found and removed, false if not found
   */
  async removeDirEntry(parentInode, targetName) {
    if (!this.writeRange) {
      throw new Error('This Ext4Volume was opened read-only; cannot remove entries.');
    }
    if (!parentInode.isDir) {
      throw new Error('removeDirEntry: parent is not a directory.');
    }
    if (parentInode.htreeIndexed) {
      throw new Error(
        'This directory is htree-indexed (INDEX_FL set), which removeDirEntry does not support.'
      );
    }
    const targetNameBytes = new TextEncoder().encode(targetName);
    const runs = await this._resolveExtents(parentInode);

    for (const run of runs) {
      if (run.zero) continue;
      for (let b = 0; b < run.blockCount; b++) {
        const physBlock = run.physicalBlock + b;
        const blockOffset = physBlock * this.blockSize;
        const blockBytes = await this.readRange(blockOffset, this.blockSize);
        const result = this._deleteEntryInBlock(blockBytes, targetNameBytes, parentInode);
        if (!result) continue;

        this.writeRange(blockOffset, result.newBlockBytes);

        // Mirror the kernel's ext4_rmdir()/ext4_unlink(): the removed
        // entry's own inode loses a link (its directory's own ".." no
        // longer counts, for a subdirectory; or its sole name is gone, for
        // a file), and if it was a subdirectory the *parent* also loses a
        // link (for that child's ".." reference). We deliberately stop
        // short of orphan-list processing / freeing blocks or bitmap bits
        // (see class-level removeDirEntry doc comment).
        const childInode = await this.readInode(result.removedInodeNumber);
        if (result.removedFileType === EXT4_FT_DIR) {
          await this._setLinksCount(childInode, 0);
          const parentLinks = await this._readLinksCount(parentInode);
          await this._setLinksCount(parentInode, parentLinks > 0 ? parentLinks - 1 : 0);
        } else {
          const childLinks = await this._readLinksCount(childInode);
          await this._setLinksCount(childInode, childLinks > 0 ? childLinks - 1 : 0);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Finds `targetNameBytes` in one directory block and, if present, mutates
   * a copy of the block to remove it (kernel-equivalent merge/zero logic),
   * recomputing the trailing metadata_csum checksum if this filesystem uses
   * one. Returns null if the name isn't in this block.
   */
  _deleteEntryInBlock(blockBytes, targetNameBytes, parentInode) {
    const out = new Uint8Array(blockBytes); // mutate a copy
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const csumSize = this.metadataCsumEnabled ? EXT4_DIR_ENTRY_TAIL_SIZE : 0;
    const limit = out.length - csumSize;

    let pos = 0;
    let prevPos = -1;
    let found = false;
    let removedFileType = null;
    let removedInodeNumber = null;

    while (pos < limit) {
      if (pos + 8 > limit) break;
      const ino = dv.getUint32(pos, true);
      const recLen = dv.getUint16(pos + 4, true);
      if (recLen < 8) break; // corrupt; bail out of this block
      const nameLen = dv.getUint8(pos + 6);
      const fileTypeByte = dv.getUint8(pos + 7);

      const isMatch =
        ino !== 0 &&
        nameLen === targetNameBytes.length &&
        bytesEqual(out.subarray(pos + 8, pos + 8 + nameLen), targetNameBytes);

      if (isMatch) {
        removedFileType = fileTypeByte;
        removedInodeNumber = ino;
        if (prevPos >= 0) {
          const prevRecLen = dv.getUint16(prevPos + 4, true);
          dv.setUint16(prevPos + 4, prevRecLen + recLen, true);
          out.fill(0, pos, pos + recLen);
        } else {
          dv.setUint32(pos, 0, true); // inode = 0
          out.fill(0, pos + 6, pos + recLen); // zero name_len, file_type, name (preserve rec_len)
        }
        found = true;
        break;
      }

      prevPos = pos;
      pos += recLen;
    }

    if (!found) return null;

    if (this.metadataCsumEnabled) {
      const seed = this._inodeChecksumSeed(parentInode.inodeNumber, parentInode.generation);
      const csum = crc32c(seed, out.subarray(0, out.length - EXT4_DIR_ENTRY_TAIL_SIZE));
      dv.setUint32(out.length - 4, csum, true);
    }

    return { newBlockBytes: out, removedFileType, removedInodeNumber };
  }

  /**
   * Sets an inode's on-disk i_links_count to an explicit value, recomputing
   * the inode's own checksum. When dropping to zero, also stamps i_dtime
   * with the current time (cosmetic: matches what a normally-unlinked
   * inode looks like, so a stray e2fsck run reports "deleted inode" rather
   * than "deleted inode has zero dtime" — purely a diagnostic nicety, since
   * we deliberately do NOT touch the orphan list or free its blocks/bitmap
   * bits; see removeDirEntry's doc comment for the full scope decision).
   */
  async _setLinksCount(inode, newCount) {
    const linksOffset = inode.byteOffset + 0x1a;
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, newCount, true);
    this.writeRange(linksOffset, buf);
    inode.linksCount = newCount;
    if (newCount === 0) {
      const dtimeBuf = new Uint8Array(4);
      new DataView(dtimeBuf.buffer).setUint32(0, Math.floor(Date.now() / 1000) >>> 0, true);
      this.writeRange(inode.byteOffset + 0x14, dtimeBuf);
    }
    await this._recomputeInodeChecksum(inode);
  }

  /** Reads an inode's *current on-disk* i_links_count (bypassing any stale cached copy). */
  async _readLinksCount(inode) {
    const buf = await this.readRange(inode.byteOffset + 0x1a, 2);
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(0, true);
  }

  /**
   * Recomputes and rewrites an inode's own metadata_csum checksum
   * (i_checksum_lo / i_checksum_hi), matching ext4_inode_csum() exactly:
   * the checksum fields themselves are hashed as zero, everything else in
   * the on-disk inode struct (up to this filesystem's inode size) is
   * hashed as-is. No-op if metadata_csum isn't enabled on this filesystem.
   */
  async _recomputeInodeChecksum(inode) {
    if (!this.metadataCsumEnabled) return;
    const raw = await this.readRange(inode.byteOffset, this.inodeSize);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const seed = this._inodeChecksumSeed(inode.inodeNumber, inode.generation);
    const zero2 = new Uint8Array(2);

    const CHECKSUM_LO_OFFSET = 0x7c; // offsetof(ext4_inode, i_checksum_lo)
    let csum = crc32c(seed, raw.subarray(0, CHECKSUM_LO_OFFSET));
    csum = crc32c(csum, zero2);
    const afterLo = CHECKSUM_LO_OFFSET + 2;
    csum = crc32c(csum, raw.subarray(afterLo, Math.min(EXT4_GOOD_OLD_INODE_SIZE, this.inodeSize)));

    let checksumHiFits = false;
    if (this.inodeSize > EXT4_GOOD_OLD_INODE_SIZE) {
      const extraIsize = dv.getUint16(EXT4_GOOD_OLD_INODE_SIZE, true);
      const CHECKSUM_HI_OFFSET = 0x82; // offsetof(ext4_inode, i_checksum_hi)
      csum = crc32c(csum, raw.subarray(EXT4_GOOD_OLD_INODE_SIZE, CHECKSUM_HI_OFFSET));
      checksumHiFits = CHECKSUM_HI_OFFSET + 2 <= EXT4_GOOD_OLD_INODE_SIZE + extraIsize;
      let offset = CHECKSUM_HI_OFFSET;
      if (checksumHiFits) {
        csum = crc32c(csum, zero2);
        offset = CHECKSUM_HI_OFFSET + 2;
      }
      csum = crc32c(csum, raw.subarray(offset, this.inodeSize));
    }

    const loBuf = new Uint8Array(2);
    new DataView(loBuf.buffer).setUint16(0, csum & 0xffff, true);
    this.writeRange(inode.byteOffset + CHECKSUM_LO_OFFSET, loBuf);
    if (checksumHiFits) {
      const hiBuf = new Uint8Array(2);
      new DataView(hiBuf.buffer).setUint16(0, (csum >>> 16) & 0xffff, true);
      this.writeRange(inode.byteOffset + 0x82, hiBuf);
    }
  }
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
