import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ErofsVolume } from '../src/erofs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = (...parts) => path.join(__dirname, 'fixtures', ...parts);

function mutablePartition(u8) {
  return {
    readRange: async (offset, length) => u8.subarray(offset, offset + length),
    writeRange: (offset, bytes) => {
      u8.set(bytes, offset);
    },
  };
}

async function loadImage(p) {
  const buf = await readFile(p);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function walkFsVolume(vol, inode, pathSoFar, out) {
  const entries = await vol.listDir(inode);
  for (const e of entries) {
    const childInode = await vol.readInode(e.nid);
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
    inode = await vol.readInode(e.nid);
  }
  return inode;
}

function findFsckErofs() {
  for (const candidate of ['/usr/bin/fsck.erofs', '/usr/sbin/fsck.erofs', 'fsck.erofs']) {
    try {
      execFileSync(candidate, ['-V'], { stdio: 'pipe' });
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

// fsck.erofs is our independent oracle, same role e2fsck plays for the
// ext4 write tests: a real, external implementation of the on-disk format
// that we don't control, so it can catch mistakes our own reader might not
// notice (since our reader and writer share assumptions).
async function runFsckOracle(u8, t) {
  const fsck = findFsckErofs();
  if (!fsck) {
    t.diagnostic('fsck.erofs not found on this system; skipping external fsck oracle check.');
    return null;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'erofs-write-test-'));
  const imgPath = path.join(dir, 'patched.img');
  await writeFile(imgPath, Buffer.from(u8));
  let output = '';
  let exitCode = 0;
  try {
    output = execFileSync(fsck, [imgPath], { stdio: 'pipe' }).toString();
  } catch (err) {
    exitCode = err.status ?? 1;
    output = (err.stdout || '').toString() + (err.stderr || '').toString();
  }
  await rm(dir, { recursive: true, force: true });
  return { output, exitCode };
}

function assertFsckClean(result) {
  if (result === null) return; // oracle unavailable
  assert.equal(result.exitCode, 0, `fsck.erofs exited non-zero:\n${result.output}`);
  assert.ok(!/invalid checksum|corrupt|error/i.test(result.output), `fsck.erofs reported a problem:\n${result.output}`);
}

test('erofs.js removeDirEntry deletes the device-admin app folder and passes fsck.erofs (small image)', async (t) => {
  const u8 = await loadImage(fixturePath('test.erofs.img'));
  const part = mutablePartition(u8);
  const vol = new ErofsVolume(part.readRange, part.writeRange);
  await vol.init();

  const before = [];
  await walkFsVolume(vol, vol.rootInode, '', before);
  assert.ok(before.some((f) => f.path.endsWith('ScorpioSecurity.apk')));

  const appDir = await resolvePath(vol, '/system/app');
  const appDirNlinkBefore = (await vol.readInode(appDir.nid)).nlink;

  const removed = await vol.removeDirEntry(appDir, 'ScorpioSecurity');
  assert.equal(removed, true);

  const notFound = await vol.removeDirEntry(appDir, 'ScorpioSecurity');
  assert.equal(notFound, false, 'removing an already-removed entry should report not-found, not throw/corrupt');

  const appDirAfter = await vol.readInode(appDir.nid);
  assert.equal(appDirAfter.nlink, appDirNlinkBefore - 1, 'parent nlink should drop by 1 (child was a directory)');

  const after = [];
  await walkFsVolume(vol, vol.rootInode, '', after);
  const afterPaths = after.map((f) => f.path);
  assert.ok(!afterPaths.some((p) => p.includes('ScorpioSecurity')), 'ScorpioSecurity should be completely gone from a fresh walk');
  assert.ok(afterPaths.some((p) => p.endsWith('PlainApp.apk')), 'sibling PlainApp should be untouched');

  const plainApp = after.find((f) => f.path.endsWith('PlainApp.apk'));
  const data = await vol.readFile(plainApp.inode);
  const expected = await readFile(fixturePath('apks', 'PlainApp.apk'));
  assert.equal(Buffer.compare(Buffer.from(data), expected), 0);

  assertFsckClean(await runFsckOracle(u8, t));
});

test('erofs.js removeDirEntry works across a multi-block (300+ entry) directory', async (t) => {
  const u8 = await loadImage(fixturePath('test2.erofs.img'));
  const part = mutablePartition(u8);
  const vol = new ErofsVolume(part.readRange, part.writeRange);
  await vol.init();

  const before = [];
  await walkFsVolume(vol, vol.rootInode, '', before);
  const scorpioBefore = before.find((f) => f.path.endsWith('ScorpioSecurity.apk'));
  assert.ok(scorpioBefore);
  const parentDirPath = scorpioBefore.path.split('/').slice(0, -2).join('/');
  const parentDir = await resolvePath(vol, parentDirPath);

  assert.equal(await vol.removeDirEntry(parentDir, 'ScorpioSecurity'), true);

  const after = [];
  await walkFsVolume(vol, vol.rootInode, '', after);
  assert.equal(after.length, before.length - 1);
  assert.ok(!after.some((f) => f.path.includes('ScorpioSecurity')));

  // A distant filler app's content must still be byte-exact (no collateral
  // damage from the directory-block repacking).
  const filler1 = after.find((f) => f.path.endsWith('/FillerApp1/FillerApp1.apk'));
  assert.ok(filler1);
  await vol.readFile(filler1.inode); // must not throw

  assertFsckClean(await runFsckOracle(u8, t));
});

test('erofs.js removeDirEntry handles two sequential removals from the same directory', async (t) => {
  const u8 = await loadImage(fixturePath('test.erofs.img'));
  const part = mutablePartition(u8);
  const vol = new ErofsVolume(part.readRange, part.writeRange);
  await vol.init();

  const appDir = await resolvePath(vol, '/system/app');
  const remainingBefore = (await vol.listDir(appDir)).map((e) => e.name).sort();

  assert.equal(await vol.removeDirEntry(appDir, 'ScorpioSecurity'), true);
  assert.equal(await vol.removeDirEntry(appDir, 'PlainApp'), true);

  const remaining = (await vol.listDir(appDir)).map((e) => e.name).sort();
  assert.deepEqual(remaining, remainingBefore.filter((n) => n !== 'ScorpioSecurity' && n !== 'PlainApp'));

  assertFsckClean(await runFsckOracle(u8, t));
});

test('erofs.js removeDirEntry refuses to operate on a read-only-opened volume', async () => {
  const u8 = await loadImage(fixturePath('test.erofs.img'));
  const vol = new ErofsVolume(async (offset, length) => u8.subarray(offset, offset + length));
  await vol.init();
  const appDir = await resolvePath(vol, '/system/app');
  await assert.rejects(() => vol.removeDirEntry(appDir, 'ScorpioSecurity'), /read-only/);
});
