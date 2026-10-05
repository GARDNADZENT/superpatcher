// Covers the "load a standalone GSI/system.img directly" fallback: when a
// loaded file has no LP ("super.img") geometry block at all -- most
// commonly because it's a GSI (Generic System Image) or any other
// standalone single-partition image, not a dynamic-partition super.img --
// the app should detect the raw ext4/EROFS filesystem and synthesize a
// single-partition metadata set instead of dead-ending with a generic
// "not a super.img" error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { indexSparseOrRaw } from '../src/sparse.js';
import { VirtualDisk } from '../src/virtual-disk.js';
import { readGeometry, partitionSizeBytes, findOverlappingExtents } from '../src/lp.js';
import { makePartitionReader } from '../src/extractor.js';
import { detectAndOpenFilesystem } from '../src/scanner.js';
import {
  detectRawFilesystemType,
  buildSyntheticRawImageMetadata,
  guessRawImagePartitionName,
} from '../src/raw-image.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = (...parts) => path.join(__dirname, 'fixtures', ...parts);

async function diskFromRawBytes(bytes) {
  const file = new Blob([bytes]);
  const index = await indexSparseOrRaw(file);
  return new VirtualDisk([{ file, index }]);
}

test('readGeometry() still correctly rejects a standalone ext4 image as "not a super.img"', async () => {
  const bytes = new Uint8Array(gunzipSync(await readFile(fixturePath('test2.ext4.img.gz'))));
  const disk = await diskFromRawBytes(bytes);
  await assert.rejects(() => readGeometry(disk), /No valid LP geometry block found/);
});

test('detectRawFilesystemType(): recognizes a standalone ext4 image', async () => {
  const bytes = new Uint8Array(gunzipSync(await readFile(fixturePath('test2.ext4.img.gz'))));
  const disk = await diskFromRawBytes(bytes);
  assert.equal(await detectRawFilesystemType(disk), 'ext4');
});

test('detectRawFilesystemType(): recognizes a standalone EROFS image', async () => {
  const bytes = new Uint8Array(await readFile(fixturePath('test2.erofs.img')));
  const disk = await diskFromRawBytes(bytes);
  assert.equal(await detectRawFilesystemType(disk), 'erofs');
});

test('detectRawFilesystemType(): returns null for genuinely unrecognized data', async () => {
  const bytes = new Uint8Array(65536);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) & 0xff; // not a real superblock
  const disk = await diskFromRawBytes(bytes);
  assert.equal(await detectRawFilesystemType(disk), null);
});

test('buildSyntheticRawImageMetadata(): produces a single LINEAR partition spanning the whole disk', async () => {
  const bytes = new Uint8Array(gunzipSync(await readFile(fixturePath('test2.ext4.img.gz'))));
  const disk = await diskFromRawBytes(bytes);
  const { geo, meta, truncatedBytes } = buildSyntheticRawImageMetadata(disk, 'ext4', 'system');

  assert.equal(truncatedBytes, 0, 'fixture is already sector-aligned');
  assert.equal(meta.partitions.length, 1);
  assert.equal(meta.partitions[0].name, 'system');
  assert.equal(Number(partitionSizeBytes(meta, meta.partitions[0])), disk.totalSize);
  assert.deepEqual(findOverlappingExtents(meta), { ok: true });
  assert.equal(geo.metadata_slot_count, 1);
  assert.equal(geo.checksumValid, true);
});

test('buildSyntheticRawImageMetadata(): the resulting partition is fully readable end-to-end (open filesystem + list root)', async () => {
  const bytes = new Uint8Array(gunzipSync(await readFile(fixturePath('test2.ext4.img.gz'))));
  const disk = await diskFromRawBytes(bytes);
  const { meta } = buildSyntheticRawImageMetadata(disk, 'ext4', 'system');
  const partition = meta.partitions[0];
  const readRange = makePartitionReader(disk, meta, partition);
  const { type, volume } = await detectAndOpenFilesystem(readRange);
  assert.equal(type, 'ext4');
  const entries = await volume.listDir(volume.rootInode);
  assert.ok(entries.length > 0, 'root directory should list at least one entry');
});

test('buildSyntheticRawImageMetadata(): also works for a standalone EROFS image', async () => {
  const bytes = new Uint8Array(await readFile(fixturePath('test2.erofs.img')));
  const disk = await diskFromRawBytes(bytes);
  const { meta } = buildSyntheticRawImageMetadata(disk, 'erofs', 'system');
  const partition = meta.partitions[0];
  const readRange = makePartitionReader(disk, meta, partition);
  const { type, volume } = await detectAndOpenFilesystem(readRange);
  assert.equal(type, 'erofs');
  const entries = await volume.listDir(volume.rootInode);
  assert.ok(entries.length > 0);
});

test('guessRawImagePartitionName(): recognizes common GSI/vendor/product filename patterns', () => {
  assert.equal(
    guessRawImagePartitionName('Infinity-X-3.12_GSI_treble_arm64-ab-GAPPS-Official-20260802.img'),
    'system'
  );
  assert.equal(guessRawImagePartitionName('system.img'), 'system');
  assert.equal(guessRawImagePartitionName('system-arm64-ab.img'), 'system');
  assert.equal(guessRawImagePartitionName('vendor.img'), 'vendor');
  assert.equal(guessRawImagePartitionName('product.img'), 'product');
  assert.equal(guessRawImagePartitionName('system_ext.img'), 'system_ext');
  assert.equal(guessRawImagePartitionName('my-custom-rom.img'), 'my-custom-rom');
});

test('buildSyntheticRawImageMetadata(): non-sector-aligned trailing bytes are reported, not silently included', async () => {
  const bytes = new Uint8Array(gunzipSync(await readFile(fixturePath('test2.ext4.img.gz'))));
  const padded = new Uint8Array(bytes.length + 100); // +100 bytes, not a multiple of 512
  padded.set(bytes);
  const disk = await diskFromRawBytes(padded);
  const { meta, truncatedBytes } = buildSyntheticRawImageMetadata(disk, 'ext4', 'system');
  assert.equal(truncatedBytes, 100);
  assert.equal(Number(partitionSizeBytes(meta, meta.partitions[0])), disk.totalSize - 100);
});
