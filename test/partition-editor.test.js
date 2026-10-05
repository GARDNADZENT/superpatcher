import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSuperImage } from './lp-test-helpers.mjs';
import { indexSparseOrRaw } from '../src/sparse.js';
import { VirtualDisk } from '../src/virtual-disk.js';
import {
  readGeometry,
  readMetadata,
  partitionSizeBytes,
  partitionExtentRanges,
  findOverlappingExtents,
} from '../src/lp.js';
import { makePartitionReader } from '../src/extractor.js';
import {
  planPartitionEdits,
  streamEditedSuperImage,
  PartitionEditError,
} from '../src/partition-editor.js';

function deterministicBytes(n, seed = 1) {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 2654435761 + seed) & 0xff;
  return a;
}

async function loadDisk(bytes) {
  const file = new Blob([bytes]);
  const index = await indexSparseOrRaw(file);
  const disk = new VirtualDisk([{ file, index }]);
  const geo = await readGeometry(disk);
  const meta = await readMetadata(disk, geo, 0);
  return { disk, geo, meta };
}

/** Reads a whole uploaded-replacement-style in-memory source into a
 * readSource(offset,length) function, the shape streamEditedSuperImage
 * expects per allocation. */
function sourceFromBytes(bytes) {
  return async (offset, length) => bytes.subarray(offset, offset + length);
}

async function buildAndRead(disk, geo, plan, sources) {
  const chunks = [];
  for await (const chunk of streamEditedSuperImage(disk, geo, plan, sources)) chunks.push(chunk);
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  assert.equal(out.length, plan.newTotalSize, 'streamed output length must match the plan');
  return out;
}

async function buildBaseImage() {
  const partitions = [
    { name: 'system', bytes: deterministicBytes(20000, 1) },
    { name: 'vendor', bytes: deterministicBytes(15000, 2) },
    { name: 'product', bytes: deterministicBytes(10000, 3) },
  ];
  return buildSuperImage(partitions);
}

test('planPartitionEdits(): delete a partition removes it and shrinks nothing else', async () => {
  const image = await buildBaseImage();
  const { meta, geo } = await loadDisk(image);
  const plan = planPartitionEdits(meta, geo, [{ action: 'delete', name: 'vendor' }]);
  assert.equal(plan.newMeta.partitions.find((p) => p.name === 'vendor'), undefined);
  assert.equal(plan.newMeta.partitions.length, 2);
  assert.deepEqual(plan.deletedNames, ['vendor']);
  // Deleting never shrinks the file (abandoned space, never reused).
  assert.equal(plan.newTotalSize, plan.originalTotalSize);
  assert.equal(plan.grew, false);
});

test('streamEditedSuperImage(): a deleted partition is actually gone after rebuilding, others untouched', async () => {
  const image = await buildBaseImage();
  const { disk, geo, meta } = await loadDisk(image);
  const originalVendorBytes = await makePartitionReader(disk, meta, meta.partitions.find((p) => p.name === 'vendor'))(
    0,
    15000
  );
  assert.deepEqual(originalVendorBytes, deterministicBytes(15000, 2));

  const plan = planPartitionEdits(meta, geo, [{ action: 'delete', name: 'vendor' }]);
  const rebuilt = await buildAndRead(disk, geo, plan, new Map());

  const { meta: newMeta } = await loadDisk(rebuilt);
  assert.deepEqual(
    newMeta.partitions.map((p) => p.name).sort(),
    ['product', 'system']
  );

  const { disk: newDisk } = await loadDisk(rebuilt);
  const systemBytes = await makePartitionReader(newDisk, newMeta, newMeta.partitions.find((p) => p.name === 'system'))(
    0,
    20000
  );
  assert.deepEqual(systemBytes, deterministicBytes(20000, 1), 'untouched partition must be byte-identical');
});

test('streamEditedSuperImage(): replacing with a SMALLER image works and content matches exactly', async () => {
  const image = await buildBaseImage();
  const { disk, geo, meta } = await loadDisk(image);
  const newSystemContent = deterministicBytes(5000, 99);

  const plan = planPartitionEdits(meta, geo, [{ action: 'replace', name: 'system', sizeBytes: newSystemContent.length }]);
  const sources = new Map([['system', sourceFromBytes(newSystemContent)]]);
  const rebuilt = await buildAndRead(disk, geo, plan, sources);

  const { disk: newDisk, meta: newMeta } = await loadDisk(rebuilt);
  const sysPartition = newMeta.partitions.find((p) => p.name === 'system');
  const sysBytes = await makePartitionReader(newDisk, newMeta, sysPartition)(0, newSystemContent.length);
  assert.deepEqual(sysBytes, newSystemContent);

  // Other partitions untouched.
  const vendorBytes = await makePartitionReader(newDisk, newMeta, newMeta.partitions.find((p) => p.name === 'vendor'))(
    0,
    15000
  );
  assert.deepEqual(vendorBytes, deterministicBytes(15000, 2));
});

test('streamEditedSuperImage(): replacing with a LARGER image grows the file and allocates new space', async () => {
  const image = await buildBaseImage();
  const { disk, geo, meta } = await loadDisk(image);
  const bigSystemContent = deterministicBytes(500000, 42); // much bigger than the original 20000-byte "system"

  const plan = planPartitionEdits(meta, geo, [{ action: 'replace', name: 'system', sizeBytes: bigSystemContent.length }]);
  assert.equal(plan.grew, true);
  assert.ok(plan.newTotalSize > plan.originalTotalSize);

  const sources = new Map([['system', sourceFromBytes(bigSystemContent)]]);
  const rebuilt = await buildAndRead(disk, geo, plan, sources);

  const { disk: newDisk, geo: newGeo, meta: newMeta } = await loadDisk(rebuilt);
  assert.equal(newGeo.checksumValid, true);
  const sysPartition = newMeta.partitions.find((p) => p.name === 'system');
  assert.equal(Number(partitionSizeBytes(newMeta, sysPartition)) >= bigSystemContent.length, true);
  const sysBytes = await makePartitionReader(newDisk, newMeta, sysPartition)(0, bigSystemContent.length);
  assert.deepEqual(sysBytes, bigSystemContent);

  // Untouched partitions still byte-identical.
  const productBytes = await makePartitionReader(newDisk, newMeta, newMeta.partitions.find((p) => p.name === 'product'))(
    0,
    10000
  );
  assert.deepEqual(productBytes, deterministicBytes(10000, 3));

  assert.deepEqual(findOverlappingExtents(newMeta), { ok: true });
});

test('streamEditedSuperImage(): adding a brand new partition works', async () => {
  const image = await buildBaseImage();
  const { disk, geo, meta } = await loadDisk(image);
  const newContent = deterministicBytes(8000, 7);

  const plan = planPartitionEdits(meta, geo, [
    { action: 'add', name: 'my_custom', groupName: 'default', sizeBytes: newContent.length },
  ]);
  const sources = new Map([['my_custom', sourceFromBytes(newContent)]]);
  const rebuilt = await buildAndRead(disk, geo, plan, sources);

  const { disk: newDisk, meta: newMeta } = await loadDisk(rebuilt);
  assert.ok(newMeta.partitions.some((p) => p.name === 'my_custom'));
  const bytes = await makePartitionReader(newDisk, newMeta, newMeta.partitions.find((p) => p.name === 'my_custom'))(
    0,
    newContent.length
  );
  assert.deepEqual(bytes, newContent);
});

test('streamEditedSuperImage(): combined delete + replace + add in one plan, extents never overlap', async () => {
  const image = await buildBaseImage();
  const { disk, geo, meta } = await loadDisk(image);
  const newVendor = deterministicBytes(300000, 11);
  const brandNew = deterministicBytes(2000, 22);

  const plan = planPartitionEdits(meta, geo, [
    { action: 'delete', name: 'product' },
    { action: 'replace', name: 'vendor', sizeBytes: newVendor.length },
    { action: 'add', name: 'extra', groupName: 'default', sizeBytes: brandNew.length },
  ]);
  const sources = new Map([
    ['vendor', sourceFromBytes(newVendor)],
    ['extra', sourceFromBytes(brandNew)],
  ]);
  const rebuilt = await buildAndRead(disk, geo, plan, sources);

  const { disk: newDisk, meta: newMeta } = await loadDisk(rebuilt);
  assert.deepEqual(
    newMeta.partitions.map((p) => p.name).sort(),
    ['extra', 'system', 'vendor']
  );
  assert.deepEqual(findOverlappingExtents(newMeta), { ok: true });

  const vendorBytes = await makePartitionReader(newDisk, newMeta, newMeta.partitions.find((p) => p.name === 'vendor'))(
    0,
    newVendor.length
  );
  assert.deepEqual(vendorBytes, newVendor);
  const extraBytes = await makePartitionReader(newDisk, newMeta, newMeta.partitions.find((p) => p.name === 'extra'))(
    0,
    brandNew.length
  );
  assert.deepEqual(extraBytes, brandNew);
  const systemBytes = await makePartitionReader(newDisk, newMeta, newMeta.partitions.find((p) => p.name === 'system'))(
    0,
    20000
  );
  assert.deepEqual(systemBytes, deterministicBytes(20000, 1));
});

test('planPartitionEdits(): rejects deleting/replacing a nonexistent partition', async () => {
  const image = await buildBaseImage();
  const { meta, geo } = await loadDisk(image);
  assert.throws(() => planPartitionEdits(meta, geo, [{ action: 'delete', name: 'nope' }]), PartitionEditError);
  assert.throws(
    () => planPartitionEdits(meta, geo, [{ action: 'replace', name: 'nope', sizeBytes: 100 }]),
    PartitionEditError
  );
});

test('planPartitionEdits(): rejects adding a partition name that already exists', async () => {
  const image = await buildBaseImage();
  const { meta, geo } = await loadDisk(image);
  assert.throws(
    () => planPartitionEdits(meta, geo, [{ action: 'add', name: 'system', groupName: 'default', sizeBytes: 100 }]),
    PartitionEditError
  );
});

test('planPartitionEdits(): rejects adding into a nonexistent group', async () => {
  const image = await buildBaseImage();
  const { meta, geo } = await loadDisk(image);
  assert.throws(
    () => planPartitionEdits(meta, geo, [{ action: 'add', name: 'new1', groupName: 'no_such_group', sizeBytes: 100 }]),
    PartitionEditError
  );
});

test('planPartitionEdits(): rejects marking the same partition deleted AND replaced', async () => {
  const image = await buildBaseImage();
  const { meta, geo } = await loadDisk(image);
  assert.throws(
    () =>
      planPartitionEdits(meta, geo, [
        { action: 'delete', name: 'system' },
        { action: 'replace', name: 'system', sizeBytes: 100 },
      ]),
    PartitionEditError
  );
});

test('planPartitionEdits(): enforces a nonzero group maximum_size cap', async () => {
  const image = await buildBaseImage();
  const { meta, geo } = await loadDisk(image);
  // Artificially cap the "default" group small enough that a big replacement won't fit.
  const cappedMeta = { ...meta, groups: [{ ...meta.groups[0], maximum_size: 1000n }] };
  assert.throws(
    () => planPartitionEdits(cappedMeta, geo, [{ action: 'replace', name: 'system', sizeBytes: 50000 }]),
    PartitionEditError
  );
});

test('planPartitionEdits(): rejects zero-byte replacement/add content', async () => {
  const image = await buildBaseImage();
  const { meta, geo } = await loadDisk(image);
  assert.throws(() => planPartitionEdits(meta, geo, [{ action: 'replace', name: 'system', sizeBytes: 0 }]), PartitionEditError);
  assert.throws(
    () => planPartitionEdits(meta, geo, [{ action: 'add', name: 'z', groupName: 'default', sizeBytes: 0 }]),
    PartitionEditError
  );
});

test('streamEditedSuperImage(): tags a read failure from the ORIGINAL image with a clear sourceLabel', async () => {
  const image = await buildBaseImage();
  const { disk, geo, meta } = await loadDisk(image);
  const plan = planPartitionEdits(meta, geo, [{ action: 'delete', name: 'vendor' }]);

  const originalRead = disk.read.bind(disk);
  let calls = 0;
  disk.read = async (...args) => {
    calls++;
    if (calls === 1) {
      const err = new Error('The requested file could not be read, typically due to permission problems...');
      err.name = 'NotReadableError';
      err.fileName = 'super.img';
      throw err;
    }
    return originalRead(...args);
  };

  await assert.rejects(
    () => buildAndRead(disk, geo, plan, new Map()),
    (err) => {
      assert.equal(err.sourceLabel, 'the original super.img');
      assert.equal(err.fileName, 'super.img');
      return true;
    }
  );
});

test('streamEditedSuperImage(): tags a read failure from a REPLACEMENT source with the partition name', async () => {
  const image = await buildBaseImage();
  const { disk, geo, meta } = await loadDisk(image);
  const newContent = deterministicBytes(5000, 99);
  const plan = planPartitionEdits(meta, geo, [{ action: 'replace', name: 'system', sizeBytes: newContent.length }]);

  const failingSource = async () => {
    const err = new Error('The requested file could not be read, typically due to permission problems...');
    err.name = 'NotReadableError';
    err.fileName = 'my-custom-system.img';
    throw err;
  };
  const sources = new Map([['system', failingSource]]);

  await assert.rejects(
    () => buildAndRead(disk, geo, plan, sources),
    (err) => {
      assert.equal(err.sourceLabel, 'the replacement/new content for "system"');
      assert.equal(err.fileName, 'my-custom-system.img');
      return true;
    }
  );
});

// ---------------- space-reclaiming allocator ----------------

test('planPartitionEdits(): replacing a partition with content that fits in ITS OWN freed space does not grow the file', async () => {
  const image = await buildBaseImage();
  const { meta, geo } = await loadDisk(image);
  // "system" is 20000 bytes; replace with something smaller -- must fit
  // entirely inside system's own freed extent, no growth needed at all.
  const plan = planPartitionEdits(meta, geo, [{ action: 'replace', name: 'system', sizeBytes: 10000 }]);
  assert.equal(plan.grew, false);
  assert.equal(plan.newTotalSize, plan.originalTotalSize);
  assert.equal(plan.allocations[0].ranges.length, 1);
  assert.equal(plan.allocations[0].ranges[0].byteOffset < plan.originalBoundary, true);
});

test('planPartitionEdits(): deleting a partition frees its space for a DIFFERENT partition\'s replacement', async () => {
  const image = await buildBaseImage();
  const { meta, geo } = await loadDisk(image);
  // Delete "product" (10000 bytes) and grow "vendor" (originally 15000) up
  // to 20000 bytes -- the extra 5000 bytes needed should come from
  // product's freed space, not force the file to grow.
  const plan = planPartitionEdits(meta, geo, [
    { action: 'delete', name: 'product' },
    { action: 'replace', name: 'vendor', sizeBytes: 20000 },
  ]);
  assert.equal(plan.grew, false, `expected no growth, got ${plan.originalTotalSize} -> ${plan.newTotalSize}`);
  assert.ok(plan.freeBytesReclaimed > 0);
});

test('streamEditedSuperImage(): a replacement split across multiple reused free fragments reads back correctly, and surrounding untouched bytes survive', async () => {
  // A dedicated 4-partition layout where "keep_me" physically sits BETWEEN
  // "vendor" and "product" (buildSuperImage lays partitions out
  // sequentially in array order) -- so deleting vendor+product leaves two
  // genuinely non-adjacent freed fragments, with keep_me's untouched bytes
  // sandwiched in between them.
  const image = await buildSuperImage([
    { name: 'system', bytes: deterministicBytes(20000, 1) },
    { name: 'vendor', bytes: deterministicBytes(15000, 2) },
    { name: 'keep_me', bytes: deterministicBytes(8000, 9) },
    { name: 'product', bytes: deterministicBytes(10000, 3) },
  ]);
  const { disk, geo, meta } = await loadDisk(image);
  const newContent = deterministicBytes(23000, 55); // > either single freed fragment alone
  const plan = planPartitionEdits(meta, geo, [
    { action: 'delete', name: 'vendor' },
    { action: 'delete', name: 'product' },
    { action: 'add', name: 'merged_new', groupName: 'default', sizeBytes: newContent.length },
  ]);
  const newPartAlloc = plan.allocations.find((a) => a.name === 'merged_new');
  assert.ok(newPartAlloc.ranges.length >= 2, 'expected the new content to span multiple reused fragments');
  assert.equal(plan.grew, false, 'the two freed fragments together are big enough, so this should not need to grow');

  const sources = new Map([['merged_new', sourceFromBytes(newContent)]]);
  const rebuilt = await buildAndRead(disk, geo, plan, sources);

  const { disk: newDisk, meta: newMeta } = await loadDisk(rebuilt);
  const mergedPartition = newMeta.partitions.find((p) => p.name === 'merged_new');
  const readBack = await makePartitionReader(newDisk, newMeta, mergedPartition)(0, newContent.length);
  assert.deepEqual(readBack, newContent, 'content spanning multiple reused fragments must read back correctly, in order');

  // The untouched "system" and "keep_me" partitions (which physically
  // sandwich/separate the two freed fragments) must still be exactly right.
  const systemBytes = await makePartitionReader(newDisk, newMeta, newMeta.partitions.find((p) => p.name === 'system'))(
    0,
    20000
  );
  assert.deepEqual(systemBytes, deterministicBytes(20000, 1));
  const keepMeBytes = await makePartitionReader(newDisk, newMeta, newMeta.partitions.find((p) => p.name === 'keep_me'))(
    0,
    8000
  );
  assert.deepEqual(keepMeBytes, deterministicBytes(8000, 9));
  assert.deepEqual(findOverlappingExtents(newMeta), { ok: true });
});

test('streamEditedSuperImage(): a replacement that partially reuses freed space and partially appends reads back correctly', async () => {
  const image = await buildBaseImage();
  const { disk, geo, meta } = await loadDisk(image);
  // Delete "product" (10000 bytes) and replace "vendor" with something
  // bigger than (vendor's own 15000) + (product's freed 10000 bytes)
  // combined -- the remainder must be appended as new space, and the
  // content must still come back byte-for-byte correct across the
  // reused+appended boundary.
  const newContent = deterministicBytes(40000, 77); // > 15000+10000 = 25000 available for reuse
  const plan = planPartitionEdits(meta, geo, [
    { action: 'delete', name: 'product' },
    { action: 'replace', name: 'vendor', sizeBytes: newContent.length },
  ]);
  assert.equal(plan.grew, true);
  const vendorAlloc = plan.allocations.find((a) => a.name === 'vendor');
  assert.ok(vendorAlloc.ranges.length >= 2, 'expected a mix of reused + appended ranges');
  const lastRange = vendorAlloc.ranges[vendorAlloc.ranges.length - 1];
  assert.ok(lastRange.byteOffset >= plan.originalBoundary, 'the overflow portion must be a pure append');

  const sources = new Map([['vendor', sourceFromBytes(newContent)]]);
  const rebuilt = await buildAndRead(disk, geo, plan, sources);
  const { disk: newDisk, meta: newMeta } = await loadDisk(rebuilt);
  const vendorBytes = await makePartitionReader(
    newDisk,
    newMeta,
    newMeta.partitions.find((p) => p.name === 'vendor')
  )(0, newContent.length);
  assert.deepEqual(vendorBytes, newContent);
  assert.deepEqual(findOverlappingExtents(newMeta), { ok: true });
});

test('planPartitionEdits(): accepts an explicit originalDiskSize that is larger than the declared block device size', async () => {
  const image = await buildBaseImage();
  const { meta, geo } = await loadDisk(image);
  const paddedSize = image.length + 4096; // pretend the real file has trailing padding
  const plan = planPartitionEdits(meta, geo, [{ action: 'add', name: 'z', groupName: 'default', sizeBytes: 100 }], {
    originalDiskSize: paddedSize,
  });
  // The new allocation must land at/after the padded size, never inside
  // the "unknown trailing data" region.
  const alloc = plan.allocations.find((a) => a.name === 'z');
  assert.ok(alloc.ranges[0].byteOffset >= paddedSize);
});

