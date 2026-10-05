// Parser for Android's "liblp" logical-partition metadata format, as used
// in dynamic-partition super.img images (Android 10+).
// Reference (AOSP, Apache-2.0):
//   system/core/fs_mgr/liblp/include/liblp/metadata_format.h
//   system/core/fs_mgr/liblp/reader.cpp
//   system/core/fs_mgr/liblp/utility.cpp
//
// On-disk layout of the partition holding the metadata ("super"):
//   [reserved 4096B] [geometry 4096B] [geometry backup 4096B]
//   [metadata slot 0] [metadata slot 1] ... [backup slot 0] [backup slot 1] ...
//   [logical partition data ...]

export const LP_SECTOR_SIZE = 512;
export const LP_PARTITION_RESERVED_BYTES = 4096;
export const LP_METADATA_GEOMETRY_SIZE = 4096;
const LP_METADATA_GEOMETRY_MAGIC = 0x616c4467;
const LP_METADATA_HEADER_MAGIC = 0x414c5030;

export const LP_TARGET_TYPE_LINEAR = 0;
export const LP_TARGET_TYPE_ZERO = 1;

export const LP_PARTITION_ATTR_READONLY = 1 << 0;
export const LP_PARTITION_ATTR_SLOT_SUFFIXED = 1 << 1;
export const LP_PARTITION_ATTR_UPDATED = 1 << 2;
export const LP_PARTITION_ATTR_DISABLED = 1 << 3;

function readCString(bytes) {
  let end = bytes.indexOf(0);
  if (end === -1) end = bytes.length;
  return new TextDecoder('ascii').decode(bytes.subarray(0, end));
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

import { sha256 as sha256Sync } from './sha256.js';

// Kept as an async function (even though the underlying implementation is
// synchronous) so call sites don't need to change if we ever swap back to
// an async implementation. We intentionally do NOT use
// window.crypto.subtle.digest() here: SubtleCrypto is only available in a
// "secure context" (HTTPS or localhost), and this app needs to work even
// when reached over plain HTTP (e.g. a bare LAN IP).
async function sha256(bytes) {
  return sha256Sync(bytes);
}

function dvOf(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

function parseGeometryBuffer(buf) {
  const dv = dvOf(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== LP_METADATA_GEOMETRY_MAGIC) return null;
  const struct_size = dv.getUint32(4, true);
  if (struct_size > buf.length || struct_size < 52) return null;
  const checksum = buf.slice(8, 40);
  const metadata_max_size = dv.getUint32(40, true);
  const metadata_slot_count = dv.getUint32(44, true);
  const logical_block_size = dv.getUint32(48, true);
  return {
    magic,
    struct_size,
    checksum,
    metadata_max_size,
    metadata_slot_count,
    logical_block_size,
    raw: buf,
  };
}

async function verifyGeometryChecksum(geo) {
  const temp = geo.raw.slice(0, geo.struct_size);
  temp.set(new Uint8Array(32), 8);
  const digest = await sha256(temp);
  return bytesEqual(digest, geo.checksum);
}

/**
 * Reads and validates the LpMetadataGeometry block (tries primary, then
 * backup). Throws if neither is a structurally valid geometry block, even
 * if the checksum doesn't match (checksum mismatches are reported via
 * `.checksumValid` instead of failing hard, to tolerate images produced by
 * non-standard tooling).
 */
export async function readGeometry(disk) {
  const primaryBuf = await disk.read(LP_PARTITION_RESERVED_BYTES, LP_METADATA_GEOMETRY_SIZE);
  let geo = parseGeometryBuffer(primaryBuf);
  let source = 'primary';
  let checksumValid = geo ? await verifyGeometryChecksum(geo) : false;

  if (!geo || !checksumValid) {
    const backupBuf = await disk.read(
      LP_PARTITION_RESERVED_BYTES + LP_METADATA_GEOMETRY_SIZE,
      LP_METADATA_GEOMETRY_SIZE
    );
    const backupGeo = parseGeometryBuffer(backupBuf);
    if (backupGeo) {
      const backupValid = await verifyGeometryChecksum(backupGeo);
      if (!geo || backupValid) {
        geo = backupGeo;
        checksumValid = backupValid;
        source = 'backup';
      }
    }
  }

  if (!geo) {
    throw new Error(
      'No valid LP geometry block found. This does not look like an Android dynamic-partition super.img.'
    );
  }
  if (geo.metadata_slot_count === 0) {
    throw new Error('Geometry reports 0 metadata slots; image is corrupt.');
  }
  if (geo.metadata_max_size % LP_SECTOR_SIZE !== 0) {
    throw new Error('Geometry metadata_max_size is not sector-aligned; image is corrupt.');
  }

  geo.checksumValid = checksumValid;
  geo.source = source;
  return geo;
}

export function primaryMetadataOffset(geo, slot) {
  return LP_PARTITION_RESERVED_BYTES + LP_METADATA_GEOMETRY_SIZE * 2 + geo.metadata_max_size * slot;
}
export function backupMetadataOffset(geo, slot) {
  const start =
    LP_PARTITION_RESERVED_BYTES +
    LP_METADATA_GEOMETRY_SIZE * 2 +
    geo.metadata_max_size * geo.metadata_slot_count;
  return start + geo.metadata_max_size * slot;
}

/** Total size (bytes) of the reserved + geometry + all metadata-slot area. */
export function totalMetadataRegionSize(geo) {
  return (
    LP_PARTITION_RESERVED_BYTES +
    (LP_METADATA_GEOMETRY_SIZE + geo.metadata_max_size * geo.metadata_slot_count) * 2
  );
}

function readTableDescriptor(dv, offset) {
  return {
    offset: dv.getUint32(offset, true),
    num_entries: dv.getUint32(offset + 4, true),
    entry_size: dv.getUint32(offset + 8, true),
  };
}

const PARTITION_ENTRY_SIZE = 52;
const EXTENT_ENTRY_SIZE = 24;
const GROUP_ENTRY_SIZE = 48;
const BLOCK_DEVICE_ENTRY_SIZE = 64;

async function tryReadMetadataAt(disk, baseOffset, regionLimit) {
  if (baseOffset + 256 > regionLimit) return { valid: false, reason: 'out of range' };
  const headerBuf = await disk.read(baseOffset, 256);
  const dv = dvOf(headerBuf);
  const magic = dv.getUint32(0, true);
  if (magic !== LP_METADATA_HEADER_MAGIC) {
    return { valid: false, reason: 'bad magic' };
  }
  const major_version = dv.getUint16(4, true);
  const minor_version = dv.getUint16(6, true);
  const header_size = dv.getUint32(8, true);
  const header_checksum = headerBuf.slice(12, 44);
  const tables_size = dv.getUint32(44, true);
  const tables_checksum = headerBuf.slice(48, 80);
  const partitionsDesc = readTableDescriptor(dv, 80);
  const extentsDesc = readTableDescriptor(dv, 92);
  const groupsDesc = readTableDescriptor(dv, 104);
  const blockDevicesDesc = readTableDescriptor(dv, 116);
  let flags = 0;
  if (header_size >= 132) flags = dv.getUint32(128, true);

  if (major_version !== 10) {
    return { valid: false, reason: `unsupported major version ${major_version}` };
  }
  if (header_size < 128 || header_size > 4096 || baseOffset + header_size + tables_size > regionLimit) {
    return { valid: false, reason: 'implausible header/table size' };
  }

  const fullHeaderBuf =
    header_size <= headerBuf.length ? headerBuf.slice(0, header_size) : await disk.read(baseOffset, header_size);
  const headerCopy = fullHeaderBuf.slice();
  headerCopy.set(new Uint8Array(32), 12);
  const headerDigest = await sha256(headerCopy);
  const headerValid = bytesEqual(headerDigest, header_checksum);

  const tablesBuf = await disk.read(baseOffset + header_size, tables_size);
  const tablesDigest = await sha256(tablesBuf);
  const tablesValid = bytesEqual(tablesDigest, tables_checksum);

  if (!headerValid || !tablesValid) {
    return { valid: false, reason: `checksum mismatch (header:${headerValid} tables:${tablesValid})` };
  }

  const partitions = [];
  for (let i = 0; i < partitionsDesc.num_entries; i++) {
    const off = partitionsDesc.offset + i * partitionsDesc.entry_size;
    const b = tablesBuf.subarray(off, off + PARTITION_ENTRY_SIZE);
    const pdv = dvOf(b);
    partitions.push({
      name: readCString(b.subarray(0, 36)),
      attributes: pdv.getUint32(36, true),
      first_extent_index: pdv.getUint32(40, true),
      num_extents: pdv.getUint32(44, true),
      group_index: pdv.getUint32(48, true),
    });
  }

  const extents = [];
  for (let i = 0; i < extentsDesc.num_entries; i++) {
    const off = extentsDesc.offset + i * extentsDesc.entry_size;
    const b = tablesBuf.subarray(off, off + EXTENT_ENTRY_SIZE);
    const edv = dvOf(b);
    extents.push({
      num_sectors: edv.getBigUint64(0, true),
      target_type: edv.getUint32(8, true),
      target_data: edv.getBigUint64(12, true),
      target_source: edv.getUint32(20, true),
    });
  }

  const groups = [];
  for (let i = 0; i < groupsDesc.num_entries; i++) {
    const off = groupsDesc.offset + i * groupsDesc.entry_size;
    const b = tablesBuf.subarray(off, off + GROUP_ENTRY_SIZE);
    const gdv = dvOf(b);
    groups.push({
      name: readCString(b.subarray(0, 36)),
      flags: gdv.getUint32(36, true),
      maximum_size: gdv.getBigUint64(40, true),
    });
  }

  const blockDevices = [];
  for (let i = 0; i < blockDevicesDesc.num_entries; i++) {
    const off = blockDevicesDesc.offset + i * blockDevicesDesc.entry_size;
    const b = tablesBuf.subarray(off, off + BLOCK_DEVICE_ENTRY_SIZE);
    const bdv = dvOf(b);
    blockDevices.push({
      first_logical_sector: bdv.getBigUint64(0, true),
      alignment: bdv.getUint32(8, true),
      alignment_offset: bdv.getUint32(12, true),
      size: bdv.getBigUint64(16, true),
      partition_name: readCString(b.subarray(24, 60)),
      flags: bdv.getUint32(60, true),
    });
  }

  return {
    valid: true,
    major_version,
    minor_version,
    header_size,
    tables_size,
    flags,
    partitions,
    extents,
    groups,
    blockDevices,
  };
}

/**
 * Reads LP metadata for the given slot number, trying the primary copy and
 * falling back to the backup copy on checksum failure.
 */
export async function readMetadata(disk, geo, slot = 0) {
  if (slot >= geo.metadata_slot_count) {
    throw new Error(`Slot ${slot} does not exist (only ${geo.metadata_slot_count} slot(s)).`);
  }
  const regionLimit = totalMetadataRegionSize(geo);
  const primary = await tryReadMetadataAt(disk, primaryMetadataOffset(geo, slot), regionLimit);
  if (primary.valid) {
    primary.source = 'primary';
    primary.slot = slot;
    return primary;
  }
  const backup = await tryReadMetadataAt(disk, backupMetadataOffset(geo, slot), regionLimit);
  if (backup.valid) {
    backup.source = 'backup';
    backup.slot = slot;
    return backup;
  }
  throw new Error(
    `Could not read valid LP metadata for slot ${slot}: primary (${primary.reason}), backup (${backup.reason}).`
  );
}

/** Total logical size (bytes) of a partition, as a BigInt. */
export function partitionSizeBytes(meta, partition) {
  let total = 0n;
  for (let i = 0; i < partition.num_extents; i++) {
    const ext = meta.extents[partition.first_extent_index + i];
    total += ext.num_sectors * BigInt(LP_SECTOR_SIZE);
  }
  return total;
}

/**
 * Resolves a partition's extents into an ordered list of byte ranges to
 * read: { type:'linear', targetSource, byteOffset, byteLength } (byteOffset
 * is relative to the start of block device #targetSource) or
 * { type:'zero', byteLength } for dm-zero extents.
 */
export function partitionExtentRanges(meta, partition) {
  const ranges = [];
  for (let i = 0; i < partition.num_extents; i++) {
    const ext = meta.extents[partition.first_extent_index + i];
    const byteLength = ext.num_sectors * BigInt(LP_SECTOR_SIZE);
    if (ext.target_type === LP_TARGET_TYPE_LINEAR) {
      ranges.push({
        type: 'linear',
        targetSource: ext.target_source,
        byteOffset: ext.target_data * BigInt(LP_SECTOR_SIZE),
        byteLength,
      });
    } else if (ext.target_type === LP_TARGET_TYPE_ZERO) {
      ranges.push({ type: 'zero', byteLength });
    } else {
      throw new Error(`Unsupported extent target_type ${ext.target_type} in partition ${partition.name}`);
    }
  }
  return ranges;
}

/**
 * Validates that no two LINEAR extents (across every partition, on the
 * loaded block device) overlap in absolute byte-offset space — a basic
 * dynamic-partition metadata sanity check, independent of any one
 * partition's own filesystem contents. ZERO (dm-zero) extents occupy no
 * physical space and are ignored. Extents on a block device other than
 * #0 (not loaded) are also ignored, since this tool can't address them
 * anyway.
 *
 * @returns {{ok:true}|{ok:false, detail:string}}
 */
export function findOverlappingExtents(meta) {
  const intervals = [];
  for (const partition of meta.partitions) {
    for (const range of partitionExtentRanges(meta, partition)) {
      if (range.type !== 'linear' || range.targetSource !== 0) continue;
      intervals.push({ start: range.byteOffset, end: range.byteOffset + range.byteLength, partition: partition.name });
    }
  }
  intervals.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i].start < intervals[i - 1].end) {
      return { ok: false, detail: `"${intervals[i - 1].partition}" and "${intervals[i].partition}" extents overlap` };
    }
  }
  return { ok: true };
}

export function partitionAttrString(attrs) {
  const flags = [];
  if (attrs & LP_PARTITION_ATTR_READONLY) flags.push('readonly');
  if (attrs & LP_PARTITION_ATTR_SLOT_SUFFIXED) flags.push('slot-suffixed');
  if (attrs & LP_PARTITION_ATTR_UPDATED) flags.push('updated');
  if (attrs & LP_PARTITION_ATTR_DISABLED) flags.push('disabled');
  return flags.join(', ');
}
