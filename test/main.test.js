import test from 'node:test';
import assert from 'node:assert/strict';

import { indexSparseOrRaw } from '../src/sparse.js';
import { VirtualDisk, naturalCompare } from '../src/virtual-disk.js';
import { readGeometry, readMetadata, partitionSizeBytes, partitionAttrString } from '../src/lp.js';
import { extractPartition, makePartitionReader } from '../src/extractor.js';
import { buildFixture, FIXTURE_LAYOUT } from './fixture.js';
import { encodeSparse } from './sparse-encode.js';

function memorySink() {
  const parts = [];
  return {
    sink: {
      write: async (chunk) => {
        parts.push(Uint8Array.from(chunk));
      },
      close: async () => {},
      abort: async () => {},
    },
    result: () => {
      const total = parts.reduce((a, b) => a + b.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        out.set(p, off);
        off += p.length;
      }
      return out;
    },
  };
}

async function parseAndCheckPartitions(disk, fixture) {
  const geo = await readGeometry(disk);
  assert.equal(geo.checksumValid, true, 'geometry checksum should validate');
  assert.equal(geo.metadata_slot_count, 2);

  const meta = await readMetadata(disk, geo, 0);
  assert.equal(meta.partitions.length, 3);

  const byName = Object.fromEntries(meta.partitions.map((p) => [p.name, p]));
  assert.ok(byName.boot);
  assert.ok(byName.system);
  assert.ok(byName.vendor);

  assert.equal(partitionSizeBytes(meta, byName.boot), BigInt(FIXTURE_LAYOUT.bootLen));
  assert.equal(
    partitionSizeBytes(meta, byName.system),
    BigInt(FIXTURE_LAYOUT.systemPart1Len + FIXTURE_LAYOUT.systemZeroLen)
  );
  assert.equal(partitionSizeBytes(meta, byName.vendor), BigInt(FIXTURE_LAYOUT.vendorLen));
  assert.equal(partitionAttrString(byName.vendor.attributes), 'readonly');

  const bootSink = memorySink();
  await extractPartition(disk, meta, byName.boot, bootSink.sink);
  assert.deepEqual(bootSink.result(), fixture.expected.boot);

  const systemSink = memorySink();
  await extractPartition(disk, meta, byName.system, systemSink.sink);
  const expectedSystem = new Uint8Array(
    fixture.expected.system.length + fixture.expected.systemZero.length
  );
  expectedSystem.set(fixture.expected.system, 0);
  expectedSystem.set(fixture.expected.systemZero, fixture.expected.system.length);
  assert.deepEqual(systemSink.result(), expectedSystem);

  const vendorSink = memorySink();
  await extractPartition(disk, meta, byName.vendor, vendorSink.sink);
  assert.deepEqual(vendorSink.result(), fixture.expected.vendor);

  // makePartitionReader must read byte-identical data straight off the
  // virtual disk's LP extents (used by the security scanner), including
  // across the linear->zero extent boundary within "system" and arbitrary
  // offsets/lengths that span multiple extents in one call.
  const systemReader = makePartitionReader(disk, meta, byName.system);
  const wholeSystem = await systemReader(0, expectedSystem.length);
  assert.deepEqual(wholeSystem, expectedSystem);

  const straddle = await systemReader(
    fixture.expected.system.length - 16,
    32 // 16 bytes from the end of the linear extent + 16 bytes from the zero extent
  );
  const expectedStraddle = expectedSystem.subarray(
    fixture.expected.system.length - 16,
    fixture.expected.system.length + 16
  );
  assert.deepEqual(straddle, expectedStraddle);

  const vendorReader = makePartitionReader(disk, meta, byName.vendor);
  assert.deepEqual(await vendorReader(0, fixture.expected.vendor.length), fixture.expected.vendor);

  return meta;
}

test('raw (non-sparse) super.img: geometry, metadata and extraction all round-trip', async () => {
  const fixture = await buildFixture();
  const file = new Blob([fixture.image]);
  const index = await indexSparseOrRaw(file);
  assert.equal(index.sparse, false);
  assert.equal(index.outputSize, fixture.image.length);

  const disk = new VirtualDisk([{ file, index }]);
  assert.equal(disk.totalSize, fixture.image.length);

  const full = await disk.read(0, fixture.image.length);
  assert.deepEqual(full, fixture.image);

  await parseAndCheckPartitions(disk, fixture);
});

test('sparse-encoded super.img decodes to identical bytes and metadata', async () => {
  const fixture = await buildFixture();
  const L = FIXTURE_LAYOUT;
  const bootStart = L.metadataRegionEnd;
  const systemStart = bootStart + L.bootLen;
  const vendorStart = systemStart + L.systemPart1Len;

  const plan = [
    { type: 'zero', length: 4096 }, // reserved area
    { type: 'raw', length: bootStart - 4096 }, // geometry + metadata slots
    { type: 'raw', length: L.bootLen }, // boot
    { type: 'raw', length: L.systemPart1Len }, // system part 1
    { type: 'fill', length: L.vendorLen, fillValue: L.vendorFillValue }, // vendor
  ];
  const sparseBytes = encodeSparse(fixture.image, plan, 4096);
  const file = new Blob([sparseBytes]);

  const index = await indexSparseOrRaw(file);
  assert.equal(index.sparse, true);
  assert.equal(index.outputSize, fixture.image.length);

  const disk = new VirtualDisk([{ file, index }]);
  const full = await disk.read(0, fixture.image.length);
  assert.deepEqual(full, fixture.image, 'decoded sparse bytes must match raw reference image');

  await parseAndCheckPartitions(disk, fixture);
});

test('split sparse image (super.img + super_1.img) concatenates and extracts correctly', async () => {
  const fixture = await buildFixture();
  const L = FIXTURE_LAYOUT;
  const bootStart = L.metadataRegionEnd;
  const systemStart = bootStart + L.bootLen;
  const vendorStart = systemStart + L.systemPart1Len;

  // Split right in the middle of the "system" partition's first extent, to
  // make sure cross-file reads during extraction work.
  const splitPoint = systemStart + L.systemPart1Len / 2;

  const planA = [
    { type: 'zero', length: 4096 },
    { type: 'raw', length: bootStart - 4096 },
    { type: 'raw', length: L.bootLen },
    { type: 'raw', length: splitPoint - systemStart },
  ];
  const planB = [
    { type: 'raw', length: systemStart + L.systemPart1Len - splitPoint },
    { type: 'fill', length: L.vendorLen, fillValue: L.vendorFillValue },
  ];

  const partABytes = encodeSparse(fixture.image.subarray(0, splitPoint), planA, 4096);
  const partBBytes = encodeSparse(fixture.image.subarray(splitPoint), planB, 4096);

  const fileNames = ['super_1.img', 'super.img'];
  fileNames.sort(naturalCompare);
  assert.deepEqual(fileNames, ['super.img', 'super_1.img']);

  const fileA = new Blob([partABytes]);
  const fileB = new Blob([partBBytes]);
  const indexA = await indexSparseOrRaw(fileA);
  const indexB = await indexSparseOrRaw(fileB);

  const disk = new VirtualDisk([
    { file: fileA, index: indexA },
    { file: fileB, index: indexB },
  ]);
  assert.equal(disk.totalSize, fixture.image.length);

  const full = await disk.read(0, fixture.image.length);
  assert.deepEqual(full, fixture.image);

  await parseAndCheckPartitions(disk, fixture);
});

test('naturalCompare orders numeric suffixes correctly', () => {
  const names = ['super_10.img', 'super_2.img', 'super.img', 'super_1.img'];
  names.sort(naturalCompare);
  assert.deepEqual(names, ['super.img', 'super_1.img', 'super_2.img', 'super_10.img']);
});

test('corrupted primary metadata is detected and backup copy is used instead', async () => {
  const fixture = await buildFixture();
  // Primary slot 0 lives at byte 12288..16384 (header 12288..12416, tables
  // 12416..12780). Flip a byte inside its tables region; the backup copy
  // (at 20480..24576) is untouched, so the reader should fall back to it.
  const primarySlot0TablesStart = 4096 + 4096 * 2 + 128; // reserved+geometry*2+header_size
  assert.ok(primarySlot0TablesStart > 12288 && primarySlot0TablesStart < 16384);
  fixture.image[primarySlot0TablesStart + 10] ^= 0xff;

  const file = new Blob([fixture.image]);
  const index = await indexSparseOrRaw(file);
  const disk = new VirtualDisk([{ file, index }]);
  const geo = await readGeometry(disk);
  const meta = await readMetadata(disk, geo, 0);
  assert.equal(meta.source, 'backup', 'should recover via backup metadata copy');
  assert.equal(meta.partitions.length, 3);
});
