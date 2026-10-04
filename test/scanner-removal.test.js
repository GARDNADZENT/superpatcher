import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanPartitionForApks } from '../src/scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = (...parts) => path.join(__dirname, 'fixtures', ...parts);

async function loadGunzippedImage(gzPath) {
  const gz = await readFile(gzPath);
  const raw = gunzipSync(gz);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function mutablePartition(u8) {
  return {
    readRange: async (offset, length) => u8.subarray(offset, offset + length),
    writeRange: (offset, bytes) => {
      u8.set(bytes, offset);
    },
  };
}

function findBinary(names) {
  for (const candidate of names) {
    try {
      execFileSync(candidate, ['-V'], { stdio: 'pipe' });
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function runE2fsckOracle(u8) {
  const e2fsck = findBinary(['/usr/sbin/e2fsck', '/sbin/e2fsck', 'e2fsck']);
  if (!e2fsck) return null;
  const dir = await mkdtemp(path.join(tmpdir(), 'scanner-removal-test-'));
  const imgPath = path.join(dir, 'patched.img');
  await writeFile(imgPath, Buffer.from(u8));
  let output = '';
  try {
    execFileSync(e2fsck, ['-fn', imgPath], { stdio: 'pipe' });
  } catch (err) {
    output = (err.stdout || '').toString() + (err.stderr || '').toString();
  }
  await rm(dir, { recursive: true, force: true });
  return output;
}

test('scanner.js computes the correct removalUnit for a dedicated per-app folder', async () => {
  const u8 = await loadGunzippedImage(fixturePath('test.ext4.img.gz'));
  const part = mutablePartition(u8);
  const result = await scanPartitionForApks('system_a', part.readRange, part.writeRange);

  const scorpio = result.apks.find((a) => a.packageName === 'com.example.scorpiosecurity');
  assert.ok(scorpio);
  assert.equal(scorpio.removalUnit.kind, 'folder');
  assert.equal(scorpio.removalUnit.entryName, 'ScorpioSecurity');
  assert.ok(scorpio.removalUnit.parentInode, 'parentInode should be a live inode object');

  // Device-admin app's name should also trip the (separate, looser)
  // security-plugin naming heuristic.
  assert.equal(scorpio.looksLikeSecurityPlugin, true);

  const plain = result.apks.find((a) => a.packageName === 'com.example.plainapp');
  assert.equal(plain.looksLikeSecurityPlugin, false);

  // Passing a writeRange should attach a live, removal-capable volume.
  assert.ok(result.volume, 'volume should be attached when writeRange is supplied');
});

test('scanner.js falls back to file-level removal for a loose .apk with no dedicated folder', async () => {
  const u8 = await loadGunzippedImage(fixturePath('test-loose-apk.ext4.img.gz'));
  const part = mutablePartition(u8);
  const result = await scanPartitionForApks('system_a', part.readRange, part.writeRange);

  const loose = result.apks.find((a) => a.path.endsWith('LooseApp.apk'));
  assert.ok(loose, 'LooseApp.apk should be found');
  assert.equal(loose.removalUnit.kind, 'file');
  assert.equal(loose.removalUnit.entryName, 'LooseApp.apk');

  const nested = result.apks.find((a) => a.path.endsWith('FolderApp.apk'));
  assert.ok(nested, 'FolderApp.apk should be found');
  assert.equal(nested.removalUnit.kind, 'folder');
  assert.equal(nested.removalUnit.entryName, 'FolderApp');
});

test('end-to-end: scan -> remove flagged app via its removalUnit -> gone on rescan -> e2fsck clean', async (t) => {
  const u8 = await loadGunzippedImage(fixturePath('test.ext4.img.gz'));
  const part = mutablePartition(u8);
  const result = await scanPartitionForApks('system_a', part.readRange, part.writeRange);

  const scorpio = result.apks.find((a) => a.packageName === 'com.example.scorpiosecurity');
  assert.ok(scorpio);
  assert.equal(scorpio.deviceAdmin, 'yes');

  const { parentInode, entryName } = scorpio.removalUnit;
  const removed = await result.volume.removeDirEntry(parentInode, entryName);
  assert.equal(removed, true);

  // Fresh independent re-scan of the now-patched bytes confirms it's gone.
  // (Note: the fixture's unrelated "Nested.apk" deliberately reuses the same
  // manifest/package name as ScorpioSecurity, so the removed *path* — not
  // packageName — is the correct thing to assert is gone.)
  const rescan = await scanPartitionForApks('system_a', part.readRange);
  assert.ok(!rescan.apks.some((a) => a.path === scorpio.path), 'the removed APK\'s exact path must be gone');
  assert.ok(rescan.apks.some((a) => a.packageName === 'com.example.plainapp'), 'sibling app unaffected');

  const fsckOutput = await runE2fsckOracle(u8);
  if (fsckOutput !== null) {
    t.diagnostic(fsckOutput);
    assert.ok(!/checksum/i.test(fsckOutput), 'e2fsck must not report any checksum problem');
  }
});
