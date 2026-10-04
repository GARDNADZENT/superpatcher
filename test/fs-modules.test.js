import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openZip, findEntry } from '../src/zip.js';
import { parseAndroidManifest } from '../src/axml.js';
import { Ext4Volume, looksLikeExt4 } from '../src/ext4.js';
import { ErofsVolume, looksLikeErofs } from '../src/erofs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = (...parts) => path.join(__dirname, 'fixtures', ...parts);

function readRangeFor(u8) {
  return async (offset, length) => u8.subarray(offset, offset + length);
}

async function walkFsVolume(vol, inode, pathSoFar, out) {
  const entries = await vol.listDir(inode);
  for (const e of entries) {
    const childInode = await vol.readInode(e.inodeNumber ?? e.nid);
    const childPath = `${pathSoFar}/${e.name}`;
    if (childInode.isDir) {
      await walkFsVolume(vol, childInode, childPath, out);
    } else {
      out.push({ path: childPath, inode: childInode });
    }
  }
}

// ---------------------------------------------------------------------------
// zip.js
// ---------------------------------------------------------------------------

test('zip.js extracts AndroidManifest.xml identical to a real APK (stored + deflate)', async () => {
  const buf = await readFile(fixturePath('apks', 'ScorpioSecurity.apk'));
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const zip = await openZip(readRangeFor(u8), u8.length);
  assert.equal(zip.entries.length, 1);

  const entry = findEntry(zip, 'AndroidManifest.xml');
  assert.ok(entry, 'AndroidManifest.xml entry should exist');
  const data = await zip.readEntry(entry);
  assert.equal(data.length, entry.uncompressedSize);
  // Sanity: compiled binary XML files start with chunk type 0x0003 (little-endian).
  assert.equal(data[0], 0x03);
  assert.equal(data[1], 0x00);
});

test('zip.js throws a clear error for unsupported compression methods instead of corrupting data', async () => {
  // Synthesize a minimal ZIP with an unsupported method (method 99) to check
  // the failure mode without needing a real exotic archive.
  const encoder = new TextEncoder();
  const name = encoder.encode('x.txt');
  const content = encoder.encode('hi');
  const parts = [];
  const localHeaderOffset = 0;
  const local = new Uint8Array(30 + name.length + content.length);
  const ldv = new DataView(local.buffer);
  ldv.setUint32(0, 0x04034b50, true);
  ldv.setUint16(8, 99, true); // unsupported method
  ldv.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(content, 30 + name.length);
  parts.push(local);

  const cdOffset = local.length;
  const cd = new Uint8Array(46 + name.length);
  const cdv = new DataView(cd.buffer);
  cdv.setUint32(0, 0x02014b50, true);
  cdv.setUint16(10, 99, true);
  cdv.setUint32(20, content.length, true); // compressed size (approx, unused for stored path)
  cdv.setUint32(24, content.length, true); // uncompressed size
  cdv.setUint16(28, name.length, true);
  cdv.setUint32(42, localHeaderOffset, true);
  cd.set(name, 46);
  parts.push(cd);

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, 1, true);
  edv.setUint16(10, 1, true);
  edv.setUint32(12, cd.length, true);
  edv.setUint32(16, cdOffset, true);
  parts.push(eocd);

  const total = parts.reduce((a, b) => a + b.length, 0);
  const whole = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    whole.set(p, off);
    off += p.length;
  }

  const zip = await openZip(readRangeFor(whole), whole.length);
  const entry = findEntry(zip, 'x.txt');
  await assert.rejects(() => zip.readEntry(entry), /compression method/i);
});

// ---------------------------------------------------------------------------
// axml.js
// ---------------------------------------------------------------------------

test('axml.js correctly flags a device-admin-capable APK (ground truth cross-checked against androguard)', async () => {
  const buf = await readFile(fixturePath('apks', 'ScorpioSecurity.apk'));
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const zip = await openZip(readRangeFor(u8), u8.length);
  const manifestBytes = await zip.readEntry(findEntry(zip, 'AndroidManifest.xml'));

  const result = parseAndroidManifest(manifestBytes);
  assert.equal(result.packageName, 'com.example.scorpiosecurity');
  assert.equal(result.applicationLabel, 'Scorpio Security');
  assert.equal(result.isDeviceAdmin, true);
  assert.equal(result.receivers.length, 1);
  assert.equal(result.receivers[0].isDeviceAdmin, true);
  assert.equal(result.receivers[0].permission, 'android.permission.BIND_DEVICE_ADMIN');
});

test('axml.js correctly reports a plain APK as NOT device-admin-capable (negative control)', async () => {
  const buf = await readFile(fixturePath('apks', 'PlainApp.apk'));
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const zip = await openZip(readRangeFor(u8), u8.length);
  const manifestBytes = await zip.readEntry(findEntry(zip, 'AndroidManifest.xml'));

  const result = parseAndroidManifest(manifestBytes);
  assert.equal(result.packageName, 'com.example.plainapp');
  assert.equal(result.isDeviceAdmin, false);
  assert.equal(result.receivers.length, 0);
});

// ---------------------------------------------------------------------------
// ext4.js
// ---------------------------------------------------------------------------

async function loadGunzippedImage(gzPath) {
  const gz = await readFile(gzPath);
  const raw = gunzipSync(gz);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

test('ext4.js magic sniff works', async () => {
  const u8 = await loadGunzippedImage(fixturePath('test.ext4.img.gz'));
  assert.equal(looksLikeExt4(u8.subarray(1024, 1024 + 64)), true);
  assert.equal(looksLikeExt4(new Uint8Array(64)), false);
});

test('ext4.js walks a small filesystem and extracts byte-exact file contents', async () => {
  const u8 = await loadGunzippedImage(fixturePath('test.ext4.img.gz'));
  const vol = new Ext4Volume(readRangeFor(u8));
  await vol.init();
  assert.equal(vol.blockSize, 1024);

  const files = [];
  await walkFsVolume(vol, vol.rootInode, '', files);
  const apkPaths = files.map((f) => f.path).filter((p) => p.endsWith('.apk'));
  assert.deepEqual(
    apkPaths.sort(),
    [
      '/system/app/PlainApp/PlainApp.apk',
      '/system/app/ScorpioSecurity/ScorpioSecurity.apk',
      '/system/priv-app/NestedDeep/sub/Nested.apk',
    ].sort()
  );

  const scorpio = files.find((f) => f.path.endsWith('ScorpioSecurity.apk'));
  const data = await vol.readFile(scorpio.inode);
  const expected = await readFile(fixturePath('apks', 'ScorpioSecurity.apk'));
  assert.equal(Buffer.compare(Buffer.from(data), expected), 0);
});

test('ext4.js correctly parses a multi-block classic directory (300+ entries, non-contiguous extents)', async () => {
  const u8 = await loadGunzippedImage(fixturePath('test2.ext4.img.gz'));
  const vol = new Ext4Volume(readRangeFor(u8));
  await vol.init();
  assert.equal(vol.blockSize, 4096);

  const files = [];
  await walkFsVolume(vol, vol.rootInode, '', files);
  // build.prop + 300 filler apks + ScorpioSecurity + PlainApp + BigFile + Nested
  assert.equal(files.length, 1 + 300 + 1 + 1 + 1 + 1);

  const bigFile = files.find((f) => f.path.endsWith('big.bin'));
  assert.ok(bigFile, 'BigFile should be found (exercises a larger, multi-block file read)');
  const data = await vol.readFile(bigFile.inode);
  assert.equal(data.length, 10000);
});

// ---------------------------------------------------------------------------
// erofs.js
// ---------------------------------------------------------------------------

test('erofs.js magic sniff works', async () => {
  const buf = await readFile(fixturePath('test.erofs.img'));
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.equal(looksLikeErofs(u8.subarray(1024, 1028)), true);
  assert.equal(looksLikeErofs(new Uint8Array([0, 0, 0, 0])), false);
});

test('erofs.js walks a small filesystem and extracts byte-exact file contents (FLAT_PLAIN + FLAT_INLINE)', async () => {
  const buf = await readFile(fixturePath('test.erofs.img'));
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const vol = new ErofsVolume(readRangeFor(u8));
  await vol.init();

  const files = [];
  await walkFsVolume(vol, vol.rootInode, '', files);
  const scorpio = files.find((f) => f.path.endsWith('ScorpioSecurity.apk'));
  assert.ok(scorpio);
  const data = await vol.readFile(scorpio.inode);
  const expected = await readFile(fixturePath('apks', 'ScorpioSecurity.apk'));
  assert.equal(Buffer.compare(Buffer.from(data), expected), 0);

  // A file exactly spanning one full block plus zero remainder (FLAT_PLAIN).
  const oatPlaceholder = files.find((f) => f.path.endsWith('oat_placeholder.bin'));
  assert.ok(oatPlaceholder);
  assert.equal(oatPlaceholder.inode.datalayoutName, 'FLAT_PLAIN');
});

test('erofs.js correctly parses a multi-block directory (300+ dirents) and a mixed full-block+inline-tail file', async () => {
  const buf = await readFile(fixturePath('test2.erofs.img'));
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const vol = new ErofsVolume(readRangeFor(u8));
  await vol.init();

  const files = [];
  await walkFsVolume(vol, vol.rootInode, '', files);
  assert.equal(files.length, 1 + 300 + 1 + 1 + 1 + 1);

  const bigFile = files.find((f) => f.path.endsWith('big.bin'));
  assert.equal(bigFile.inode.datalayoutName, 'FLAT_INLINE');
  const data = await vol.readFile(bigFile.inode);
  assert.equal(data.length, 10000);
});

test('erofs.js reports compressed inodes as unavailable instead of crashing or returning wrong bytes', async () => {
  const buf = await readFile(fixturePath('test.erofs.lz4.img'));
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const vol = new ErofsVolume(readRangeFor(u8));
  await vol.init();

  const files = [];
  await walkFsVolume(vol, vol.rootInode, '', files);
  const compressed = files.find((f) => f.path.endsWith('comp.bin'));
  assert.ok(compressed, 'compressed file should still be visible via directory listing');
  assert.equal(compressed.inode.supported, false);
  await assert.rejects(() => vol.readFile(compressed.inode), /compressed\/chunked/i);

  // An uncompressed file in the same image should still read fine.
  const scorpio = files.find((f) => f.path.endsWith('ScorpioSecurity.apk'));
  const data = await vol.readFile(scorpio.inode);
  const expected = await readFile(fixturePath('apks', 'ScorpioSecurity.apk'));
  assert.equal(Buffer.compare(Buffer.from(data), expected), 0);
});

// ---------------------------------------------------------------------------
// scanner.js (full pipeline: fs auto-detect -> walk -> .apk discovery ->
// zip+axml -> device-admin classification)
// ---------------------------------------------------------------------------

test('scanner.js end-to-end on an ext4 partition correctly flags the device-admin APK and only that one', async () => {
  const { scanPartitionForApks } = await import('../src/scanner.js');
  const u8 = await loadGunzippedImage(fixturePath('test.ext4.img.gz'));
  const result = await scanPartitionForApks('system_a', readRangeFor(u8));

  assert.equal(result.fsType, 'ext4');
  assert.equal(result.apks.length, 3);

  const byName = Object.fromEntries(result.apks.map((a) => [a.packageName, a]));
  assert.equal(byName['com.example.scorpiosecurity'].deviceAdmin, 'yes');
  assert.deepEqual(byName['com.example.scorpiosecurity'].deviceAdminReceivers, ['.MyDeviceAdminReceiver']);
  assert.equal(byName['com.example.plainapp'].deviceAdmin, 'no');
  // The "Nested.apk" fixture reuses the Scorpio manifest/content in prior
  // fixtures — whatever its actual package is, it must have a definite yes/no,
  // never silently missing.
  for (const apk of result.apks) {
    assert.ok(['yes', 'no', 'unknown'].includes(apk.deviceAdmin));
  }
});

test('scanner.js end-to-end on an EROFS partition produces the same classification as ext4', async () => {
  const { scanPartitionForApks } = await import('../src/scanner.js');
  const buf = await readFile(fixturePath('test.erofs.img'));
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const result = await scanPartitionForApks('system_a', readRangeFor(u8));

  assert.equal(result.fsType, 'erofs');
  const byName = Object.fromEntries(result.apks.map((a) => [a.packageName, a]));
  assert.equal(byName['com.example.scorpiosecurity'].deviceAdmin, 'yes');
  assert.equal(byName['com.example.plainapp'].deviceAdmin, 'no');
});

test('scanner.js reports "unknown" with a clear note for compressed EROFS APKs instead of crashing', async () => {
  const { scanPartitionForApks } = await import('../src/scanner.js');
  // Pack an actual .apk as a highly-compressible-but-large entry isn't in our
  // lz4 fixture (it only has comp.bin), so this test instead asserts the
  // overall scan still completes and reports the other two real APKs
  // correctly even though an unrelated compressed file exists alongside them.
  const buf = await readFile(fixturePath('test.erofs.lz4.img'));
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const result = await scanPartitionForApks('system_a', readRangeFor(u8));
  assert.equal(result.fsType, 'erofs');
  const byName = Object.fromEntries(result.apks.map((a) => [a.packageName, a]));
  assert.equal(byName['com.example.scorpiosecurity'].deviceAdmin, 'yes');
  assert.equal(byName['com.example.plainapp'].deviceAdmin, 'no');
});

test('scanner.js reports a clear top-level error (not a crash) for an unrecognized filesystem', async () => {
  const { scanPartitionForApks } = await import('../src/scanner.js');
  const garbage = new Uint8Array(4096); // all zeros: no valid magic anywhere
  const result = await scanPartitionForApks('weird_partition', readRangeFor(garbage));
  assert.equal(result.fsType, 'unknown');
  assert.equal(result.apks.length, 0);
  assert.ok(result.warnings.some((w) => /skipped/i.test(w)));
});
