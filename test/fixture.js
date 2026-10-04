// Builds a small, fully valid synthetic super.img (raw/unsparsed) for tests:
// 3 partitions ("boot", "system", "vendor") across 2 metadata slots worth of
// reserved space, exercising LINEAR extents, a ZERO (dm-zero) extent, and a
// constant-fill-friendly payload.

import { sha256 as sha256Impl } from '../src/sha256.js';

async function sha256(bytes) {
  return sha256Impl(bytes);
}

function writeCString(buf, offset, str, len) {
  const bytes = new TextEncoder().encode(str);
  buf.set(bytes.subarray(0, len), offset);
}

const SECTOR = 512;
const RESERVED = 4096;
const GEOMETRY_SIZE = 4096;
const METADATA_MAX_SIZE = 4096;
const SLOT_COUNT = 2;

export const FIXTURE_LAYOUT = {
  metadataRegionEnd: RESERVED + (GEOMETRY_SIZE + METADATA_MAX_SIZE * SLOT_COUNT) * 2, // 28672
  bootLen: 65536,
  systemPart1Len: 131072,
  systemZeroLen: 65536,
  vendorLen: 32768,
  vendorFillValue: 0xaabbccdd,
};

export async function buildFixture() {
  const L = FIXTURE_LAYOUT;
  const bootOffset = L.metadataRegionEnd;
  const systemOffset = bootOffset + L.bootLen;
  const vendorOffset = systemOffset + L.systemPart1Len;
  const totalSize = vendorOffset + L.vendorLen;

  const image = new Uint8Array(totalSize);

  // Deterministic "random" boot payload (not crypto-random, just needs to be
  // non-trivial / non-repeating so RAW-chunk handling is exercised).
  const boot = new Uint8Array(L.bootLen);
  for (let i = 0; i < boot.length; i++) boot[i] = (i * 2654435761) & 0xff;
  image.set(boot, bootOffset);

  const system = new Uint8Array(L.systemPart1Len);
  for (let i = 0; i < system.length; i++) system[i] = (i * 40503 + 7) & 0xff;
  image.set(system, systemOffset);

  // Vendor payload is a constant repeating 4-byte pattern so the sparse
  // encoder/test can represent it as a single FILL chunk.
  const vendor = new Uint8Array(L.vendorLen);
  const pv = new DataView(vendor.buffer);
  for (let i = 0; i < vendor.length; i += 4) pv.setUint32(i, L.vendorFillValue, true);
  image.set(vendor, vendorOffset);

  // ---- Build LP metadata tables ----
  const partitionEntrySize = 52;
  const extentEntrySize = 24;
  const groupEntrySize = 48;
  const blockDeviceEntrySize = 64;

  const partitionsCount = 3;
  const extentsCount = 4;
  const groupsCount = 1;
  const blockDevicesCount = 1;

  const partitionsOffset = 0;
  const extentsOffset = partitionsOffset + partitionsCount * partitionEntrySize;
  const groupsOffset = extentsOffset + extentsCount * extentEntrySize;
  const blockDevicesOffset = groupsOffset + groupsCount * groupEntrySize;
  const tablesSize = blockDevicesOffset + blockDevicesCount * blockDeviceEntrySize;

  const tables = new Uint8Array(tablesSize);
  const tdv = new DataView(tables.buffer);

  // Partitions
  function writePartition(idx, name, attributes, firstExtentIndex, numExtents, groupIndex) {
    const off = partitionsOffset + idx * partitionEntrySize;
    writeCString(tables, off, name, 36);
    tdv.setUint32(off + 36, attributes, true);
    tdv.setUint32(off + 40, firstExtentIndex, true);
    tdv.setUint32(off + 44, numExtents, true);
    tdv.setUint32(off + 48, groupIndex, true);
  }
  writePartition(0, 'boot', 0, 0, 1, 0);
  writePartition(1, 'system', 0, 1, 2, 0);
  writePartition(2, 'vendor', 0x1 /* READONLY */, 3, 1, 0);

  // Extents
  function writeExtent(idx, numSectors, targetType, targetData, targetSource) {
    const off = extentsOffset + idx * extentEntrySize;
    tdv.setBigUint64(off, BigInt(numSectors), true);
    tdv.setUint32(off + 8, targetType, true);
    tdv.setBigUint64(off + 12, BigInt(targetData), true);
    tdv.setUint32(off + 20, targetSource, true);
  }
  writeExtent(0, L.bootLen / SECTOR, 0, bootOffset / SECTOR, 0); // boot
  writeExtent(1, L.systemPart1Len / SECTOR, 0, systemOffset / SECTOR, 0); // system part 1
  writeExtent(2, L.systemZeroLen / SECTOR, 1, 0, 0); // system part 2 (ZERO)
  writeExtent(3, L.vendorLen / SECTOR, 0, vendorOffset / SECTOR, 0); // vendor

  // Groups
  writeCString(tables, groupsOffset, 'default', 36);
  tdv.setUint32(groupsOffset + 36, 0, true);
  tdv.setBigUint64(groupsOffset + 40, 0n, true);

  // Block devices
  tdv.setBigUint64(blockDevicesOffset + 0, BigInt(L.metadataRegionEnd / SECTOR), true);
  tdv.setUint32(blockDevicesOffset + 8, 4096, true);
  tdv.setUint32(blockDevicesOffset + 12, 0, true);
  tdv.setBigUint64(blockDevicesOffset + 16, BigInt(totalSize), true);
  writeCString(tables, blockDevicesOffset + 24, 'super', 36);
  tdv.setUint32(blockDevicesOffset + 60, 0, true);

  const tablesChecksum = await sha256(tables);

  // ---- Build header ----
  const headerSize = 128;
  const header = new Uint8Array(headerSize);
  const hdv = new DataView(header.buffer);
  hdv.setUint32(0, 0x414c5030, true); // magic
  hdv.setUint16(4, 10, true); // major_version
  hdv.setUint16(6, 0, true); // minor_version
  hdv.setUint32(8, headerSize, true);
  // header_checksum (12..44) left zero for checksum computation
  hdv.setUint32(44, tablesSize, true);
  header.set(tablesChecksum, 48); // tables_checksum (48..80)
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

  // ---- Build geometry ----
  const geometry = new Uint8Array(GEOMETRY_SIZE);
  const gdv = new DataView(geometry.buffer);
  gdv.setUint32(0, 0x616c4467, true); // magic
  const geometryStructSize = 52;
  gdv.setUint32(4, geometryStructSize, true);
  // checksum (8..40) left zero for now
  gdv.setUint32(40, METADATA_MAX_SIZE, true);
  gdv.setUint32(44, SLOT_COUNT, true);
  gdv.setUint32(48, 4096, true); // logical_block_size

  const geomForChecksum = geometry.slice(0, geometryStructSize);
  const geometryChecksum = await sha256(geomForChecksum);
  geometry.set(geometryChecksum, 8);

  // ---- Place everything into the image ----
  image.set(geometry, RESERVED); // primary geometry
  image.set(geometry, RESERVED + GEOMETRY_SIZE); // backup geometry (identical)

  function metadataSlotOffset(slot) {
    return RESERVED + GEOMETRY_SIZE * 2 + METADATA_MAX_SIZE * slot;
  }
  function backupSlotOffset(slot) {
    return RESERVED + GEOMETRY_SIZE * 2 + METADATA_MAX_SIZE * SLOT_COUNT + METADATA_MAX_SIZE * slot;
  }

  // Only populate slot 0 (both primary and backup copies); slot 1 stays zeroed.
  image.set(header, metadataSlotOffset(0));
  image.set(tables, metadataSlotOffset(0) + headerSize);
  image.set(header, backupSlotOffset(0));
  image.set(tables, backupSlotOffset(0) + headerSize);

  return {
    image,
    expected: {
      boot,
      system,
      vendor,
      systemZero: new Uint8Array(L.systemZeroLen), // all zero
    },
    offsets: { bootOffset, systemOffset, vendorOffset, totalSize },
  };
}
