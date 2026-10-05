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
