import { partitionExtentRanges } from './lp.js';
import { applyPatches } from './patchset.js';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function toSafeNumber(big, what) {
  if (big > MAX_SAFE) {
    throw new Error(`${what} (${big}) exceeds what this tool can address.`);
  }
  return Number(big);
}

/**
 * Streams one logical partition's bytes out to `sink` (an object with
 * async write(Uint8Array) and close()/abort() methods), without ever
 * holding the whole partition in memory.
 *
 * @param {import('./virtual-disk.js').VirtualDisk} disk
 * @param {object} meta parsed LP metadata (from lp.js readMetadata)
 * @param {object} partition one entry of meta.partitions
 * @param {object} sink { write, close, abort }
 * @param {object} [opts]
 * @param {number} [opts.pieceSize]
 * @param {(writtenBytes:bigint, totalBytes:bigint)=>void} [opts.onProgress]
 * @param {()=>boolean} [opts.isCancelled]
 */
export async function extractPartition(disk, meta, partition, sink, opts = {}) {
  const { pieceSize = 16 * 1024 * 1024, onProgress, isCancelled } = opts;
  const ranges = partitionExtentRanges(meta, partition);
  const totalBytes = ranges.reduce((acc, r) => acc + r.byteLength, 0n);
  let written = 0n;

  const checkCancelled = () => {
    if (isCancelled && isCancelled()) {
      const err = new Error('Extraction cancelled.');
      err.cancelled = true;
      throw err;
    }
  };

  try {
    for (const range of ranges) {
      if (range.type === 'zero') {
        let remaining = range.byteLength;
        while (remaining > 0n) {
          checkCancelled();
          const take = remaining < BigInt(pieceSize) ? remaining : BigInt(pieceSize);
          await sink.write(new Uint8Array(toSafeNumber(take, 'chunk size')));
          written += take;
          remaining -= take;
          onProgress && onProgress(written, totalBytes);
        }
        continue;
      }

      if (range.targetSource !== 0) {
        throw new Error(
          `Partition "${partition.name}" has an extent on block device #${range.targetSource}, ` +
            `but only the primary super image (block device #0) was loaded. Load the matching ` +
            `additional image to extract this partition.`
        );
      }

      const offset = toSafeNumber(range.byteOffset, 'extent offset');
      const length = toSafeNumber(range.byteLength, 'extent length');
      for await (const buf of disk.streamRange(offset, length, pieceSize)) {
        checkCancelled();
        await sink.write(buf);
        written += BigInt(buf.length);
        onProgress && onProgress(written, totalBytes);
      }
    }
    await sink.close();
  } catch (err) {
    if (sink.abort) {
      try {
        await sink.abort();
      } catch {
        /* ignore secondary error */
      }
    }
    throw err;
  }

  return written;
}

/**
 * Shared logic behind makePartitionReader/makePartitionWriter: resolves a
 * partition's LP extents into an ordered table of logical-byte-range
 * segments, each tagged with its absolute disk byte offset (for 'linear'
 * extents) so partition-relative offsets can be translated in both
 * directions.
 */
function buildRangeTable(partition, rawRanges) {
  let cursor = 0;
  const ranges = rawRanges.map((r) => {
    const byteLength = toSafeNumber(r.byteLength, 'extent length');
    const range = {
      type: r.type,
      byteLength,
      logicalStart: cursor,
      logicalEnd: cursor + byteLength,
      targetSource: r.targetSource,
      byteOffset: r.type === 'linear' ? toSafeNumber(r.byteOffset, 'extent offset') : undefined,
    };
    cursor += byteLength;
    return range;
  });
  return { ranges, totalLength: cursor };
}

function findRangeIndex(ranges, pos) {
  return ranges.findIndex((r) => pos < r.logicalEnd);
}

/**
 * Builds a `readRange(offset, length) => Promise<Uint8Array>` function whose
 * offsets are relative to the start of one logical partition, backed
 * directly by the partition's LP extents on the loaded virtual disk — no
 * extraction-to-file needed first. Used by the security scanner to read
 * filesystem structures (superblocks, inodes, directory blocks, file
 * contents) straight out of a partition's byte range.
 *
 * Mirrors extractPartition's extent-walking logic and scope decision: an
 * extent referencing a secondary block device (targetSource !== 0) throws,
 * since only the primary loaded image is available.
 *
 * @param {import('./virtual-disk.js').VirtualDisk} disk
 * @param {object} meta
 * @param {object} partition
 * @param {import('./patchset.js').PatchSet} [patchSet] optional — if given,
 *   reads are overlaid with any patches already recorded (in absolute disk
 *   offsets), so edits made earlier in the same removal session are visible
 *   to subsequent reads (e.g. removing two sibling APKs from one directory).
 */
export function makePartitionReader(disk, meta, partition, patchSet) {
  const { ranges, totalLength } = buildRangeTable(partition, partitionExtentRanges(meta, partition));

  const diskRead = patchSet
    ? async (offset, length) => applyPatches(await disk.read(offset, length), offset, patchSet.patches)
    : (offset, length) => disk.read(offset, length);

  return async function readRange(offset, length) {
    if (offset < 0 || length < 0 || offset + length > totalLength) {
      throw new Error(
        `Partition "${partition.name}" read out of range: offset=${offset} length=${length} size=${totalLength}`
      );
    }
    const out = new Uint8Array(length);
    if (length === 0) return out;
    let filled = 0;
    let pos = offset;
    let idx = findRangeIndex(ranges, pos);
    while (filled < length) {
      const r = ranges[idx];
      const segEnd = Math.min(offset + length, r.logicalEnd);
      const segLen = segEnd - pos;
      if (r.type === 'zero') {
        // out is already zero-initialized
      } else {
        if (r.targetSource !== 0) {
          throw new Error(
            `Partition "${partition.name}" has an extent on block device #${r.targetSource}, but only the ` +
              `primary super image (block device #0) was loaded; cannot scan this partition.`
          );
        }
        const diskOffset = r.byteOffset + (pos - r.logicalStart);
        const bytes = await diskRead(diskOffset, segLen);
        out.set(bytes, filled);
      }
      filled += segLen;
      pos += segLen;
      idx++;
    }
    return out;
  };
}

/**
 * Builds a `writeRange(offset, bytes)` function whose offsets are relative
 * to the start of one logical partition. Rather than mutating anything, it
 * translates the partition-relative write into one or more absolute
 * disk-offset patches recorded into `patchSet` — the original (immutable,
 * File-backed) disk is never touched; the edit only becomes real bytes when
 * the patched disk is later streamed out via streamPatchedDisk().
 *
 * Throws if the write would land on a 'zero' (dm-zero) extent, or on a
 * secondary block device — neither should ever happen for our use case
 * (patching bytes inside already-allocated filesystem metadata blocks).
 *
 * @param {import('./virtual-disk.js').VirtualDisk} disk
 * @param {object} meta
 * @param {object} partition
 * @param {import('./patchset.js').PatchSet} patchSet
 */
export function makePartitionWriter(disk, meta, partition, patchSet) {
  const { ranges, totalLength } = buildRangeTable(partition, partitionExtentRanges(meta, partition));

  return function writeRange(offset, bytes) {
    const length = bytes.length;
    if (offset < 0 || length < 0 || offset + length > totalLength) {
      throw new Error(
        `Partition "${partition.name}" write out of range: offset=${offset} length=${length} size=${totalLength}`
      );
    }
    if (length === 0) return;
    let pos = offset;
    let idx = findRangeIndex(ranges, pos);
    while (pos < offset + length) {
      const r = ranges[idx];
      const segEnd = Math.min(offset + length, r.logicalEnd);
      const segLen = segEnd - pos;
      if (r.type === 'zero') {
        throw new Error(
          `Partition "${partition.name}" write at offset ${pos} would land on an unallocated (dm-zero) extent; refusing.`
        );
      }
      if (r.targetSource !== 0) {
        throw new Error(
          `Partition "${partition.name}" has an extent on block device #${r.targetSource}, but only the ` +
            `primary super image (block device #0) was loaded; cannot patch this partition.`
        );
      }
      const diskOffset = r.byteOffset + (pos - r.logicalStart);
      const srcStart = pos - offset;
      patchSet.addPatch(diskOffset, bytes.subarray(srcStart, srcStart + segLen));
      pos += segLen;
      idx++;
    }
  };
}
