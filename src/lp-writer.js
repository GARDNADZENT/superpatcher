// Encoder for the LP ("liblp") metadata header + tables (geometry block is
// deliberately NOT handled here -- see partition-editor.js, which never
// changes geometry at all, only ever re-encodes the per-slot header+tables
// that live inside the geometry-declared metadata_max_size budget).
//
// This is the write-side counterpart of lp.js's tryReadMetadataAt(): the
// exact same field layout, byte-for-byte, so anything encoded here reads
// back through lp.js unchanged. Covered by test/lp-writer.test.js, which
// round-trips encode -> lp.js's own reader for exactly that reason.
import { sha256 } from './sha256.js';

const LP_METADATA_HEADER_MAGIC = 0x414c5030;
const PARTITION_ENTRY_SIZE = 52;
const EXTENT_ENTRY_SIZE = 24;
const GROUP_ENTRY_SIZE = 48;
const BLOCK_DEVICE_ENTRY_SIZE = 64;
const DEFAULT_HEADER_SIZE = 128;

function writeCString(buf, offset, str, len) {
  const bytes = new TextEncoder().encode(str);
  buf.set(bytes.subarray(0, len), offset);
}

/**
 * Encodes a complete LP metadata header + tables blob from plain
 * partitions/extents/groups/blockDevices arrays (the exact same shapes
 * lp.js's readMetadata() produces, so a round-trip is lossless).
 *
 * @param {object} input
 * @param {Array<{name:string, attributes:number, first_extent_index:number, num_extents:number, group_index:number}>} input.partitions
 * @param {Array<{num_sectors:bigint, target_type:number, target_data:bigint, target_source:number}>} input.extents
 * @param {Array<{name:string, flags:number, maximum_size:bigint}>} input.groups
 * @param {Array<{first_logical_sector:bigint, alignment:number, alignment_offset:number, size:bigint, partition_name:string, flags:number}>} input.blockDevices
 * @param {number} [headerSize=128]
 * @returns {Promise<{header: Uint8Array, tables: Uint8Array}>}
 */
export async function encodeLpMetadata({ partitions, extents, groups, blockDevices }, headerSize = DEFAULT_HEADER_SIZE) {
  if (headerSize < 128 || headerSize > 4096) {
    throw new Error(`encodeLpMetadata: headerSize must be 128..4096, got ${headerSize}`);
  }

  const partitionsOffset = 0;
  const extentsOffset = partitionsOffset + partitions.length * PARTITION_ENTRY_SIZE;
  const groupsOffset = extentsOffset + extents.length * EXTENT_ENTRY_SIZE;
  const blockDevicesOffset = groupsOffset + groups.length * GROUP_ENTRY_SIZE;
  const tablesSize = blockDevicesOffset + blockDevices.length * BLOCK_DEVICE_ENTRY_SIZE;

  const tables = new Uint8Array(tablesSize);
  const tdv = new DataView(tables.buffer);

  partitions.forEach((p, idx) => {
    const off = partitionsOffset + idx * PARTITION_ENTRY_SIZE;
    writeCString(tables, off, p.name, 36);
    tdv.setUint32(off + 36, p.attributes >>> 0, true);
    tdv.setUint32(off + 40, p.first_extent_index >>> 0, true);
    tdv.setUint32(off + 44, p.num_extents >>> 0, true);
    tdv.setUint32(off + 48, p.group_index >>> 0, true);
  });

  extents.forEach((e, idx) => {
    const off = extentsOffset + idx * EXTENT_ENTRY_SIZE;
    tdv.setBigUint64(off, BigInt(e.num_sectors), true);
    tdv.setUint32(off + 8, e.target_type >>> 0, true);
    tdv.setBigUint64(off + 12, BigInt(e.target_data), true);
    tdv.setUint32(off + 20, e.target_source >>> 0, true);
  });

  groups.forEach((g, idx) => {
    const off = groupsOffset + idx * GROUP_ENTRY_SIZE;
    writeCString(tables, off, g.name, 36);
    tdv.setUint32(off + 36, g.flags >>> 0, true);
    tdv.setBigUint64(off + 40, BigInt(g.maximum_size), true);
  });

  blockDevices.forEach((b, idx) => {
    const off = blockDevicesOffset + idx * BLOCK_DEVICE_ENTRY_SIZE;
    tdv.setBigUint64(off + 0, BigInt(b.first_logical_sector), true);
    tdv.setUint32(off + 8, b.alignment >>> 0, true);
    tdv.setUint32(off + 12, b.alignment_offset >>> 0, true);
    tdv.setBigUint64(off + 16, BigInt(b.size), true);
    writeCString(tables, off + 24, b.partition_name, 36);
    tdv.setUint32(off + 60, b.flags >>> 0, true);
  });

  const tablesChecksum = await sha256(tables);

  const header = new Uint8Array(headerSize);
  const hdv = new DataView(header.buffer);
  hdv.setUint32(0, LP_METADATA_HEADER_MAGIC, true);
  hdv.setUint16(4, 10, true); // major_version
  hdv.setUint16(6, 0, true); // minor_version
  hdv.setUint32(8, headerSize, true);
  // bytes [12,44) (header_checksum) left zero for now, filled in below
  hdv.setUint32(44, tablesSize, true);
  header.set(tablesChecksum, 48); // tables_checksum, bytes [48,80)
  hdv.setUint32(80, partitionsOffset, true);
  hdv.setUint32(84, partitions.length, true);
  hdv.setUint32(88, PARTITION_ENTRY_SIZE, true);
  hdv.setUint32(92, extentsOffset, true);
  hdv.setUint32(96, extents.length, true);
  hdv.setUint32(100, EXTENT_ENTRY_SIZE, true);
  hdv.setUint32(104, groupsOffset, true);
  hdv.setUint32(108, groups.length, true);
  hdv.setUint32(112, GROUP_ENTRY_SIZE, true);
  hdv.setUint32(116, blockDevicesOffset, true);
  hdv.setUint32(120, blockDevices.length, true);
  hdv.setUint32(124, BLOCK_DEVICE_ENTRY_SIZE, true);
  if (headerSize >= 132) hdv.setUint32(128, 0, true); // flags

  const headerChecksum = await sha256(header);
  header.set(headerChecksum, 12);

  return { header, tables };
}
