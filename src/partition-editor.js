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
//   - Deleting or replacing a partition frees its old extent(s) for reuse:
//     new/replacement content is allocated into that freed space first
//     (first-fit, in ascending offset order, splitting a single
//     partition's content across multiple extents if needed -- completely
//     normal for a dynamic-partition table), and only appended as brand
//     new space (growing the file) once the freed pool is exhausted. This
//     is what makes it possible to replace a partition with a *different*
//     size image without the output necessarily growing at all, as long as
//     enough space was freed elsewhere in the same edit.
//   - Every byte NOT touched by an edit -- including any leftover
//     unreclaimed fragment of freed space -- is preserved at its exact
//     original file offset; nothing is ever shifted around.
//   - Growing the file (when reuse isn't enough) means the result may no
//     longer fit the fixed physical "super" partition size on a real
//     device -- planPartitionEdits() always reports both the original and
//     new total size so this is never silent.
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
import { PatchSet, applyPatches } from './patchset.js';

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
 * @param {object} [opts]
 * @param {number} [opts.originalDiskSize] the ACTUAL loaded file's total
 *   byte length (VirtualDisk.totalSize). Used (along with the metadata's
 *   own declared block device size) to make sure new allocations never
 *   land on bytes that physically exist in the file but aren't covered by
 *   the declared block device size -- defaults to the declared size itself
 *   if not given, which is correct for any image where those two numbers
 *   already agree (the overwhelmingly common case).
 */
export function planPartitionEdits(meta, geo, edits, opts = {}) {
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
  const declaredSize = Number(blockDevice?.size ?? 0n);
  const originalDiskSize = opts.originalDiskSize ?? declaredSize;

  // Anything beyond this point in the file is "append-only" territory --
  // brand new space, never anything a deletion could free up, since
  // nothing valid can already live out here.
  let appendCursor = Math.max(declaredSize, originalDiskSize, totalMetadataRegionSize(geo));
  for (const ext of meta.extents) {
    if (ext.target_type === LP_TARGET_TYPE_LINEAR) {
      const end = Number(ext.target_data + ext.num_sectors) * LP_SECTOR_SIZE;
      if (end > appendCursor) appendCursor = end;
    }
  }
  const originalBoundary = appendCursor; // everything below this is real, pre-existing file content

  // Free-space pool: every deleted/replaced partition's OLD linear
  // extent(s), sorted and merged into non-overlapping ranges so adjacent
  // freed fragments can satisfy a single larger allocation.
  const freePool = [];
  for (const p of meta.partitions) {
    if (!deletes.has(p.name) && !replaces.has(p.name)) continue;
    for (const r of partitionExtentRanges(meta, p)) {
      if (r.type === 'linear' && r.targetSource === 0) {
        freePool.push({ offset: Number(r.byteOffset), length: Number(r.byteLength) });
      }
    }
  }
  freePool.sort((a, b) => a.offset - b.offset);
  const mergedFree = [];
  for (const r of freePool) {
    const last = mergedFree[mergedFree.length - 1];
    if (last && r.offset <= last.offset + last.length) {
      last.length = Math.max(last.length, r.offset + r.length - last.offset);
    } else {
      mergedFree.push({ ...r });
    }
  }
  const freeBytesAvailable = mergedFree.reduce((a, r) => a + r.length, 0);

  const newPartitions = [];
  const newExtents = [];
  const allocations = []; // {name, action, sizeBytes, byteLength, ranges:[{byteOffset,byteLength}]}

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

  /** Allocates `sizeBytes` (sector-aligned up) for a replace/add partition:
   * first-fit from the freed-space pool (possibly across several
   * fragments, i.e. multiple extents -- completely normal for a dynamic
   * partition), then whatever doesn't fit is appended as new space. */
  function allocateNew(name, action, groupIndex, attributes, sizeBytes) {
    const byteLength = alignUp(sizeBytes, alignment);
    let remaining = byteLength;
    const ranges = [];
    for (const free of mergedFree) {
      if (remaining <= 0) break;
      if (free.length <= 0) continue;
      const take = Math.min(free.length, remaining);
      ranges.push({ byteOffset: free.offset, byteLength: take });
      free.offset += take;
      free.length -= take;
      remaining -= take;
    }
    if (remaining > 0) {
      ranges.push({ byteOffset: appendCursor, byteLength: remaining });
      appendCursor += remaining;
    }

    const firstIndex = newExtents.length;
    for (const range of ranges) {
      newExtents.push({
        num_sectors: BigInt(range.byteLength / LP_SECTOR_SIZE),
        target_type: LP_TARGET_TYPE_LINEAR,
        target_data: BigInt(range.byteOffset / LP_SECTOR_SIZE),
        target_source: 0,
      });
    }
    newPartitions.push({ name, attributes, first_extent_index: firstIndex, num_extents: ranges.length, group_index: groupIndex });
    allocations.push({ name, action, sizeBytes, byteLength, ranges });
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

  const newTotalSize = appendCursor;
  const originalTotalSize = Math.max(declaredSize, originalDiskSize);
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
    originalBoundary,
    freeBytesReclaimed: freeBytesAvailable - mergedFree.reduce((a, r) => a + r.length, 0),
    freeBytesAvailable,
  };
}

/** Builds the full, gap-free, non-overlapping list of segments covering
 * [0, plan.newTotalSize): each is either `{type:'original', start, end}`
 * (copy verbatim from the loaded disk, metadata patches still applied) or
 * `{type:'new', start, end, allocName, srcStart}` (bytes
 * [srcStart, srcStart + (end-start)) of the named allocation's own content
 * -- used to let a replacement partition split across several reused
 * free-space fragments still read its source content in one continuous
 * sequence, regardless of how fragmented its destination extents are). */
function buildSegments(plan) {
  let segments = [{ type: 'original', start: 0, end: plan.originalBoundary }];

  function carve(carveStart, carveLength, data) {
    const carveEnd = carveStart + carveLength;
    const result = [];
    for (const seg of segments) {
      if (seg.end <= carveStart || seg.start >= carveEnd) {
        result.push(seg);
        continue;
      }
      if (seg.start < carveStart) result.push({ ...seg, end: carveStart });
      result.push({ ...data, start: carveStart, end: carveEnd });
      if (seg.end > carveEnd) result.push({ ...seg, start: carveEnd });
    }
    segments = result;
  }

  for (const alloc of plan.allocations) {
    let srcCursor = 0;
    for (const range of alloc.ranges) {
      const data = { type: 'new', allocName: alloc.name, srcStart: srcCursor };
      if (range.byteOffset >= plan.originalBoundary) {
        // Pure append -- guaranteed not to overlap anything already placed.
        segments.push({ ...data, start: range.byteOffset, end: range.byteOffset + range.byteLength });
      } else {
        carve(range.byteOffset, range.byteLength, data);
      }
      srcCursor += range.byteLength;
    }
  }

  segments.sort((a, b) => a.start - b.start);
  return segments;
}

/**
 * Streams the final edited super.img as a sequence of segments covering
 * the whole new file: unchanged original bytes (with only the metadata
 * slots patched -- geometry itself is never touched) interleaved with
 * replacement/new partition content wherever it was allocated into reused
 * freed space, followed by any remaining content that had to be appended
 * as brand new space. Every byte not explicitly part of an edit keeps its
 * exact original file offset.
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

  const allocBySizeBytes = new Map(plan.allocations.map((a) => [a.name, a.sizeBytes]));
  const segments = buildSegments(plan);

  for (const seg of segments) {
    let pos = seg.start;
    while (pos < seg.end) {
      const take = Math.min(pieceSize, seg.end - pos);
      if (seg.type === 'original') {
        try {
          const base = await disk.read(pos, take);
          yield applyPatches(base, pos, patchSet.patches);
        } catch (err) {
          if (err.sourceLabel === undefined) err.sourceLabel = 'the original super.img';
          throw err;
        }
      } else {
        const srcOffset = seg.srcStart + (pos - seg.start);
        const realSize = allocBySizeBytes.get(seg.allocName) ?? 0;
        if (srcOffset >= realSize) {
          // Past the real uploaded content -- this is sector-alignment padding.
          yield new Uint8Array(take);
        } else if (srcOffset + take <= realSize) {
          try {
            yield await sources.get(seg.allocName)(srcOffset, take);
          } catch (err) {
            if (err.sourceLabel === undefined) err.sourceLabel = `the replacement/new content for "${seg.allocName}"`;
            throw err;
          }
        } else {
          // This piece straddles the real-content/padding boundary.
          const realPart = realSize - srcOffset;
          let realBytes;
          try {
            realBytes = await sources.get(seg.allocName)(srcOffset, realPart);
          } catch (err) {
            if (err.sourceLabel === undefined) err.sourceLabel = `the replacement/new content for "${seg.allocName}"`;
            throw err;
          }
          const out = new Uint8Array(take);
          out.set(realBytes, 0);
          yield out;
        }
      }
      pos += take;
    }
  }
}
