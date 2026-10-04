// Full end-to-end integration test of the actual pipeline main.js drives:
// VirtualDisk (raw/non-sparse file) -> makePartitionReader/makePartitionWriter
// (LP extent-aware, patch-overlay-backed) -> scanAllPartitions (finds +
// classifies APKs, attaches removalUnit + volume) -> volume.removeDirEntry
// (records patches, doesn't touch the original file) -> streamPatchedDisk
// (replays the whole disk with patches applied) -> independent e2fsck oracle
// on the final bytes.
//
// This exercises the glue (buildRangeTable/extent math, PatchSet threading)
// that the more targeted ext4-write/erofs-write/scanner-removal tests don't
// cover, since those talk to Ext4Volume/ErofsVolume/scanner directly against
// a single flat buffer instead of through the LP-partition abstraction.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { indexSparseOrRaw } from '../src/sparse.js';
import { VirtualDisk } from '../src/virtual-disk.js';
import { makePartitionReader, makePartitionWriter } from '../src/extractor.js';
import { LP_SECTOR_SIZE, LP_TARGET_TYPE_LINEAR } from '../src/lp.js';
import { PatchSet, streamPatchedDisk } from '../src/patchset.js';
import { scanAllPartitions } from '../src/scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = (...parts) => path.join(__dirname, 'fixtures', ...parts);

/** Builds minimal fake LP metadata describing one partition that occupies
 * the entire (single) backing block device as one linear extent — enough
 * for partitionExtentRanges()/buildRangeTable() to resolve real offsets. */
function fakeMetaForWholeDisk(partitionName, sizeBytes) {
  const numSectors = BigInt(sizeBytes) / BigInt(LP_SECTOR_SIZE);
  return {
    extents: [{ target_type: LP_TARGET_TYPE_LINEAR, target_source: 0, target_data: 0n, num_sectors: numSectors }],
    partitions: [{ name: partitionName, num_extents: 1, first_extent_index: 0 }],
  };
}

function findBinary(names) {
  for (const candidate of names) {
    try {
      execFileSync(candidate, ['-V'], { stdio: 'pipe' });
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function runE2fsckOracle(buf) {
  const e2fsck = findBinary(['/usr/sbin/e2fsck', '/sbin/e2fsck', 'e2fsck']);
  if (!e2fsck) return null;
  const dir = await mkdtemp(path.join(tmpdir(), 'pipeline-removal-test-'));
  const imgPath = path.join(dir, 'patched.img');
  await writeFile(imgPath, buf);
  let output = '';
  try {
    execFileSync(e2fsck, ['-fn', imgPath], { stdio: 'pipe' });
  } catch (err) {
    output = (err.stdout || '').toString() + (err.stderr || '').toString();
  }
  await rm(dir, { recursive: true, force: true });
  return output;
}

// Same accepted-findings whitelist as test/ext4-write.test.js: the
// deliberate, documented trade-off of never freeing the removed
// inode/blocks or touching allocation bitmaps. Anything else (in
// particular any checksum mismatch) is a real bug.
const ACCEPTED_PATTERNS = [
  /^e2fsck \d/,
  /^Pass \d:/,
  /^Unconnected directory inode/,
  /^Connect to \/lost\+found\?/,
  /^'\.\.' in .* should be <The NULL inode>/,
  /^Fix\?/,
  /^Unattached inode/,
  /^Block bitmap differences:/,
  /^Inode bitmap differences:/,
  /^Directories count wrong for group/,
  /^\S+\.img: \*+ WARNING: Filesystem still has errors \*+$/,
  /^\S+\.img: \d+\/\d+ files/,
  /^$/,
];

function assertOnlyAcceptedFsckFindings(output, t) {
  if (output === null) return;
  const suspicious = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (ACCEPTED_PATTERNS.some((re) => re.test(trimmed))) continue;
    suspicious.push(trimmed);
  }
  if (suspicious.length) t.diagnostic(`Full e2fsck output:\n${output}`);
  assert.deepEqual(suspicious, [], 'e2fsck reported findings beyond the accepted orphan/bitmap leftovers');
  assert.ok(!/checksum/i.test(output), 'e2fsck reported a checksum problem — this is a real bug');
}

test('full pipeline: VirtualDisk -> partition reader/writer -> scan -> remove -> streamPatchedDisk -> e2fsck clean', async (t) => {
  const gz = await readFile(fixturePath('test.ext4.img.gz'));
  const raw = Buffer.from(gunzipSync(gz));
  const originalBytes = new Uint8Array(raw); // independent copy, kept pristine for comparison

  const file = new Blob([raw]);
  const index = await indexSparseOrRaw(file);
  assert.equal(index.sparse, false, 'a plain ext4 image is not itself sparse-formatted');

  const disk = new VirtualDisk([{ file, index }]);
  assert.equal(disk.totalSize, raw.length);

  const partitionName = 'system_a';
  const meta = fakeMetaForWholeDisk(partitionName, disk.totalSize);
  const partition = meta.partitions[0];
  const patchSet = new PatchSet();

  const partitions = [
    {
      name: partitionName,
      readRange: makePartitionReader(disk, meta, partition, patchSet),
      writeRange: makePartitionWriter(disk, meta, partition, patchSet),
    },
  ];

  const report = await scanAllPartitions(partitions);
  const partResult = report[0];
  assert.equal(partResult.fsType, 'ext4');
  assert.ok(partResult.volume, 'volume should be attached since writeRange was supplied');

  const scorpio = partResult.apks.find((a) => a.packageName === 'com.example.scorpiosecurity' && a.removalUnit.kind === 'folder');
  assert.ok(scorpio, 'ScorpioSecurity (in its own folder) should be found');
  assert.equal(scorpio.deviceAdmin, 'yes');
  assert.equal(scorpio.looksLikeSecurityPlugin, true);

  const removed = await partResult.volume.removeDirEntry(scorpio.removalUnit.parentInode, scorpio.removalUnit.entryName);
  assert.equal(removed, true);
  assert.ok(patchSet.count > 0, 'removal should have recorded at least one patch');

  // The original backing bytes must remain completely untouched — all edits
  // live only in the PatchSet overlay.
  const stillPristine = await file.slice(0, raw.length).arrayBuffer();
  assert.deepEqual(new Uint8Array(stillPristine), originalBytes);

  // Stream the whole patched disk back out and confirm it's independently
  // valid per e2fsck, and that re-scanning the final bytes directly (no
  // patch overlay involved, simulating "what the flashed partition will
  // actually contain") shows the app is gone.
  const pieces = [];
  for await (const chunk of streamPatchedDisk(disk, patchSet, 1024 * 1024)) {
    pieces.push(Buffer.from(chunk));
  }
  const patchedBuf = Buffer.concat(pieces);
  assert.equal(patchedBuf.length, raw.length, 'patched output must be the same total size (no resize)');

  const patchedU8 = new Uint8Array(patchedBuf.buffer, patchedBuf.byteOffset, patchedBuf.byteLength);
  const rescan = await scanAllPartitions([
    { name: partitionName, readRange: async (o, l) => patchedU8.subarray(o, o + l) },
  ]);
  assert.ok(!rescan[0].apks.some((a) => a.path === scorpio.path), "removed APK's path must be gone from the final patched bytes");
  assert.ok(rescan[0].apks.some((a) => a.packageName === 'com.example.plainapp'), 'sibling app unaffected');

  const fsckOutput = await runE2fsckOracle(patchedBuf);
  assertOnlyAcceptedFsckFindings(fsckOutput, t);
});
