// Round-trips encodeLpMetadata() through lp.js's own reader (the thing
// that will actually be trusted to parse any image this project produces),
// rather than just checking the encoder's raw bytes by hand -- the only
// correctness bar that actually matters here is "the reader we already
// ship agrees with what the writer we're adding produces".
import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeLpMetadata } from '../src/lp-writer.js';
import {
  readGeometry,
  readMetadata,
  partitionSizeBytes,
  partitionExtentRanges,
  LP_TARGET_TYPE_LINEAR,
  LP_TARGET_TYPE_ZERO,
  LP_SECTOR_SIZE,
} from '../src/lp.js';
import { sha256 } from '../src/sha256.js';
import { VirtualDisk } from '../src/virtual-disk.js';
import { indexSparseOrRaw } from '../src/sparse.js';

const RESERVED = 4096;
const GEOMETRY_SIZE = 4096;

/** Assembles a full disk image: [reserved][geometry x2][metadata slots] --
 * same layout lp.js expects -- around an already-encoded {header, tables}
 * pair, for however many slots are requested (every slot gets the same
 * content, primary and backup both). */
async function assembleDisk({ header, tables }, { metadataMaxSize = 4096, slotCount = 1 } = {}) {
  const totalMetaRegion = RESERVED + (GEOMETRY_SIZE + metadataMaxSize * slotCount) * 2;
  const image = new Uint8Array(totalMetaRegion);

  const geometry = new Uint8Array(GEOMETRY_SIZE);
  const gdv = new DataView(geometry.buffer);
  gdv.setUint32(0, 0x616c4467, true);
  const structSize = 52;
  gdv.setUint32(4, structSize, true);
  gdv.setUint32(40, metadataMaxSize, true);
  gdv.setUint32(44, slotCount, true);
  gdv.setUint32(48, 4096, true);
  const geoChecksum = await sha256(geometry.slice(0, structSize));
  geometry.set(geoChecksum, 8);
  image.set(geometry, RESERVED);
  image.set(geometry, RESERVED + GEOMETRY_SIZE);

  for (let slot = 0; slot < slotCount; slot++) {
    const primaryOff = RESERVED + GEOMETRY_SIZE * 2 + metadataMaxSize * slot;
    const backupOff = RESERVED + GEOMETRY_SIZE * 2 + metadataMaxSize * slotCount + metadataMaxSize * slot;
    image.set(header, primaryOff);
    image.set(tables, primaryOff + header.length);
    image.set(header, backupOff);
    image.set(tables, backupOff + header.length);
  }

  const file = new Blob([image]);
  const index = await indexSparseOrRaw(file);
  return new VirtualDisk([{ file, index }]);
}

test('encodeLpMetadata(): round-trips a simple single-partition table through lp.js', async () => {
  const partitions = [{ name: 'system', attributes: 1, first_extent_index: 0, num_extents: 1, group_index: 0 }];
  const extents = [{ num_sectors: 100n, target_type: LP_TARGET_TYPE_LINEAR, target_data: 8n, target_source: 0 }];
  const groups = [{ name: 'default', flags: 0, maximum_size: 0n }];
  const blockDevices = [
    { first_logical_sector: 0n, alignment: 0, alignment_offset: 0, size: 1_000_000n, partition_name: 'super', flags: 0 },
  ];

  const encoded = await encodeLpMetadata({ partitions, extents, groups, blockDevices });
  const disk = await assembleDisk(encoded);
  const geo = await readGeometry(disk);
  assert.equal(geo.checksumValid, true);
  const meta = await readMetadata(disk, geo, 0);
  assert.equal(meta.source, 'primary');
  assert.equal(meta.partitions.length, 1);
  assert.equal(meta.partitions[0].name, 'system');
  assert.equal(meta.partitions[0].attributes, 1);
  assert.equal(Number(partitionSizeBytes(meta, meta.partitions[0])), 100 * LP_SECTOR_SIZE);
  assert.equal(meta.groups[0].name, 'default');
  assert.equal(meta.blockDevices[0].partition_name, 'super');
  assert.equal(meta.blockDevices[0].size, 1_000_000n);
});

test('encodeLpMetadata(): round-trips multiple partitions, groups, and a ZERO extent', async () => {
  const partitions = [
    { name: 'system', attributes: 0, first_extent_index: 0, num_extents: 1, group_index: 0 },
    { name: 'vendor', attributes: 2, first_extent_index: 1, num_extents: 2, group_index: 1 },
  ];
  const extents = [
    { num_sectors: 50n, target_type: LP_TARGET_TYPE_LINEAR, target_data: 8n, target_source: 0 },
    { num_sectors: 10n, target_type: LP_TARGET_TYPE_ZERO, target_data: 0n, target_source: 0 },
    { num_sectors: 20n, target_type: LP_TARGET_TYPE_LINEAR, target_data: 58n, target_source: 0 },
  ];
  const groups = [
    { name: 'default', flags: 0, maximum_size: 0n },
    { name: 'group_b', flags: 1, maximum_size: 500000n },
  ];
  const blockDevices = [
    { first_logical_sector: 0n, alignment: 4096, alignment_offset: 0, size: 2_000_000n, partition_name: 'super', flags: 0 },
  ];

  const encoded = await encodeLpMetadata({ partitions, extents, groups, blockDevices });
  const disk = await assembleDisk(encoded);
  const geo = await readGeometry(disk);
  const meta = await readMetadata(disk, geo, 0);

  assert.equal(meta.partitions.length, 2);
  assert.equal(meta.partitions[1].name, 'vendor');
  assert.equal(meta.partitions[1].group_index, 1);
  assert.equal(meta.groups[1].name, 'group_b');
  assert.equal(meta.groups[1].maximum_size, 500000n);

  const vendorRanges = partitionExtentRanges(meta, meta.partitions[1]);
  assert.equal(vendorRanges.length, 2);
  assert.equal(vendorRanges[0].type, 'zero');
  assert.equal(vendorRanges[1].type, 'linear');
  assert.equal(vendorRanges[1].byteOffset, 58n * BigInt(LP_SECTOR_SIZE));
});

test('encodeLpMetadata(): backup slot also reads correctly (both copies identical)', async () => {
  const partitions = [{ name: 'a', attributes: 0, first_extent_index: 0, num_extents: 1, group_index: 0 }];
  const extents = [{ num_sectors: 8n, target_type: LP_TARGET_TYPE_LINEAR, target_data: 8n, target_source: 0 }];
  const groups = [{ name: 'default', flags: 0, maximum_size: 0n }];
  const blockDevices = [
    { first_logical_sector: 0n, alignment: 0, alignment_offset: 0, size: 100_000n, partition_name: 'super', flags: 0 },
  ];
  const encoded = await encodeLpMetadata({ partitions, extents, groups, blockDevices });
  const disk = await assembleDisk(encoded);
  const geo = await readGeometry(disk);
  const meta = await readMetadata(disk, geo, 0);
  assert.equal(meta.source, 'primary');
  assert.equal(meta.partitions[0].name, 'a');
});

test('encodeLpMetadata(): round-trips multiple metadata slots independently', async () => {
  const makeTable = (name) => ({
    partitions: [{ name, attributes: 0, first_extent_index: 0, num_extents: 1, group_index: 0 }],
    extents: [{ num_sectors: 8n, target_type: LP_TARGET_TYPE_LINEAR, target_data: 8n, target_source: 0 }],
    groups: [{ name: 'default', flags: 0, maximum_size: 0n }],
    blockDevices: [
      { first_logical_sector: 0n, alignment: 0, alignment_offset: 0, size: 100_000n, partition_name: 'super', flags: 0 },
    ],
  });
  // Encode two DIFFERENT tables and place them in slot 0 and slot 1
  // independently, to confirm the slot-offset math in assembleDisk/lp.js
  // keeps them from colliding.
  const encoded0 = await encodeLpMetadata(makeTable('slot0part'));
  const encoded1 = await encodeLpMetadata(makeTable('slot1part'));

  const metadataMaxSize = 4096;
  const slotCount = 2;
  const totalMetaRegion = RESERVED + (GEOMETRY_SIZE + metadataMaxSize * slotCount) * 2;
  const image = new Uint8Array(totalMetaRegion);
  const geometry = new Uint8Array(GEOMETRY_SIZE);
  const gdv = new DataView(geometry.buffer);
  gdv.setUint32(0, 0x616c4467, true);
  gdv.setUint32(4, 52, true);
  gdv.setUint32(40, metadataMaxSize, true);
  gdv.setUint32(44, slotCount, true);
  gdv.setUint32(48, 4096, true);
  const geoChecksum = await sha256(geometry.slice(0, 52));
  geometry.set(geoChecksum, 8);
  image.set(geometry, RESERVED);
  image.set(geometry, RESERVED + GEOMETRY_SIZE);

  function primaryOff(slot) {
    return RESERVED + GEOMETRY_SIZE * 2 + metadataMaxSize * slot;
  }
  function backupOff(slot) {
    return RESERVED + GEOMETRY_SIZE * 2 + metadataMaxSize * slotCount + metadataMaxSize * slot;
  }
  image.set(encoded0.header, primaryOff(0));
  image.set(encoded0.tables, primaryOff(0) + encoded0.header.length);
  image.set(encoded0.header, backupOff(0));
  image.set(encoded0.tables, backupOff(0) + encoded0.header.length);
  image.set(encoded1.header, primaryOff(1));
  image.set(encoded1.tables, primaryOff(1) + encoded1.header.length);
  image.set(encoded1.header, backupOff(1));
  image.set(encoded1.tables, backupOff(1) + encoded1.header.length);

  const file = new Blob([image]);
  const index = await indexSparseOrRaw(file);
  const disk = new VirtualDisk([{ file, index }]);
  const geo = await readGeometry(disk);

  const meta0 = await readMetadata(disk, geo, 0);
  const meta1 = await readMetadata(disk, geo, 1);
  assert.equal(meta0.partitions[0].name, 'slot0part');
  assert.equal(meta1.partitions[0].name, 'slot1part');
});

test('encodeLpMetadata(): rejects an out-of-range headerSize', async () => {
  const minimal = {
    partitions: [],
    extents: [],
    groups: [{ name: 'default', flags: 0, maximum_size: 0n }],
    blockDevices: [
      { first_logical_sector: 0n, alignment: 0, alignment_offset: 0, size: 1000n, partition_name: 'super', flags: 0 },
    ],
  };
  await assert.rejects(() => encodeLpMetadata(minimal, 64));
  await assert.rejects(() => encodeLpMetadata(minimal, 5000));
});
