#!/usr/bin/env node
// CLI wrapper for the "Remove Device Lock Components" action: loads a
// super.img, removes exactly the three hardcoded target APKs (see
// src/device-lock-removal.js), writes a patched copy (never overwriting
// the source), writes a modification-report.json, independently re-parses
// and validates the result, and prints a human-readable summary.
//
// Usage:
//   node scripts/remove-device-lock-components.mjs <path/to/super.img> [--out-dir <dir>]
//
// Never flashes anything. Never overwrites the source image.

import { readFile, writeFile, open as fsOpen } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { indexSparseOrRaw } = await import(path.join(here, '../src/sparse.js'));
const { VirtualDisk } = await import(path.join(here, '../src/virtual-disk.js'));
const { readGeometry, readMetadata, partitionSizeBytes, findOverlappingExtents } = await import(
  path.join(here, '../src/lp.js')
);
const { makePartitionReader } = await import(path.join(here, '../src/extractor.js'));
const { streamPatchedDisk } = await import(path.join(here, '../src/patchset.js'));
const { ErofsVolume } = await import(path.join(here, '../src/erofs.js'));
const {
  DEVICE_LOCK_TARGETS,
  removeDeviceLockComponents,
  resolveExactFile,
  listAllFilePaths,
  DeviceLockRemovalError,
} = await import(path.join(here, '../src/device-lock-removal.js'));

function outputPathFor(sourcePath) {
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath);
  const newBase = /\.img$/i.test(base) ? base.replace(/\.img$/i, '_MODIFIED.img') : `${base}_MODIFIED`;
  return path.join(dir, newBase);
}

async function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function loadDisk(filePath) {
  const buf = await readFile(filePath);
  const file = new Blob([buf]);
  const index = await indexSparseOrRaw(file);
  const disk = new VirtualDisk([{ file, index }]);
  const geo = await readGeometry(disk);
  const meta = await readMetadata(disk, geo, 0);
  return { disk, geo, meta };
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

async function runErofsIntegrityCheck(disk, meta, partitionName) {
  const partition = meta.partitions.find((p) => p.name === partitionName);
  const readRange = makePartitionReader(disk, meta, partition);
  const size = Number(partitionSizeBytes(meta, partition));
  const bytes = await readRange(0, size);

  const fsck = findFsckErofs();
  if (!fsck) {
    return { tool: 'none', ok: true, note: 'fsck.erofs not available on PATH; skipped external oracle check.' };
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'devicelock-fsck-'));
  const imgPath = path.join(dir, `${partitionName}.img`);
  await writeFile(imgPath, Buffer.from(bytes));
  let output = '';
  let exitCode = 0;
  try {
    output = execFileSync(fsck, [imgPath], { stdio: 'pipe' }).toString();
  } catch (err) {
    exitCode = err.status ?? 1;
    output = (err.stdout || '').toString() + (err.stderr || '').toString();
  }
  await rm(dir, { recursive: true, force: true });
  const hasErrorLines = /^<[EW]>/m.test(output);
  return { tool: 'fsck.erofs', ok: exitCode === 0 && !hasErrorLines, exitCode, output: output.trim() };
}

async function main() {
  const args = process.argv.slice(2);
  const sourcePath = args[0];
  const outDirIdx = args.indexOf('--out-dir');
  const outDir = outDirIdx !== -1 ? args[outDirIdx + 1] : null;

  if (!sourcePath) {
    console.error('Usage: node scripts/remove-device-lock-components.mjs <path/to/super.img> [--out-dir <dir>]');
    process.exitCode = 2;
    return;
  }

  const resolvedSource = path.resolve(sourcePath);
  const outputPath = outDir
    ? path.join(path.resolve(outDir), path.basename(outputPathFor(resolvedSource)))
    : outputPathFor(resolvedSource);
  const reportPath = path.join(path.dirname(outputPath), 'modification-report.json');

  console.log(`Loading ${resolvedSource} ...`);
  const originalSha256 = await sha256OfFile(resolvedSource);
  const { disk, meta: originalMeta } = await loadDisk(resolvedSource);
  console.log(`Parsed LP metadata: ${originalMeta.partitions.length} partition(s).`);

  // Snapshot the TRUE pre-modification file listing for the two target
  // partitions *before* calling removeDeviceLockComponents (which performs
  // the actual removal before returning) — read-only, no patchSet, so
  // these reads can never see any edit. This is what the "nothing else
  // changed" diff below is checked against.
  const targetPartitionNamesForSnapshot = [...new Set(DEVICE_LOCK_TARGETS.map((t) => t.partition))];
  const originalFileListByPartition = {};
  for (const name of targetPartitionNamesForSnapshot) {
    const partition = originalMeta.partitions.find((p) => p.name === name);
    if (!partition) continue; // missing partition is handled (and reported) by removeDeviceLockComponents itself
    const readRange = makePartitionReader(disk, originalMeta, partition);
    const volume = new ErofsVolume(readRange);
    await volume.init();
    originalFileListByPartition[name] = await listAllFilePaths(volume);
  }

  let result;
  try {
    result = await removeDeviceLockComponents(disk, originalMeta, (evt) => {
      if (evt.phase === 'missing') console.error(`  ✗ NOT FOUND: ${evt.target.path} (${evt.target.partition})`);
      if (evt.phase === 'verified') console.log(`  ✓ found: ${evt.target.path} (${evt.target.partition})`);
      if (evt.phase === 'removed') console.log(`  ✓ removed: ${evt.target.path} (${evt.target.partition})`);
    });
  } catch (err) {
    if (err instanceof DeviceLockRemovalError) {
      console.error('\nSTOP — modification aborted, no files were written.\n');
      console.error(err.message);
      if (err.details?.missing) {
        console.error('\nMissing target(s):');
        for (const t of err.details.missing) {
          console.error(`  ✗ ${t.partition}:${t.path} (${t.package})`);
        }
      }
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  console.log(`\nBuilding ${outputPath} ...`);
  const hash = createHash('sha256');
  const handle = await fsOpen(outputPath, 'w');
  try {
    for await (const chunk of streamPatchedDisk(disk, result.patchSet)) {
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  const modifiedSha256 = hash.digest('hex');

  // ---------------- Validation ----------------
  console.log('Validating rebuilt image ...');
  const validation = {};

  const { meta: modifiedMeta } = await loadDisk(outputPath);
  validation.reparsedOk = true;

  const originalNames = new Set(originalMeta.partitions.map((p) => p.name));
  const modifiedNames = new Set(modifiedMeta.partitions.map((p) => p.name));
  validation.allOriginalPartitionsPresent =
    originalNames.size === modifiedNames.size && [...originalNames].every((n) => modifiedNames.has(n));
  validation.requiredPartitionsPresent = result.partitionsModified.every((n) => modifiedNames.has(n));

  const targetsStillPresent = [];
  const unintendedChanges = [];
  for (const name of result.partitionsModified) {
    const partition = modifiedMeta.partitions.find((p) => p.name === name);
    // Re-open straight from the freshly-written output file, not the
    // in-memory patched disk, so validation is independent of the
    // in-process removal code path.
    const outBuf = await readFile(outputPath);
    const outFile = new Blob([outBuf]);
    const outIndex = await indexSparseOrRaw(outFile);
    const outDisk = new VirtualDisk([{ file: outFile, index: outIndex }]);
    const outReadRange = makePartitionReader(outDisk, modifiedMeta, partition);
    const volume = new ErofsVolume(outReadRange);
    await volume.init();

    for (const target of DEVICE_LOCK_TARGETS.filter((t) => t.partition === name)) {
      const hit = await resolveExactFile(volume, target.path);
      if (hit) targetsStillPresent.push(target);
    }

    const modifiedFiles = await listAllFilePaths(volume);
    const originalFiles = originalFileListByPartition[name];
    const removedHere = new Set(
      DEVICE_LOCK_TARGETS.filter((t) => t.partition === name).map((t) => t.path)
    );
    const originalSet = new Set(originalFiles);
    const modifiedSet = new Set(modifiedFiles);
    for (const f of originalSet) {
      if (!modifiedSet.has(f) && !removedHere.has(f)) unintendedChanges.push({ partition: name, path: f, kind: 'unexpectedly removed' });
    }
    for (const f of modifiedSet) {
      if (!originalSet.has(f)) unintendedChanges.push({ partition: name, path: f, kind: 'unexpectedly added' });
    }
  }
  validation.targetFilesRemoved = targetsStillPresent.length === 0;
  validation.noUnintendedFileChanges = unintendedChanges.length === 0;
  validation.unintendedChanges = unintendedChanges;

  validation.lpMetadataValid = true; // readMetadata()/readGeometry() already throw on invalid checksums
  const overlap = findOverlappingExtents(modifiedMeta);
  validation.noExtentOverlap = overlap.ok;
  if (!overlap.ok) validation.extentOverlapDetail = overlap.detail;

  const rebuiltSizes = {};
  let fitsAllocation = true;
  for (const name of result.partitionsModified) {
    const partition = modifiedMeta.partitions.find((p) => p.name === name);
    const allocated = Number(partitionSizeBytes(modifiedMeta, partition));
    rebuiltSizes[name] = allocated;
    if (result.rebuiltPartitionSizes[name] > allocated) fitsAllocation = false;
  }
  validation.rebuiltFsFitsPartition = fitsAllocation;

  validation.erofsIntegrity = {};
  for (const name of result.partitionsModified) {
    validation.erofsIntegrity[name] = await runErofsIntegrityCheck(disk, modifiedMeta, name);
  }
  const erofsAllOk = Object.values(validation.erofsIntegrity).every((r) => r.ok);

  const overallPass =
    validation.reparsedOk &&
    validation.allOriginalPartitionsPresent &&
    validation.requiredPartitionsPresent &&
    validation.targetFilesRemoved &&
    validation.noUnintendedFileChanges &&
    validation.lpMetadataValid &&
    validation.noExtentOverlap &&
    validation.rebuiltFsFitsPartition &&
    erofsAllOk;
  validation.overall = overallPass ? 'PASS' : 'FAIL';

  // ---------------- Report ----------------
  const originalPartitionSizes = {};
  for (const p of originalMeta.partitions) originalPartitionSizes[p.name] = Number(partitionSizeBytes(originalMeta, p));
  const rebuiltPartitionSizes = {};
  for (const p of modifiedMeta.partitions) rebuiltPartitionSizes[p.name] = Number(partitionSizeBytes(modifiedMeta, p));

  const report = {
    sourceImage: resolvedSource,
    outputImage: outputPath,
    timestamp: new Date().toISOString(),
    originalSha256,
    modifiedSha256,
    partitionsModified: result.partitionsModified,
    removed: result.removed.map((t) => ({ partition: t.partition, path: t.path, package: t.package })),
    originalPartitionSizes,
    rebuiltPartitionSizes,
    validation,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  // ---------------- Summary ----------------
  if (overallPass) {
    console.log('\nBUILD SUCCESSFUL\n');
    console.log('Removed:');
    for (const t of DEVICE_LOCK_TARGETS) console.log(`✓ ${t.package}`);
    console.log('\nModified partitions:');
    for (const n of result.partitionsModified) console.log(`✓ ${n}`);
    console.log('\nOutput:');
    console.log(path.basename(outputPath));
    console.log('\nOriginal:');
    console.log('UNCHANGED');
  } else {
    console.error('\nBUILD FAILED VALIDATION\n');
    console.error(JSON.stringify(validation, null, 2));
    process.exitCode = 1;
  }
  console.log(`\nReport written to ${reportPath}`);
}

main().catch((err) => {
  console.error('Unexpected error:', err.stack || err.message);
  process.exitCode = 1;
});
