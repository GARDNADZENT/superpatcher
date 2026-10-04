// Covers the "Remove Device Lock Components" feature at two levels:
//  1. The shared src/device-lock-removal.js module directly (unit-level).
//  2. The actual CLI script (scripts/remove-device-lock-components.mjs),
//     spawned as a real subprocess, against the real
//     sample-data/super_devicelock_demo.img fixture — so the test exercises
//     exactly what a user running the documented command would see,
//     including the modification-report.json it writes and the
//     human-readable "BUILD SUCCESSFUL" summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { indexSparseOrRaw } from '../src/sparse.js';
import { VirtualDisk } from '../src/virtual-disk.js';
import { readGeometry, readMetadata, partitionSizeBytes } from '../src/lp.js';
import { makePartitionReader } from '../src/extractor.js';
import { ErofsVolume } from '../src/erofs.js';
import {
  DEVICE_LOCK_TARGETS,
  removeDeviceLockComponents,
  resolveExactFile,
  listAllFilePaths,
  DeviceLockRemovalError,
} from '../src/device-lock-removal.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const fixturePath = (...parts) => path.join(__dirname, 'fixtures', ...parts);
const cliPath = path.join(repoRoot, 'scripts', 'remove-device-lock-components.mjs');
const demoImagePath = path.join(repoRoot, 'sample-data', 'super_devicelock_demo.img');

async function loadDisk(filePath) {
  const buf = await readFile(filePath);
  const file = new Blob([buf]);
  const index = await indexSparseOrRaw(file);
  const disk = new VirtualDisk([{ file, index }]);
  const geo = await readGeometry(disk);
  const meta = await readMetadata(disk, geo, 0);
  return { disk, geo, meta };
}

async function sha256OfFile(filePath) {
  const buf = await readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------- unit-level: src/device-lock-removal.js ----------------

test('device-lock-removal module: happy path removes exactly the 3 targets and nothing else', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'devicelock-unit-'));
  try {
    const copyPath = path.join(dir, 'super.img');
    await copyFile(demoImagePath, copyPath);
    const { disk, meta } = await loadDisk(copyPath);

    const originalFilesByPartition = {};
    for (const name of ['product_a', 'system_ext_a']) {
      const partition = meta.partitions.find((p) => p.name === name);
      const readRange = makePartitionReader(disk, meta, partition);
      const volume = new ErofsVolume(readRange);
      await volume.init();
      originalFilesByPartition[name] = await listAllFilePaths(volume);
    }

    const result = await removeDeviceLockComponents(disk, meta);
    assert.deepEqual(
      result.removed.map((t) => t.package).sort(),
      DEVICE_LOCK_TARGETS.map((t) => t.package).sort()
    );
    assert.deepEqual(result.partitionsModified.sort(), ['product_a', 'system_ext_a']);

    for (const name of ['product_a', 'system_ext_a']) {
      const volume = result.volumesByPartition[name];
      for (const target of DEVICE_LOCK_TARGETS.filter((t) => t.partition === name)) {
        assert.equal(await resolveExactFile(volume, target.path), null, `${target.path} should be gone`);
      }
      const afterFiles = new Set(await listAllFilePaths(volume));
      const removedHere = new Set(DEVICE_LOCK_TARGETS.filter((t) => t.partition === name).map((t) => t.path));
      const beforeFiles = originalFilesByPartition[name];
      for (const f of beforeFiles) {
        if (removedHere.has(f)) assert.ok(!afterFiles.has(f), `${f} should have been removed`);
        else assert.ok(afterFiles.has(f), `${f} should have been preserved`);
      }
      assert.equal(afterFiles.size, beforeFiles.length - removedHere.size, 'no extra/missing files beyond the targets');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('device-lock-removal module: STOPs with no changes if a required partition is absent', async () => {
  // sample-data/super_demo.img (the older, unrelated demo fixture) only has
  // system_a/product_a -- no system_ext_a at all.
  const { disk, meta } = await loadDisk(path.join(repoRoot, 'sample-data', 'super_demo.img'));
  await assert.rejects(() => removeDeviceLockComponents(disk, meta), DeviceLockRemovalError);
});

test('device-lock-removal module: STOPs and reports exactly which targets are missing, without partial removal', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'devicelock-unit-partial-'));
  try {
    const { buildSuperImage } = await import('./lp-test-helpers.mjs');
    const { gunzipSync } = await import('node:zlib');
    const ext4 = new Uint8Array(gunzipSync(await readFile(fixturePath('test2.ext4.img.gz'))));
    const productA = new Uint8Array(await readFile(fixturePath('devicelock-product_a.erofs.img'))); // HAS SecurityCom
    const systemExtA = new Uint8Array(await readFile(fixturePath('test2.erofs.img'))); // missing both Tran* targets
    const img = await buildSuperImage([
      { name: 'system_a', bytes: ext4 },
      { name: 'product_a', bytes: productA },
      { name: 'system_ext_a', bytes: systemExtA },
    ]);
    const imgPath = path.join(dir, 'super.img');
    await writeFile(imgPath, img);

    const { disk, meta } = await loadDisk(imgPath);
    let caught;
    try {
      await removeDeviceLockComponents(disk, meta);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof DeviceLockRemovalError);
    assert.equal(caught.details.missing.length, 2);
    assert.deepEqual(
      caught.details.missing.map((t) => t.package).sort(),
      ['com.transsion.spl', 'com.transsion.spld']
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------- CLI-level: scripts/remove-device-lock-components.mjs ----------------

test('CLI: BUILD SUCCESSFUL end-to-end against the real demo super.img, with a valid report', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'devicelock-cli-'));
  try {
    const sourcePath = path.join(dir, 'super.img');
    await copyFile(demoImagePath, sourcePath);
    const originalShaBefore = await sha256OfFile(sourcePath);

    const { stdout } = await execFileAsync('node', [cliPath, sourcePath]);
    t.diagnostic(stdout);
    assert.match(stdout, /BUILD SUCCESSFUL/);
    assert.match(stdout, /com\.scorpio\.securitycom/);
    assert.match(stdout, /com\.transsion\.spl\b/);
    assert.match(stdout, /com\.transsion\.spld/);
    assert.match(stdout, /product_a/);
    assert.match(stdout, /system_ext_a/);
    assert.match(stdout, /super_MODIFIED\.img/);
    assert.match(stdout, /UNCHANGED/);

    // Source must be byte-for-byte untouched.
    const originalShaAfter = await sha256OfFile(sourcePath);
    assert.equal(originalShaAfter, originalShaBefore);

    const outputPath = path.join(dir, 'super_MODIFIED.img');
    const reportPath = path.join(dir, 'modification-report.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));

    assert.equal(report.sourceImage, sourcePath);
    assert.equal(report.outputImage, outputPath);
    assert.ok(Date.parse(report.timestamp) > 0);
    assert.equal(report.originalSha256, originalShaBefore);
    assert.equal(report.modifiedSha256, await sha256OfFile(outputPath));
    assert.notEqual(report.originalSha256, report.modifiedSha256);
    assert.deepEqual(report.partitionsModified.sort(), ['product_a', 'system_ext_a']);
    assert.deepEqual(
      report.removed.sort((a, b) => a.package.localeCompare(b.package)),
      [...DEVICE_LOCK_TARGETS].sort((a, b) => a.package.localeCompare(b.package))
    );
    assert.deepEqual(report.originalPartitionSizes, report.rebuiltPartitionSizes, 'sizes must be unchanged (no resize)');
    assert.equal(report.validation.overall, 'PASS');
    assert.equal(report.validation.targetFilesRemoved, true);
    assert.equal(report.validation.noUnintendedFileChanges, true);
    assert.deepEqual(report.validation.unintendedChanges, []);
    assert.equal(report.validation.noExtentOverlap, true);

    // Independently re-verify with the project's own reader (belt and
    // braces beyond what the script's own validation already asserted).
    const { meta: modifiedMeta } = await loadDisk(outputPath);
    const modifiedNames = modifiedMeta.partitions.map((p) => p.name).sort();
    assert.deepEqual(modifiedNames, ['product_a', 'system_a', 'system_ext_a']);

    const { disk: modifiedDisk } = await loadDisk(outputPath);
    for (const target of DEVICE_LOCK_TARGETS) {
      const partition = modifiedMeta.partitions.find((p) => p.name === target.partition);
      const readRange = makePartitionReader(modifiedDisk, modifiedMeta, partition);
      const volume = new ErofsVolume(readRange);
      await volume.init();
      assert.equal(await resolveExactFile(volume, target.path), null);
    }

    // system_a (untouched partition) must come out byte-identical.
    const origPartition = (await loadDisk(sourcePath)).meta.partitions.find((p) => p.name === 'system_a');
    const origReadRange = makePartitionReader((await loadDisk(sourcePath)).disk, (await loadDisk(sourcePath)).meta, origPartition);
    const sizeA = Number(partitionSizeBytes(modifiedMeta, modifiedMeta.partitions.find((p) => p.name === 'system_a')));
    const beforeBytes = await origReadRange(0, sizeA);
    const afterPartition = modifiedMeta.partitions.find((p) => p.name === 'system_a');
    const afterReadRange = makePartitionReader(modifiedDisk, modifiedMeta, afterPartition);
    const afterBytes = await afterReadRange(0, sizeA);
    assert.deepEqual(Buffer.from(beforeBytes), Buffer.from(afterBytes));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI: STOPs with no output files when a target partition is missing', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'devicelock-cli-missing-part-'));
  try {
    const sourcePath = path.join(dir, 'super.img');
    await copyFile(path.join(repoRoot, 'sample-data', 'super_demo.img'), sourcePath);

    await assert.rejects(() => execFileAsync('node', [cliPath, sourcePath]));
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    assert.deepEqual(files.sort(), ['super.img'], 'no output image or report should be written on STOP');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI: prints a clear, usable error with no args', async () => {
  await assert.rejects(() => execFileAsync('node', [cliPath]));
});
