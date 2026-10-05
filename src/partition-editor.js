// Core logic for "Edit & merge partitions": given an already-parsed
// super.img (disk/geo/meta) plus a plan of delete/replace/add operations,
// produces a complete, valid, flashable-sized-or-clearly-rejected new
// super.img.
//
// Design (see README "Edit & merge partitions" section for the full
// rationale and the project's standing conventions this follows):
//   - LP geometry is NEVER touched (metadata_max_size/slot_count/
//     logical_block_size all stay byte-for-byte identical).
//   - Groups are preserved as-is (name/flags/maximum_size); only which
//     partitions/extents belong to them is recomputed.
//   - Deleting a partition (or replacing one) abandons its old extent(s)
//     forever -- consistent with this project's established
//     "never reuse freed space" policy for the app-removal features.
//     Replacement/new partition content is always allocated in brand-new
//     space appended after the end of the original block device, which
//     means the output image can grow but the ORIGINAL bytes for every
//     unrelated (and even abandoned) byte range are never touched or moved.
//   - Growing the file means the result may no longer fit the fixed
//     physical "super" partition size on a real device -- planPartitionEdits()
//     always reports both the original and new total size so this is
//     never silent.
import {
  partitionExtentRanges,
  partitionSizeBytes,
  totalMetadataRegionSize,
  primaryMetadataOffset,
  backupMetadataOffset,
  LP_TARGET_TYPE_LINEAR,
  LP_SECTOR_SIZE,
} from './lp.js';
import { encodeLpMetadata } from './lp-writer.js';
import { PatchSet, streamPatchedDisk } from './patchset.js';

export class PartitionEditError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'PartitionEditError';
    this.details = details;
  }
}

function alignUp(value, align) {
  return Math.ceil(value / align) * align;
}

/**
 * Validates and resolves an edit plan into concrete new partitions/extents,
 * without reading or writing any partition *content* yet (that happens in
 * streamEditedSuperImage). Throws PartitionEditError with a clear, specific
 * reason for anything that can't be satisfied (unknown partition name,
 * duplicate add, group capacity exceeded, metadata table too big for its
 * slot budget) -- callers should show these directly, nothing is silently
 * adjusted.
 *
 * @param {object} meta parsed LP metadata (lp.js readMetadata())
 * @param {object} geo parsed LP geometry (lp.js readGeometry())
 * @param {Array<
 *   {action:'delete', name:string} |
 *   {action:'replace', name:string, sizeBytes:number} |
 *   {action:'add', name:string, groupName:string, attributes?:number, sizeBytes:number}
 * >} edits
 */
export function planPartitionEdits(meta, geo, edits) {
  const byName = new Map(meta.partitions.map((p) => [p.name, p]));
  const groupIndexByName = new Map(meta.groups.map((g, i) => [g.name, i]));

  const deletes = new Set();
  const replaces = new Map(); // name -> sizeBytes
  const adds = []; // {name, groupName, attributes, sizeBytes}

  for (const edit of edits) {
    if (edit.action === 'delete') {
      if (!byName.has(edit.name)) {
        throw new PartitionEditError(`Cannot delete "${edit.name}": no such partition in this image.`, { edit });
      }
      deletes.add(edit.name);
    } else if (edit.action === 'replace') {
      if (!byName.has(edit.name)) {
        throw new PartitionEditError(`Cannot replace "${edit.name}": no such partition in this image.`, { edit });
      }
      if (!(edit.sizeBytes > 0)) {
        throw new PartitionEditError(`Replacement for "${edit.name}" has no content.`, { edit });
      }
      replaces.set(edit.name, edit.sizeBytes);
    } else if (edit.action === 'add') {
      if (byName.has(edit.name)) {
        throw new PartitionEditError(`Cannot add "${edit.name}": a partition with that name already exists (use "replace" instead).`, { edit });
      }
      if (!groupIndexByName.has(edit.groupName)) {
        throw new PartitionEditError(`Cannot add "${edit.name}": group "${edit.groupName}" does not exist in this image.`, { edit });
      }
      if (!(edit.sizeBytes > 0)) {
        throw new PartitionEditError(`New partition "${edit.name}" has no content.`, { edit });
      }
      adds.push(edit);
    } else {
      throw new PartitionEditError(`Unknown edit action "${edit.action}".`, { edit });
    }
  }
  for (const name of replaces.keys()) {
    if (deletes.has(name)) {
      throw new PartitionEditError(`"${name}" is marked both deleted and replaced -- pick one.`, { name });
    }
  }

  // Alignment for newly-allocated extents: prefer the block device's own
  // declared alignment (what real OEM tooling sized filesystems to), else
  // the geometry's logical_block_size, else a safe default.
  const blockDevice = meta.blockDevices[0];
  const alignment = blockDevice?.alignment || geo.logical_block_size || 4096;

  // New allocations always start strictly after everything the ORIGINAL
  // image could possibly reference or contain -- the declared block device
  // size, the actual loaded file size, and the end of the furthest-out
  // existing extent, whichever is largest -- so a new allocation can never
  // collide with anything, including bytes the metadata doesn't currently
  // reference but which physically exist in the file.
  let cursor = Math.max(
    Number(blockDevice?.size ?? 0n),
    totalMetadataRegionSize(geo)
  );
  for (const ext of meta.extents) {
    if (ext.target_type === LP_TARGET_TYPE_LINEAR) {
      const end = Number(ext.target_data + ext.num_sectors) * LP_SECTOR_SIZE;
      if (end > cursor) cursor = end;
    }
  }
  const originalDataEnd = cursor; // first byte truly free to allocate into

  const newPartitions = [];
  const newExtents = [];
  const allocations = []; // {name, action, byteOffset, byteLength, sizeBytes}

  function carryOverPartition(p) {
    const ranges = partitionExtentRanges(meta, p);
    const firstIndex = newExtents.length;
    for (const r of ranges) {
      if (r.type === 'zero') {
        newExtents.push({ num_sectors: r.byteLength / BigInt(LP_SECTOR_SIZE), target_type: 1, target_data: 0n, target_source: 0 });
      } else {
        newExtents.push({
          num_sectors: r.byteLength / BigInt(LP_SECTOR_SIZE),
          target_type: LP_TARGET_TYPE_LINEAR,
          target_data: r.byteOffset / BigInt(LP_SECTOR_SIZE),
          target_source: r.targetSource,
        });
      }
    }
    newPartitions.push({
      name: p.name,
      attributes: p.attributes,
      first_extent_index: firstIndex,
      num_extents: ranges.length,
      group_index: p.group_index,
    });
  }

  function allocateNew(name, action, groupIndex, attributes, sizeBytes) {
    const byteLength = alignUp(sizeBytes, alignment);
    const byteOffset = cursor;
    cursor += byteLength;
    const firstIndex = newExtents.length;
    newExtents.push({
      num_sectors: BigInt(byteLength / LP_SECTOR_SIZE),
      target_type: LP_TARGET_TYPE_LINEAR,
      target_data: BigInt(byteOffset / LP_SECTOR_SIZE),
      target_source: 0,
    });
    newPartitions.push({ name, attributes, first_extent_index: firstIndex, num_extents: 1, group_index: groupIndex });
    allocations.push({ name, action, byteOffset, byteLength, sizeBytes });
  }

  // Preserve original partition order for anything untouched or replaced
  // (keeps partition-table diffs minimal/predictable); deletions simply
  // disappear; new "add" partitions are appended at the end.
  for (const p of meta.partitions) {
    if (deletes.has(p.name)) continue;
    if (replaces.has(p.name)) {
      allocateNew(p.name, 'replace', p.group_index, p.attributes, replaces.get(p.name));
    } else {
      carryOverPartition(p);
    }
  }
  for (const edit of adds) {
    allocateNew(edit.name, 'add', groupIndexByName.get(edit.groupName), edit.attributes ?? 0, edit.sizeBytes);
  }

  // Group capacity check: only enforced where the original image actually
  // declared a nonzero cap (0 == unlimited, the overwhelmingly common case
  // for a single-group consumer super.img).
  const groupUsage = new Map();
  newPartitions.forEach((p) => {
    const bytes = partitionSizeBytes({ extents: newExtents }, p);
    groupUsage.set(p.group_index, (groupUsage.get(p.group_index) ?? 0n) + bytes);
  });
  const groupOverflows = [];
  meta.groups.forEach((g, idx) => {
    if (g.maximum_size > 0n) {
      const used = groupUsage.get(idx) ?? 0n;
      if (used > g.maximum_size) {
        groupOverflows.push({ group: g.name, used, maximum: g.maximum_size });
      }
    }
  });
  if (groupOverflows.length) {
    throw new PartitionEditError(
      `Group capacity exceeded: ${groupOverflows.map((o) => `"${o.group}" needs ${o.used} bytes, max is ${o.maximum}`).join('; ')}.`,
      { groupOverflows }
    );
  }

  const newTotalSize = cursor;
  const originalTotalSize = Number(blockDevice?.size ?? 0n);
  const newBlockDevices = meta.blockDevices.map((b, i) =>
    i === 0 ? { ...b, size: BigInt(newTotalSize) } : b
  );

  const newMeta = {
    partitions: newPartitions,
    extents: newExtents,
    groups: meta.groups,
    blockDevices: newBlockDevices,
  };

  // Metadata-table size check: must fit the ORIGINAL metadata_max_size
  // budget for every slot (geometry itself is never touched/grown).
  const PARTITION_ENTRY_SIZE = 52;
  const EXTENT_ENTRY_SIZE = 24;
  const GROUP_ENTRY_SIZE = 48;
  const BLOCK_DEVICE_ENTRY_SIZE = 64;
  const headerSize = meta.header_size && meta.header_size >= 128 ? meta.header_size : 128;
  const tablesSize =
    newPartitions.length * PARTITION_ENTRY_SIZE +
    newExtents.length * EXTENT_ENTRY_SIZE +
    newMeta.groups.length * GROUP_ENTRY_SIZE +
    newMeta.blockDevices.length * BLOCK_DEVICE_ENTRY_SIZE;
  if (headerSize + tablesSize > geo.metadata_max_size) {
    throw new PartitionEditError(
      `The new partition table (${headerSize + tablesSize} bytes) is too big for this image's metadata slot budget ` +
        `(${geo.metadata_max_size} bytes). Too many partitions/extents for this super.img's reserved metadata space.`,
      { headerSize, tablesSize, metadataMaxSize: geo.metadata_max_size }
    );
  }

  return {
    newMeta,
    headerSize,
    allocations,
    deletedNames: [...deletes],
    originalTotalSize,
    newTotalSize,
    grew: newTotalSize > originalTotalSize,
    originalDataEnd,
  };
}

/**
 * Streams the final edited super.img: the entire original file (geometry
 * untouched, every metadata slot replaced with the new table, everything
 * else byte-for-byte original -- including now-abandoned bytes), followed
 * by each newly-allocated partition's content, read from its own
 * `readSource(offset, length)` function and zero-padded up to its
 * sector-aligned allocation.
 *
 * @param {import('./virtual-disk.js').VirtualDisk} disk original disk
 * @param {object} geo
 * @param {ReturnType<typeof planPartitionEdits>} plan
 * @param {Map<string, (offset:number, length:number) => Promise<Uint8Array>>} sources
 *   maps each replace/add partition name to a reader over ITS OWN uploaded
 *   content (e.g. built via a VirtualDisk over the uploaded file).
 */
export async function* streamEditedSuperImage(disk, geo, plan, sources, pieceSize = 16 * 1024 * 1024) {
  const { header, tables } = await encodeLpMetadata(plan.newMeta, plan.headerSize);

  const patchSet = new PatchSet();
  for (let slot = 0; slot < geo.metadata_slot_count; slot++) {
    patchSet.addPatch(primaryMetadataOffset(geo, slot), header);
    patchSet.addPatch(primaryMetadataOffset(geo, slot) + header.length, tables);
    patchSet.addPatch(backupMetadataOffset(geo, slot), header);
    patchSet.addPatch(backupMetadataOffset(geo, slot) + header.length, tables);
  }

  // The original file, exactly as long as it always was, with only the
  // metadata slots patched.
  for await (const chunk of streamPatchedDisk(disk, patchSet, pieceSize)) {
    yield chunk;
  }

  // Then every newly-allocated partition's content, in allocation order,
  // zero-padded to fill its full sector-aligned extent.
  for (const alloc of plan.allocations) {
    const readSource = sources.get(alloc.name);
    if (!readSource) throw new PartitionEditError(`No content source provided for "${alloc.name}".`, { alloc });
    let written = 0;
    while (written < alloc.sizeBytes) {
      const take = Math.min(pieceSize, alloc.sizeBytes - written);
      yield await readSource(written, take);
      written += take;
    }
    const padding = alloc.byteLength - alloc.sizeBytes;
    if (padding > 0) {
      let remaining = padding;
      while (remaining > 0) {
        const take = Math.min(pieceSize, remaining);
        yield new Uint8Array(take);
        remaining -= take;
      }
    }
  }
}
