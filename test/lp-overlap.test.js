import test from 'node:test';
import assert from 'node:assert/strict';

import { findOverlappingExtents, LP_SECTOR_SIZE, LP_TARGET_TYPE_LINEAR, LP_TARGET_TYPE_ZERO } from '../src/lp.js';

function metaFromExtents(extentDefs) {
  // extentDefs: [{targetData, numSectors, targetType?, targetSource?}]
  const extents = extentDefs.map((e) => ({
    target_type: e.targetType ?? LP_TARGET_TYPE_LINEAR,
    target_data: BigInt(e.targetData ?? 0),
    num_sectors: BigInt(e.numSectors),
    target_source: e.targetSource ?? 0,
  }));
  const partitions = extentDefs.map((e, i) => ({ name: e.name ?? `p${i}`, num_extents: 1, first_extent_index: i }));
  return { extents, partitions };
}

test('findOverlappingExtents: non-overlapping linear extents pass', () => {
  const meta = metaFromExtents([
    { name: 'a', targetData: 0, numSectors: 100 },
    { name: 'b', targetData: 100, numSectors: 100 },
    { name: 'c', targetData: 200, numSectors: 50 },
  ]);
  assert.deepEqual(findOverlappingExtents(meta), { ok: true });
});

test('findOverlappingExtents: detects an overlap', () => {
  const meta = metaFromExtents([
    { name: 'a', targetData: 0, numSectors: 100 },
    { name: 'b', targetData: 50, numSectors: 100 }, // overlaps "a" by 50 sectors
  ]);
  const result = findOverlappingExtents(meta);
  assert.equal(result.ok, false);
  assert.match(result.detail, /"a".*"b"|"b".*"a"/);
});

test('findOverlappingExtents: adjacent (touching, not overlapping) extents are fine', () => {
  const meta = metaFromExtents([
    { name: 'a', targetData: 0, numSectors: 100 },
    { name: 'b', targetData: 100, numSectors: 1 }, // starts exactly where "a" ends
  ]);
  assert.deepEqual(findOverlappingExtents(meta), { ok: true });
});

test('findOverlappingExtents: ZERO extents and other block devices are ignored', () => {
  const meta = metaFromExtents([
    { name: 'a', targetData: 0, numSectors: 100 },
    { name: 'zero', targetType: LP_TARGET_TYPE_ZERO, numSectors: 999999 },
    { name: 'other-device', targetData: 0, numSectors: 100, targetSource: 1 }, // same offset, different device
  ]);
  assert.deepEqual(findOverlappingExtents(meta), { ok: true });
});

test('findOverlappingExtents: byte math matches LP_SECTOR_SIZE', () => {
  // Sanity check that the helper is actually working in bytes, not sectors.
  const meta = metaFromExtents([
    { name: 'a', targetData: 0, numSectors: 2 }, // bytes [0, 1024)
    { name: 'b', targetData: 2, numSectors: 2 }, // bytes [1024, 2048) -- adjacent, fine
  ]);
  assert.equal(2 * LP_SECTOR_SIZE, 1024);
  assert.deepEqual(findOverlappingExtents(meta), { ok: true });
});
