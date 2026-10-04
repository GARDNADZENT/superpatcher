// Shared helper for building small, real (non-sparse) super.img files for
// manual/CLI/integration testing: packs N arbitrary partition byte-blobs
// into one real LP (liblp) metadata + block-device layout, matching the
// exact on-disk format lp.js parses. Extracted out of
// test/build-demo-super.mjs so new fixtures (e.g. for the device-lock
// removal feature) don't have to hand-roll the LP tables again.
import { sha256 } from '../src/sha256.js';

const SECTOR = 512;
const RESERVED = 4096;
const GEOMETRY_SIZE = 4096;
const METADATA_MAX_SIZE = 4096;
const SLOT_COUNT = 1;

function writeCString(buf, offset, str, len) {
  buf.set(new TextEncoder().encode(str).subarray(0, len), offset);
}

function pad(n, align) {
  return Math.ceil(n / align) * align;
}

/**
 * @param {Array<{name:string, bytes:Uint8Array}>} partitions one linear
 *   extent each, all on the single block device ("super"), all in one
 *   group ("default"), one metadata slot.
 * @returns {Promise<Uint8Array>} a complete, raw (non-sparse) super.img
 */
export async function buildSuperImage(partitions) {
  const metadataRegionEnd = RESERVED + (GEOMETRY_SIZE + METADATA_MAX_SIZE * SLOT_COUNT) * 2;

  let cursor = pad(metadataRegionEnd, SECTOR);
  const laidOut = partitions.map((p) => {
    const offset = cursor;
    const len = pad(p.bytes.length, SECTOR);
    cursor += len;
    return { ...p, offset, len };
  });
  const totalSize = cursor;

  const image = new Uint8Array(totalSize);
  for (const p of laidOut) image.set(p.bytes, p.offset);

  const partitionEntrySize = 52;
  const extentEntrySize = 24;
  const groupEntrySize = 48;
  const blockDeviceEntrySize = 64;
  const partitionsCount = laidOut.length;
  const extentsCount = laidOut.length;
  const groupsCount = 1;
  const blockDevicesCount = 1;

  const partitionsOffset = 0;
  const extentsOffset = partitionsOffset + partitionsCount * partitionEntrySize;
  const groupsOffset = extentsOffset + extentsCount * extentEntrySize;
  const blockDevicesOffset = groupsOffset + groupsCount * groupEntrySize;
  const tablesSize = blockDevicesOffset + blockDevicesCount * blockDeviceEntrySize;

  const tables = new Uint8Array(tablesSize);
  const tdv = new DataView(tables.buffer);

  function writePartition(idx, name, attributes, firstExtentIndex, numExtents, groupIndex) {
    const off = partitionsOffset + idx * partitionEntrySize;
    writeCString(tables, off, name, 36);
    tdv.setUint32(off + 36, attributes, true);
    tdv.setUint32(off + 40, firstExtentIndex, true);
    tdv.setUint32(off + 44, numExtents, true);
    tdv.setUint32(off + 48, groupIndex, true);
  }
  laidOut.forEach((p, idx) => writePartition(idx, p.name, 0, idx, 1, 0));

  function writeExtent(idx, numSectors, targetType, targetData, targetSource) {
    const off = extentsOffset + idx * extentEntrySize;
    tdv.setBigUint64(off, BigInt(numSectors), true);
    tdv.setUint32(off + 8, targetType, true);
    tdv.setBigUint64(off + 12, BigInt(targetData), true);
    tdv.setUint32(off + 20, targetSource, true);
  }
  laidOut.forEach((p, idx) => writeExtent(idx, p.len / SECTOR, 0, p.offset / SECTOR, 0));

  writeCString(tables, groupsOffset, 'default', 36);
  tdv.setUint32(groupsOffset + 36, 0, true);
  tdv.setBigUint64(groupsOffset + 40, 0n, true);

  tdv.setBigUint64(blockDevicesOffset + 0, BigInt(metadataRegionEnd / SECTOR), true);
  tdv.setUint32(blockDevicesOffset + 8, 4096, true);
  tdv.setUint32(blockDevicesOffset + 12, 0, true);
  tdv.setBigUint64(blockDevicesOffset + 16, BigInt(totalSize), true);
  writeCString(tables, blockDevicesOffset + 24, 'super', 36);
  tdv.setUint32(blockDevicesOffset + 60, 0, true);

  const tablesChecksum = await sha256(tables);

  const headerSize = 128;
  const header = new Uint8Array(headerSize);
  const hdv = new DataView(header.buffer);
  hdv.setUint32(0, 0x414c5030, true);
  hdv.setUint16(4, 10, true);
  hdv.setUint16(6, 0, true);
  hdv.setUint32(8, headerSize, true);
  hdv.setUint32(44, tablesSize, true);
  header.set(tablesChecksum, 48);
  hdv.setUint32(80, partitionsOffset, true);
  hdv.setUint32(84, partitionsCount, true);
  hdv.setUint32(88, partitionEntrySize, true);
  hdv.setUint32(92, extentsOffset, true);
  hdv.setUint32(96, extentsCount, true);
  hdv.setUint32(100, extentEntrySize, true);
  hdv.setUint32(104, groupsOffset, true);
  hdv.setUint32(108, groupsCount, true);
  hdv.setUint32(112, groupEntrySize, true);
  hdv.setUint32(116, blockDevicesOffset, true);
  hdv.setUint32(120, blockDevicesCount, true);
  hdv.setUint32(124, blockDeviceEntrySize, true);

  const headerChecksum = await sha256(header);
  header.set(headerChecksum, 12);

  const geometry = new Uint8Array(GEOMETRY_SIZE);
  const gdv = new DataView(geometry.buffer);
  gdv.setUint32(0, 0x616c4467, true);
  const geometryStructSize = 52;
  gdv.setUint32(4, geometryStructSize, true);
  gdv.setUint32(40, METADATA_MAX_SIZE, true);
  gdv.setUint32(44, SLOT_COUNT, true);
  gdv.setUint32(48, 4096, true);
  const geometryChecksum = await sha256(geometry.slice(0, geometryStructSize));
  geometry.set(geometryChecksum, 8);

  image.set(geometry, RESERVED);
  image.set(geometry, RESERVED + GEOMETRY_SIZE);

  function metadataSlotOffset(slot) {
    return RESERVED + GEOMETRY_SIZE * 2 + METADATA_MAX_SIZE * slot;
  }
  function backupSlotOffset(slot) {
    return RESERVED + GEOMETRY_SIZE * 2 + METADATA_MAX_SIZE * SLOT_COUNT + METADATA_MAX_SIZE * slot;
  }
  image.set(header, metadataSlotOffset(0));
  image.set(tables, metadataSlotOffset(0) + headerSize);
  image.set(header, backupSlotOffset(0));
  image.set(tables, backupSlotOffset(0) + headerSize);

  return image;
}
