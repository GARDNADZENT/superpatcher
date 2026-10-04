// Builds a real super.img embedding two genuine filesystem partitions
// (ext4 "system_a" and EROFS "product_a"), for true end-to-end manual/CLI
// testing of the full pipeline (sparse/LP parsing -> scanner), independent
// of the synthetic unit-test fixture in test/fixture.js.
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { sha256 } from '../src/sha256.js';

function writeCString(buf, offset, str, len) {
  buf.set(new TextEncoder().encode(str).subarray(0, len), offset);
}

const SECTOR = 512;
const RESERVED = 4096;
const GEOMETRY_SIZE = 4096;
const METADATA_MAX_SIZE = 4096;
const SLOT_COUNT = 1;

function pad(n, align) {
  return Math.ceil(n / align) * align;
}

async function main() {
  // Reuse the same small, already-committed test fixtures used by
  // test/fs-modules.test.js, so this demo image is reproducible from the
  // persisted workspace alone (no /tmp scratch files required).
  const ext4Gz = await readFile(new URL('./fixtures/test2.ext4.img.gz', import.meta.url));
  const ext4 = gunzipSync(ext4Gz);
  const erofs = await readFile(new URL('./fixtures/test2.erofs.img', import.meta.url));

  const metadataRegionEnd = RESERVED + (GEOMETRY_SIZE + METADATA_MAX_SIZE * SLOT_COUNT) * 2;
  const systemOffset = pad(metadataRegionEnd, SECTOR);
  const systemLen = pad(ext4.length, SECTOR);
  const productOffset = systemOffset + systemLen;
  const productLen = pad(erofs.length, SECTOR);
  const totalSize = productOffset + productLen;

  const image = new Uint8Array(totalSize);
  image.set(ext4, systemOffset);
  image.set(erofs, productOffset);

  const partitionEntrySize = 52;
  const extentEntrySize = 24;
  const groupEntrySize = 48;
  const blockDeviceEntrySize = 64;
  const partitionsCount = 2;
  const extentsCount = 2;
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
  writePartition(0, 'system_a', 0, 0, 1, 0);
  writePartition(1, 'product_a', 0, 1, 1, 0);

  function writeExtent(idx, numSectors, targetType, targetData, targetSource) {
    const off = extentsOffset + idx * extentEntrySize;
    tdv.setBigUint64(off, BigInt(numSectors), true);
    tdv.setUint32(off + 8, targetType, true);
    tdv.setBigUint64(off + 12, BigInt(targetData), true);
    tdv.setUint32(off + 20, targetSource, true);
  }
  writeExtent(0, systemLen / SECTOR, 0, systemOffset / SECTOR, 0);
  writeExtent(1, productLen / SECTOR, 0, productOffset / SECTOR, 0);

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

  await writeFile('/home/user/super-unpacker/sample-data/super_demo.img', image);
  console.log('Wrote sample-data/super_demo.img:', totalSize, 'bytes');
}

main();
