// A tiny "patch overlay" abstraction: records small, sparse byte edits
// against absolute offsets of the loaded virtual disk, without ever
// mutating the original (immutable, File-backed) VirtualDisk. Used by the
// removal/repack feature so that:
//   - reads made *during* removal (e.g. a second app being removed from the
//     same directory block as a first) see previously-made edits, and
//   - the final "download patched super.img" step can stream the whole
//     disk back out, byte for byte identical to the original except for the
//     recorded patches.
//
// Deliberately NOT a general-purpose diff/journal: patches are small
// (directory blocks, inode fields) and few in number (at most a handful per
// removed app), so a linear scan per read is fast enough and keeps this
// code simple and easy to audit.

export class PatchSet {
  constructor() {
    /** @type {Array<{offset:number, bytes:Uint8Array}>} absolute disk offsets, insertion order */
    this.patches = [];
  }

  /** Records a patch. Later patches win over earlier ones on overlap. */
  addPatch(offset, bytes) {
    if (offset < 0) throw new Error(`PatchSet.addPatch: negative offset ${offset}`);
    if (!(bytes instanceof Uint8Array)) throw new Error('PatchSet.addPatch: bytes must be a Uint8Array');
    this.patches.push({ offset, bytes });
  }

  get count() {
    return this.patches.length;
  }
}

/**
 * Overlays `patches` (absolute disk offsets, insertion order, later wins) on
 * top of `base`, a buffer that itself represents [baseOffset, baseOffset +
 * base.length) of the disk. Returns a new Uint8Array; never mutates `base`.
 */
export function applyPatches(base, baseOffset, patches) {
  if (patches.length === 0) return base;
  const bufEnd = baseOffset + base.length;
  let out = null;
  for (const p of patches) {
    const pEnd = p.offset + p.bytes.length;
    const overlapStart = Math.max(baseOffset, p.offset);
    const overlapEnd = Math.min(bufEnd, pEnd);
    if (overlapStart >= overlapEnd) continue;
    if (out === null) out = new Uint8Array(base); // copy-on-first-overlap
    const srcStart = overlapStart - p.offset;
    const dstStart = overlapStart - baseOffset;
    out.set(p.bytes.subarray(srcStart, srcStart + (overlapEnd - overlapStart)), dstStart);
  }
  return out === null ? base : out;
}

/**
 * Wraps a VirtualDisk's `read` with a patch overlay. Offsets/lengths are in
 * absolute disk-byte space (same space PatchSet offsets are recorded in).
 */
export function createPatchedDiskReader(disk, patchSet) {
  return async function readPatched(offset, length) {
    const base = await disk.read(offset, length);
    return applyPatches(base, offset, patchSet.patches);
  };
}

/**
 * Async generator yielding the whole patched disk, sequentially, in pieces
 * of at most `pieceSize` bytes — suitable for streaming straight to a save
 * sink without holding the whole (possibly multi-GB) disk in memory.
 */
export async function* streamPatchedDisk(disk, patchSet, pieceSize = 16 * 1024 * 1024) {
  let pos = 0;
  while (pos < disk.totalSize) {
    const take = Math.min(pieceSize, disk.totalSize - pos);
    const base = await disk.read(pos, take);
    yield applyPatches(base, pos, patchSet.patches);
    pos += take;
  }
}
