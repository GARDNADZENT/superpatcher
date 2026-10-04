import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ext4Volume } from '../src/ext4.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = (...parts) => path.join(__dirname, 'fixtures', ...parts);

async function loadGunzippedImage(gzPath) {
  const gz = await readFile(gzPath);
  const raw = gunzipSync(gz);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

// A simple mutable-in-memory "partition": readRange/writeRange both operate
// directly on one backing Uint8Array, same contract makePartitionReader /
// makePartitionWriter present to real code (offsets relative to partition
// start, writeRange(offset, bytes) applies immediately).
function mutablePartition(u8) {
  return {
    bytes: u8,
    readRange: async (offset, length) => u8.subarray(offset, offset + length),
    writeRange: (offset, bytes) => {
      u8.set(bytes, offset);
    },
  };
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

async function resolvePath(vol, p) {
  const parts = p.split('/').filter(Boolean);
  let inode = vol.rootInode;
  for (const part of parts) {
    const entries = await vol.listDir(inode);
    const e = entries.find((x) => x.name === part);
    assert.ok(e, `path component "${part}" not found while resolving "${p}"`);
    inode = await vol.readInode(e.inodeNumber);
  }
  return inode;
}

// e2fsck is our independent oracle: if it's not installed in this
// environment, skip the oracle assertion rather than failing the whole
// suite (the in-process assertions below still give strong coverage).
function findE2fsck() {
  for (const candidate of ['/usr/sbin/e2fsck', '/sbin/e2fsck', 'e2fsck']) {
    try {
      execFileSync(candidate, ['-V'], { stdio: 'pipe' });
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function runE2fsckOracle(u8, t) {
  const e2fsck = findE2fsck();
  if (!e2fsck) {
    t.diagnostic('e2fsck not found on this system; skipping external fsck oracle check.');
    return null;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'ext4-write-test-'));
  const imgPath = path.join(dir, 'patched.img');
  await writeFile(imgPath, Buffer.from(u8));
  let output = '';
  try {
    execFileSync(e2fsck, ['-fn', imgPath], { stdio: 'pipe' });
  } catch (err) {
    // e2fsck exits non-zero whenever it finds *anything* to report, even
    // accepted/expected leftovers (see below), so a non-zero exit alone
    // isn't a failure — inspect the output instead.
    output = (err.stdout || '').toString() + (err.stderr || '').toString();
  }
  await rm(dir, { recursive: true, force: true });
  return output;
}

// Lines we *expect* and accept from e2fsck after a removal: the deliberate,
// documented trade-off of never freeing the removed inode/blocks or
// touching allocation bitmaps (see Ext4Volume.removeDirEntry doc comment).
// Anything else appearing in e2fsck's output (in particular, any mention of
// a checksum mismatch, or an unexpected "should be" on a *live* inode)
// indicates a real bug and must fail the test.
const ACCEPTED_PATTERNS = [
  /^e2fsck \d/,
  /^Pass \d:/,
  /^Unconnected directory inode/,
  /^Connect to \/lost\+found\?/,
  /^'\.\.' in .* should be <The NULL inode>/,
  /^Fix\?/,
  /^Unattached inode/,
  /^Block bitmap differences:/,
  /^Inode bitmap differences:/,
  /^Directories count wrong for group/,
  /^\S+\.img: \*+ WARNING: Filesystem still has errors \*+$/,
  /^\S+\.img: \d+\/\d+ files/,
  /^$/,
];

function assertOnlyAcceptedFsckFindings(output, t) {
  if (output === null) return; // oracle unavailable
  const suspicious = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (ACCEPTED_PATTERNS.some((re) => re.test(trimmed))) continue;
    suspicious.push(trimmed);
  }
  if (suspicious.length) {
    t.diagnostic(`Full e2fsck output:\n${output}`);
  }
  assert.deepEqual(suspicious, [], 'e2fsck reported findings beyond the accepted orphan/bitmap leftovers');
  assert.ok(!/checksum/i.test(output), 'e2fsck reported a checksum problem — this is a real bug');
}

test('ext4.js removeDirEntry deletes the device-admin app folder and survives e2fsck -fn (small image)', async (t) => {
  const u8 = await loadGunzippedImage(fixturePath('test.ext4.img.gz'));
  const part = mutablePartition(u8);
  const vol = new Ext4Volume(part.readRange, part.writeRange);
  await vol.init();

  const before = [];
  await walkFsVolume(vol, vol.rootInode, '', before);
  assert.ok(before.some((f) => f.path.endsWith('ScorpioSecurity.apk')));

  const appDir = await resolvePath(vol, '/system/app');
  const appDirLinksBefore = (await vol.readInode(appDir.inodeNumber)).linksCount;

  const removed = await vol.removeDirEntry(appDir, 'ScorpioSecurity');
  assert.equal(removed, true);

  const notFound = await vol.removeDirEntry(appDir, 'ScorpioSecurity');
  assert.equal(notFound, false, 'removing an already-removed entry should report not-found, not throw/corrupt');

  const appDirAfter = await vol.readInode(appDir.inodeNumber);
  assert.equal(appDirAfter.linksCount, appDirLinksBefore - 1, 'parent link count should drop by 1 (child was a directory)');

  const after = [];
  await walkFsVolume(vol, vol.rootInode, '', after);
  const afterPaths = after.map((f) => f.path);
  assert.ok(!afterPaths.some((p) => p.includes('ScorpioSecurity')), 'ScorpioSecurity should be completely gone from a fresh walk');
  assert.ok(afterPaths.some((p) => p.endsWith('PlainApp.apk')), 'sibling PlainApp should be untouched');
  assert.ok(afterPaths.some((p) => p.endsWith('Nested.apk')), 'unrelated nested app should be untouched');

  // Sibling's own file content must be byte-identical (no collateral damage
  // to neighboring directory entries/data from the rec_len merge).
  const plainApp = after.find((f) => f.path.endsWith('PlainApp.apk'));
  const data = await vol.readFile(plainApp.inode);
  const expected = await readFile(fixturePath('apks', 'PlainApp.apk'));
  assert.equal(Buffer.compare(Buffer.from(data), expected), 0);

  const fsckOutput = await runE2fsckOracle(u8, t);
  assertOnlyAcceptedFsckFindings(fsckOutput, t);
});

test('ext4.js removeDirEntry handles two sequential removals from the same directory block', async (t) => {
  const u8 = await loadGunzippedImage(fixturePath('test.ext4.img.gz'));
  const part = mutablePartition(u8);
  const vol = new Ext4Volume(part.readRange, part.writeRange);
  await vol.init();

  const appDir = await resolvePath(vol, '/system/app');
  const remainingBefore = (await vol.listDir(appDir)).map((e) => e.name).sort();
  assert.equal(await vol.removeDirEntry(appDir, 'ScorpioSecurity'), true);
  assert.equal(await vol.removeDirEntry(appDir, 'PlainApp'), true);

  const remaining = (await vol.listDir(appDir)).map((e) => e.name).sort();
  assert.deepEqual(remaining, remainingBefore.filter((n) => n !== 'ScorpioSecurity' && n !== 'PlainApp'));

  const fsckOutput = await runE2fsckOracle(u8, t);
  assertOnlyAcceptedFsckFindings(fsckOutput, t);
});

test('ext4.js removeDirEntry works across a multi-block, non-contiguous-extent directory', async (t) => {
  const u8 = await loadGunzippedImage(fixturePath('test2.ext4.img.gz'));
  const part = mutablePartition(u8);
  const vol = new Ext4Volume(part.readRange, part.writeRange);
  await vol.init();

  const before = [];
  await walkFsVolume(vol, vol.rootInode, '', before);
  const scorpioBefore = before.find((f) => f.path.endsWith('ScorpioSecurity.apk'));
  assert.ok(scorpioBefore);
  const parentDirPath = scorpioBefore.path.split('/').slice(0, -2).join('/'); // .../ScorpioSecurity/ScorpioSecurity.apk -> parent of ScorpioSecurity
  const parentDir = await resolvePath(vol, parentDirPath);

  assert.equal(await vol.removeDirEntry(parentDir, 'ScorpioSecurity'), true);

  const after = [];
  await walkFsVolume(vol, vol.rootInode, '', after);
  assert.equal(after.length, before.length - 1);
  assert.ok(!after.some((f) => f.path.includes('ScorpioSecurity')));

  const fsckOutput = await runE2fsckOracle(u8, t);
  assertOnlyAcceptedFsckFindings(fsckOutput, t);
});

test('ext4.js removeDirEntry refuses to operate on a read-only-opened volume', async () => {
  const u8 = await loadGunzippedImage(fixturePath('test.ext4.img.gz'));
  const vol = new Ext4Volume(async (offset, length) => u8.subarray(offset, offset + length));
  await vol.init();
  const appDir = await resolvePath(vol, '/system/app');
  await assert.rejects(() => vol.removeDirEntry(appDir, 'ScorpioSecurity'), /read-only/);
});
