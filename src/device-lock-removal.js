// "Remove Device Lock Components": a narrow, hardcoded-target variant of
// the general scan+remove feature (scanner.js / main.js), built for one
// specific, exact task: delete three known APK files by their EXACT paths,
// from two specific EROFS partitions, and nothing else.
//
// Deliberately does NOT use scanner.js's heuristic APK discovery or
// manifest parsing. The real-world motivation (per the task) is that one of
// these partitions' APKs may be stored in an EROFS COMPRESSED_COMPACT
// layout this project's reader can't decompress, so a content-reading
// scanner can misreport/miss it entirely. Locating and removing a directory
// entry never requires reading the target file's *content* though (only
// its parent directory's listing), so exact-path resolution + removal
// works regardless of the target's compression layout.
//
// Also deliberately removes only the exact FILE named at each path (never
// its containing folder), since the task requires every *other* file —
// including any siblings that might happen to live alongside an APK in the
// same per-app folder — to be preserved untouched.

import { detectAndOpenFilesystem } from './scanner.js';
import { makePartitionReader, makePartitionWriter } from './extractor.js';
import { PatchSet } from './patchset.js';
import { partitionSizeBytes } from './lp.js';

export const DEVICE_LOCK_TARGETS = Object.freeze([
  Object.freeze({
    partition: 'product_a',
    path: '/priv-app/SecurityCom/SecurityCom.apk',
    package: 'com.scorpio.securitycom',
  }),
  Object.freeze({
    partition: 'system_ext_a',
    path: '/app/TranPluginApp/TranPluginApp.apk',
    package: 'com.transsion.spl',
  }),
  Object.freeze({
    partition: 'system_ext_a',
    path: '/app/TranDaemonApp/TranDaemonApp.apk',
    package: 'com.transsion.spld',
  }),
]);

export class DeviceLockRemovalError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'DeviceLockRemovalError';
    this.details = details;
  }
}

/**
 * Resolves an absolute path (e.g. "/priv-app/SecurityCom/SecurityCom.apk")
 * down to { parentInode, entryName, fileInode } inside an already-open
 * volume. Returns null (never throws) if any path component is missing, a
 * non-final component isn't a directory, or the final component isn't a
 * plain file — all of which just mean "not found" for our purposes.
 */
export async function resolveExactFile(volume, absPath) {
  const parts = absPath.split('/').filter(Boolean);
  if (!parts.length) return null;
  let dirInode = volume.rootInode;
  for (let i = 0; i < parts.length - 1; i++) {
    const entries = await volume.listDir(dirInode);
    const e = entries.find((x) => x.name === parts[i]);
    if (!e) return null;
    const childInode = await volume.readInode(e.inodeNumber ?? e.nid);
    if (!childInode.isDir) return null;
    dirInode = childInode;
  }
  const finalName = parts[parts.length - 1];
  const entries = await volume.listDir(dirInode);
  const e = entries.find((x) => x.name === finalName);
  if (!e) return null;
  const fileInode = await volume.readInode(e.inodeNumber ?? e.nid);
  if (!fileInode.isRegular) return null;
  return { parentInode: dirInode, entryName: finalName, fileInode };
}

/** Walks every file path under a volume, for "nothing else changed" diffing. */
export async function listAllFilePaths(volume) {
  const out = [];
  async function walk(inode, prefix) {
    const entries = await volume.listDir(inode);
    for (const e of entries) {
      const child = await volume.readInode(e.inodeNumber ?? e.nid);
      const path = `${prefix}/${e.name}`;
      if (child.isDir) await walk(child, path);
      else out.push(path);
    }
  }
  await walk(volume.rootInode, '');
  out.sort();
  return out;
}

/**
 * Runs the full "Remove Device Lock Components" workflow against an
 * already-parsed super.img: opens the two target EROFS partitions
 * (through a shared PatchSet so nothing is mutated until the caller
 * streams it out), verifies all three hardcoded target files exist BEFORE
 * changing anything, then removes all three. Throws DeviceLockRemovalError
 * (without making any change) if a required partition is missing, isn't
 * EROFS, or any target file can't be located.
 *
 * @param {import('./virtual-disk.js').VirtualDisk} disk
 * @param {object} meta parsed LP metadata (lp.js readMetadata())
 * @param {(evt:object)=>void} [onProgress]
 */
export async function removeDeviceLockComponents(disk, meta, onProgress) {
  const report = (evt) => onProgress && onProgress(evt);

  const targetPartitionNames = [...new Set(DEVICE_LOCK_TARGETS.map((t) => t.partition))];
  for (const name of targetPartitionNames) {
    if (!meta.partitions.some((p) => p.name === name)) {
      throw new DeviceLockRemovalError(
        `Required partition "${name}" was not found in this super.img's metadata. No changes were made.`,
        { missingPartition: name }
      );
    }
  }

  const patchSet = new PatchSet();
  const volumesByPartition = {};
  const originalPartitionSizes = {};

  for (const name of targetPartitionNames) {
    const partition = meta.partitions.find((p) => p.name === name);
    originalPartitionSizes[name] = Number(partitionSizeBytes(meta, partition));
    const readRange = makePartitionReader(disk, meta, partition, patchSet);
    const writeRange = makePartitionWriter(disk, meta, partition, patchSet);
    report({ phase: 'open', partition: name });
    const { type, volume } = await detectAndOpenFilesystem(readRange, writeRange);
    if (type !== 'erofs') {
      throw new DeviceLockRemovalError(
        `Partition "${name}" was detected as "${type}", but this action requires EROFS for both target ` +
          `partitions. No changes were made.`,
        { partition: name, actualType: type }
      );
    }
    volumesByPartition[name] = volume;
    report({ phase: 'opened', partition: name, fsType: type });
  }

  // Phase 1: verify ALL three targets exist before touching anything, so a
  // partial/half-applied modification can never happen.
  const resolved = [];
  const missing = [];
  for (const target of DEVICE_LOCK_TARGETS) {
    const hit = await resolveExactFile(volumesByPartition[target.partition], target.path);
    if (hit) {
      resolved.push({ target, ...hit });
      report({ phase: 'verified', target });
    } else {
      missing.push(target);
      report({ phase: 'missing', target });
    }
  }
  if (missing.length) {
    throw new DeviceLockRemovalError(
      `STOP: ${missing.length} of ${DEVICE_LOCK_TARGETS.length} target file(s) could not be located ` +
        `at their exact expected path. No changes were made.`,
      { missing }
    );
  }

  // Phase 2: all three confirmed present — remove all three.
  const removed = [];
  for (const { target, parentInode, entryName } of resolved) {
    const ok = await volumesByPartition[target.partition].removeDirEntry(parentInode, entryName);
    if (!ok) {
      throw new DeviceLockRemovalError(
        `Failed to remove "${target.path}" from "${target.partition}" (unexpectedly not found at removal time).`,
        { target }
      );
    }
    removed.push(target);
    report({ phase: 'removed', target });
  }

  return {
    patchSet,
    removed,
    partitionsModified: targetPartitionNames,
    volumesByPartition,
    // This action never frees blocks/inodes or resizes anything (see
    // README): the rebuilt partition is always exactly the same size as
    // the original.
    rebuiltPartitionSizes: { ...originalPartitionSizes },
    originalPartitionSizes,
  };
}
