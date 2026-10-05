// Fallback support for loading a "raw" single-filesystem image directly —
// most commonly a GSI (Generic System Image, e.g. a Treble
// "system-arm64-ab.img" / "Infinity-X-...-GSI-....img"), but also any other
// standalone partition image (a plain system.img/vendor.img/product.img
// pulled individually, rather than packed into a dynamic-partition
// super.img). These files are just a single ext4 or EROFS filesystem
// starting at byte 0 of the file — there is no LP ("liblp") geometry/
// metadata header at all, which is why readGeometry() legitimately fails
// with "No valid LP geometry block found" for them: that error is correct,
// it's simply the wrong question to ask of this kind of file.
//
// Rather than dead-ending there, we detect this case (same ext4/EROFS
// magic sniff the real scanner already uses, just applied at the very
// start of the whole disk instead of at a partition's offset) and
// synthesize a single-partition LP geometry/metadata pair covering the
// entire file as one linear extent on block device 0. Every existing
// feature (partition table UI, extraction, security scan, remove-flagged,
// Remove Device Lock Components) consumes `geo`/`meta` through the same
// lp.js helpers (partitionSizeBytes, partitionExtentRanges,
// findOverlappingExtents, etc.) regardless of whether they came from a
// real LP header or this synthetic one, so nothing downstream needs to
// know the difference.
import { looksLikeExt4 } from './ext4.js';
import { looksLikeErofs } from './erofs.js';
import { LP_SECTOR_SIZE, LP_TARGET_TYPE_LINEAR } from './lp.js';

/**
 * Sniffs the very start of `disk` for an ext4 or EROFS superblock (the same
 * magic check the real scanner uses, just at absolute disk offset 1024
 * instead of a partition-relative one, since here the "partition" IS the
 * whole disk).
 * @returns {Promise<'ext4'|'erofs'|null>}
 */
export async function detectRawFilesystemType(disk) {
  if (disk.totalSize < 1024 + 144) return null;
  const header = await disk.read(1024, 144);
  if (looksLikeExt4(header)) return 'ext4';
  if (looksLikeErofs(header)) return 'erofs';
  return null;
}

/**
 * Builds a synthetic {geo, meta} pair — matching the exact shapes
 * lp.js's readGeometry()/readMetadata() normally produce — describing the
 * whole disk as one single LINEAR partition. Any trailing bytes that don't
 * form a complete 512-byte sector (vanishingly rare for real build
 * artifacts, which are always block-aligned) are simply not covered by the
 * extent; `truncatedBytes` reports how many, if any.
 *
 * @param {import('./virtual-disk.js').VirtualDisk} disk
 * @param {'ext4'|'erofs'} fsType
 * @param {string} partitionName
 */
export function buildSyntheticRawImageMetadata(disk, fsType, partitionName) {
  const numSectors = BigInt(Math.floor(disk.totalSize / LP_SECTOR_SIZE));
  const truncatedBytes = disk.totalSize - Number(numSectors) * LP_SECTOR_SIZE;

  const geo = {
    magic: null,
    struct_size: 0,
    checksum: new Uint8Array(32),
    metadata_max_size: 0,
    metadata_slot_count: 1,
    logical_block_size: fsType === 'erofs' ? 4096 : 1024, // display-only; not used for any offset math here
    checksumValid: true,
    source: 'synthetic (raw single-partition image, not a real super.img)',
    isSyntheticRawImage: true,
  };

  const meta = {
    major_version: 10,
    minor_version: 0,
    header_size: 0,
    tables_size: 0,
    flags: 0,
    partitions: [
      {
        name: partitionName,
        attributes: 0,
        first_extent_index: 0,
        num_extents: 1,
        group_index: 0,
      },
    ],
    extents: [
      {
        num_sectors: numSectors,
        target_type: LP_TARGET_TYPE_LINEAR,
        target_data: 0n,
        target_source: 0,
      },
    ],
    groups: [{ name: 'default', flags: 0, maximum_size: 0n }],
    blockDevices: [
      {
        first_logical_sector: 0n,
        alignment: 0,
        alignment_offset: 0,
        size: BigInt(disk.totalSize),
        partition_name: partitionName,
        flags: 0,
      },
    ],
    source: 'synthetic',
    slot: 0,
    isSyntheticRawImage: true,
    detectedFsType: fsType,
  };

  return { geo, meta, truncatedBytes };
}

/** Picks a reasonable synthetic partition name from the loaded filename:
 * "system" for anything GSI/system-flavored (the overwhelmingly common
 * case for a standalone raw image), falling back to the bare filename
 * (extension stripped) otherwise so it's at least recognizable. */
export function guessRawImagePartitionName(filename) {
  const base = filename.replace(/\.(img|bin|raw)$/i, '');
  if (/(^|[^a-z])system_ext([^a-z]|$)/i.test(base)) return 'system_ext'; // check before the plain "system" pattern
  if (/(^|[^a-z])(system|gsi)([^a-z]|$)/i.test(base)) return 'system';
  if (/(^|[^a-z])vendor([^a-z]|$)/i.test(base)) return 'vendor';
  if (/(^|[^a-z])product([^a-z]|$)/i.test(base)) return 'product';
  return base.slice(0, 36) || 'raw_image'; // LP partition names are capped at 36 bytes anyway
}
