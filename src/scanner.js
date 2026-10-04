// Orchestrates the read-only security scan: for each logical partition of a
// loaded super.img, auto-detect its filesystem (ext4 or EROFS), walk its
// directory tree, find .apk files, and determine whether each one is capable
// of registering as an Android Device Administrator.
//
// This is deliberately scan-only: nothing here modifies, strips, or repacks
// any partition image.

import { Ext4Volume, looksLikeExt4 } from './ext4.js';
import { ErofsVolume, looksLikeErofs } from './erofs.js';
import { openZip, findEntry } from './zip.js';
import { parseAndroidManifest } from './axml.js';

/**
 * @param {(offset:number, length:number) => Promise<Uint8Array>} readRange
 *   Reads bytes relative to the start of a single partition's byte range.
 * @returns {Promise<{type: 'ext4'|'erofs', volume: Ext4Volume|ErofsVolume}>}
 */
export async function detectAndOpenFilesystem(readRange) {
  const header = await readRange(1024, 144);
  if (looksLikeExt4(header)) {
    const volume = new Ext4Volume(readRange);
    await volume.init();
    return { type: 'ext4', volume };
  }
  if (looksLikeErofs(header)) {
    const volume = new ErofsVolume(readRange);
    await volume.init();
    return { type: 'erofs', volume };
  }
  throw new Error('Unrecognized filesystem (neither ext4 nor EROFS superblock magic found at offset 1024).');
}

/**
 * Recursively walks a filesystem volume collecting every regular file whose
 * name ends in ".apk" (case-insensitive).
 */
async function findApkFiles(type, volume, inode, pathSoFar, out, visited, warnings) {
  if (visited.has(inode.isDir ? `d:${inode.inodeNumber ?? inode.nid}` : null)) return;
  let entries;
  try {
    entries = await volume.listDir(inode);
  } catch (err) {
    warnings.push(`Could not list directory "${pathSoFar || '/'}": ${err.message}`);
    return;
  }
  if (inode.htreeIndexed) {
    warnings.push(
      `Directory "${pathSoFar || '/'}" is htree-indexed, which isn't fully supported; some entries may have been missed.`
    );
  }

  const key = `d:${inode.inodeNumber ?? inode.nid}`;
  visited.add(key);

  for (const e of entries) {
    const childId = e.inodeNumber ?? e.nid;
    const childPath = `${pathSoFar}/${e.name}`;
    let childInode;
    try {
      childInode = await volume.readInode(childId);
    } catch (err) {
      warnings.push(`Could not read inode for "${childPath}": ${err.message}`);
      continue;
    }
    if (childInode.isDir) {
      await findApkFiles(type, volume, childInode, childPath, out, visited, warnings);
    } else if (childInode.isRegular && e.name.toLowerCase().endsWith('.apk')) {
      out.push({ path: childPath, inode: childInode });
    }
  }
}

/**
 * Scans a single partition's filesystem for APKs and classifies each for
 * Device Administrator capability.
 *
 * @param {string} partitionName
 * @param {(offset:number, length:number) => Promise<Uint8Array>} readRange
 */
export async function scanPartitionForApks(partitionName, readRange) {
  const results = [];
  const warnings = [];
  let fsType = 'unknown';

  let detected;
  try {
    detected = await detectAndOpenFilesystem(readRange);
  } catch (err) {
    return {
      partitionName,
      fsType,
      apks: [],
      warnings: [`Skipped: ${err.message}`],
    };
  }
  fsType = detected.type;
  const { volume } = detected;

  const apkFiles = [];
  await findApkFiles(fsType, volume, volume.rootInode, '', apkFiles, new Set(), warnings);

  for (const apk of apkFiles) {
    const entry = { partitionName, path: apk.path, sizeBytes: apk.inode.size };
    try {
      let data;
      if (fsType === 'ext4') {
        data = await volume.readFile(apk.inode);
      } else {
        if (!apk.inode.supported) {
          entry.deviceAdmin = 'unknown';
          entry.note = `Could not read file contents: EROFS datalayout ${apk.inode.datalayoutName} (compressed) is not supported by this scanner.`;
          results.push(entry);
          continue;
        }
        data = await volume.readFile(apk.inode);
      }

      const readByteRange = async (offset, length) => data.subarray(offset, offset + length);
      const zip = await openZip(readByteRange, data.length);
      const manifestEntry = findEntry(zip, 'AndroidManifest.xml');
      if (!manifestEntry) {
        entry.deviceAdmin = 'unknown';
        entry.note = 'APK has no AndroidManifest.xml (malformed or not a real APK).';
        results.push(entry);
        continue;
      }
      const manifestBytes = await zip.readEntry(manifestEntry);
      const manifest = parseAndroidManifest(manifestBytes);

      entry.packageName = manifest.packageName;
      entry.appLabel = manifest.applicationLabel;
      entry.deviceAdmin = manifest.isDeviceAdmin ? 'yes' : 'no';
      if (manifest.isDeviceAdmin) {
        entry.deviceAdminReceivers = manifest.evidence.deviceAdminReceivers;
      }
    } catch (err) {
      entry.deviceAdmin = 'unknown';
      entry.note = `Could not analyze APK: ${err.message}`;
    }
    results.push(entry);
  }

  return { partitionName, fsType, apks: results, warnings };
}

/**
 * Scans every partition supplied. `partitions` is an array of
 * { name, readRange } where readRange reads bytes relative to that
 * partition's own start.
 */
export async function scanAllPartitions(partitions, onProgress) {
  const report = [];
  for (const p of partitions) {
    onProgress?.({ phase: 'start', partitionName: p.name });
    let result;
    try {
      result = await scanPartitionForApks(p.name, p.readRange);
    } catch (err) {
      result = { partitionName: p.name, fsType: 'unknown', apks: [], warnings: [`Scan failed: ${err.message}`] };
    }
    report.push(result);
    onProgress?.({ phase: 'done', partitionName: p.name, result });
  }
  return report;
}
