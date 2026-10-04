// Orchestrates the security scan: for each logical partition of a loaded
// super.img, auto-detect its filesystem (ext4 or EROFS), walk its directory
// tree, find .apk files, and determine whether each one is capable of
// registering as an Android Device Administrator — plus a separate, looser
// "looks like a security plugin" naming heuristic.
//
// By default this is scan-only (pass no writeRange) and nothing here
// modifies, strips, or repacks any partition image. Passing a writeRange
// per partition additionally opens its volume in removal-capable mode and
// attaches a live `volume` reference (plus a `removalUnit` per APK) to the
// report, which main.js uses to actually call removeDirEntry() for
// user-selected apps and build a patched image.

import { Ext4Volume, looksLikeExt4 } from './ext4.js';
import { ErofsVolume, looksLikeErofs } from './erofs.js';
import { openZip, findEntry } from './zip.js';
import { parseAndroidManifest } from './axml.js';

// Well-known "bulk app container" directory names. If an .apk sits DIRECTLY
// inside one of these (no dedicated per-app subfolder — unusual, but
// possible), the removal unit is the .apk file itself rather than the
// shared container directory (which must never be removed as a whole).
const BULK_CONTAINER_DIR_NAMES = new Set([
  'app',
  'priv-app',
  'overlay',
  'vendor-overlay',
  'product-overlay',
  'odm-overlay',
  'system_ext-overlay',
  'framework',
  'framework-res',
  'lib',
  'lib64',
]);

// Best-effort, intentionally loose naming heuristic for "this might be a
// security/device-management plugin", independent of (and in addition to)
// the much more precise isDeviceAdmin manifest check. Matches against the
// package name, the app's declared label, and the name of the folder/file
// it's stored in. False positives/negatives are expected — this is a
// hint for the user to review, not a guarantee.
const SECURITY_PLUGIN_NAME_PATTERN =
  /security|secure|antivirus|anti-virus|malware|spyware|guard|protect|firewall|\badmin\b|\bpolic(y|ies)\b|\bmdm\b|device.?manag|plugin|threat/i;

function looksLikeSecurityPluginName({ packageName, appLabel, path }) {
  const lastSegment = path ? path.split('/').filter(Boolean).pop() : undefined;
  const haystack = [packageName, appLabel, lastSegment].filter(Boolean).join(' | ');
  if (!haystack) return false;
  return SECURITY_PLUGIN_NAME_PATTERN.test(haystack);
}

/**
 * @param {(offset:number, length:number) => Promise<Uint8Array>} readRange
 *   Reads bytes relative to the start of a single partition's byte range.
 * @param {(offset:number, bytes:Uint8Array) => void} [writeRange]
 *   Optional. If given, the opened volume supports removeDirEntry().
 * @returns {Promise<{type: 'ext4'|'erofs', volume: Ext4Volume|ErofsVolume}>}
 */
export async function detectAndOpenFilesystem(readRange, writeRange) {
  const header = await readRange(1024, 144);
  if (looksLikeExt4(header)) {
    const volume = new Ext4Volume(readRange, writeRange);
    await volume.init();
    return { type: 'ext4', volume };
  }
  if (looksLikeErofs(header)) {
    const volume = new ErofsVolume(readRange, writeRange);
    await volume.init();
    return { type: 'erofs', volume };
  }
  throw new Error('Unrecognized filesystem (neither ext4 nor EROFS superblock magic found at offset 1024).');
}

/**
 * Recursively walks a filesystem volume collecting every regular file whose
 * name ends in ".apk" (case-insensitive), along with the "removal unit"
 * that should be deleted to remove that app entirely: normally the APK's
 * own dedicated containing folder (the universal Android convention), but
 * falls back to just the .apk file itself if it's sitting loose directly
 * inside a shared bulk container directory (app/, priv-app/, etc.).
 */
async function findApkFiles(volume, inode, pathSoFar, out, visited, warnings, dirName, parentInode) {
  const dirKey = inode.isDir ? `d:${inode.inodeNumber ?? inode.nid}` : null;
  if (dirKey && visited.has(dirKey)) return;
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
  if (dirKey) visited.add(dirKey);

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
      await findApkFiles(volume, childInode, childPath, out, visited, warnings, e.name, inode);
    } else if (childInode.isRegular && e.name.toLowerCase().endsWith('.apk')) {
      const dedicatedFolder = dirName && !BULK_CONTAINER_DIR_NAMES.has(dirName.toLowerCase());
      const removalUnit = dedicatedFolder
        ? { kind: 'folder', parentInode, entryName: dirName, parentPath: pathSoFar.split('/').slice(0, -1).join('/') }
        : { kind: 'file', parentInode: inode, entryName: e.name, parentPath: pathSoFar };
      out.push({ path: childPath, inode: childInode, removalUnit });
    }
  }
}

/**
 * Scans a single partition's filesystem for APKs and classifies each for
 * Device Administrator capability and the security-plugin naming heuristic.
 *
 * @param {string} partitionName
 * @param {(offset:number, length:number) => Promise<Uint8Array>} readRange
 * @param {(offset:number, bytes:Uint8Array) => void} [writeRange]
 *   Optional — see detectAndOpenFilesystem().
 */
export async function scanPartitionForApks(partitionName, readRange, writeRange) {
  const results = [];
  const warnings = [];
  let fsType = 'unknown';

  let detected;
  try {
    detected = await detectAndOpenFilesystem(readRange, writeRange);
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
  await findApkFiles(volume, volume.rootInode, '', apkFiles, new Set(), warnings, '', null);

  for (const apk of apkFiles) {
    const entry = {
      partitionName,
      path: apk.path,
      sizeBytes: apk.inode.size,
      removalUnit: apk.removalUnit,
    };
    try {
      let data;
      if (fsType === 'ext4') {
        data = await volume.readFile(apk.inode);
      } else {
        if (!apk.inode.supported) {
          entry.deviceAdmin = 'unknown';
          entry.note = `Could not read file contents: EROFS datalayout ${apk.inode.datalayoutName} (compressed) is not supported by this scanner.`;
          entry.looksLikeSecurityPlugin = looksLikeSecurityPluginName({ path: entry.path });
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
        entry.looksLikeSecurityPlugin = looksLikeSecurityPluginName({ path: entry.path });
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
      entry.looksLikeSecurityPlugin = looksLikeSecurityPluginName({
        packageName: entry.packageName,
        appLabel: entry.appLabel,
        path: entry.path,
      });
    } catch (err) {
      entry.deviceAdmin = 'unknown';
      entry.note = `Could not analyze APK: ${err.message}`;
      entry.looksLikeSecurityPlugin = looksLikeSecurityPluginName({ path: entry.path });
    }
    results.push(entry);
  }

  return { partitionName, fsType, apks: results, warnings, volume: writeRange ? volume : undefined };
}

/**
 * Scans every partition supplied. `partitions` is an array of
 * { name, readRange, writeRange? } where readRange/writeRange operate on
 * offsets relative to that partition's own start. Supplying writeRange
 * additionally attaches a live `volume` to each partition's result (for
 * later removeDirEntry calls) and a `removalUnit` to each apk entry.
 */
export async function scanAllPartitions(partitions, onProgress) {
  const report = [];
  for (const p of partitions) {
    onProgress?.({ phase: 'start', partitionName: p.name });
    let result;
    try {
      result = await scanPartitionForApks(p.name, p.readRange, p.writeRange);
    } catch (err) {
      result = { partitionName: p.name, fsType: 'unknown', apks: [], warnings: [`Scan failed: ${err.message}`] };
    }
    report.push(result);
    onProgress?.({ phase: 'done', partitionName: p.name, result });
  }
  return report;
}
