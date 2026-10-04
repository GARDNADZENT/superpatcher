# Super.img Unpacker

A 100%-client-side web app that extracts Android dynamic-partition `super.img`
images (the "LP" / logical-partition format used since Android 10) directly
in the browser — no backend, no upload. Partitions are streamed straight to
a folder on your device via the **File System Access API**, so multi-gigabyte
images don't need to fit in RAM or ever touch a server.

## Features

- **Android sparse image decoding** (`CHUNK_TYPE_RAW/FILL/DONT_CARE/CRC32`),
  implemented as a lazy index over the source file(s) — bytes are only read
  on demand, never fully materialized in memory.
- **Multi-part images**: select `super.img` + `super_1.img` + ... (as
  produced when a sparse super image is split for fastboot flashing) and
  they're transparently concatenated in the right order.
- **LP (liblp) metadata parsing**: geometry block, primary/backup metadata
  header + partition/extent/group/block-device tables, with SHA-256
  checksum verification and automatic primary→backup fallback.
- Lists every logical partition with its size and attributes
  (readonly / slot-suffixed / updated / disabled), with checkboxes to pick
  which ones to extract.
- Supports `LINEAR` extents (the normal case) and `ZERO` (dm-zero) extents.
- Multiple metadata slots (A/B devices) are selectable from a dropdown.
- **Saving**, in order of preference:
  1. `showDirectoryPicker()` — pick one output folder, every partition is
     streamed into it as `<name>.img`. Best option, works for any size.
  2. `showSaveFilePicker()` — per-file "Save As" dialog, still streamed.
  3. Classic `<a download>` + `Blob` — universal fallback; buffers the whole
     partition in memory first, so it's only recommended for smaller
     partitions in browsers without the File System Access API (e.g. Firefox,
     Safari).
- Live per-partition progress bars, a running log, and cancellation.
- **Security scan: find Device Administrator-capable & security-plugin-like
  APKs.** Reads directly from a selected partition's filesystem (ext4 or
  EROFS, auto-detected from the superblock — no extraction-to-disk required
  first), walks its directory tree, finds every `.apk`, and parses each
  one's compiled `AndroidManifest.xml` to flag any app that can register as
  an Android [Device Administrator](https://developer.android.com/work/dpc/dedicated-devices/receiver-provisioning)
  (the mechanism behind unremovable "security plugin"-style bloatware, as
  well as legitimate MDM apps). A separate, looser naming heuristic also
  flags apps whose package/label/folder name looks security- or
  plugin-related. Scanning itself never modifies anything.
- **Remove flagged apps & build a patched `super.img`.** For apps found
  during the scan, the tool can delete their files directly from the
  in-memory filesystem image (ext4 or EROFS) and stream out a new, patched
  `super.img` of the same size, ready to `fastboot flash super`. See
  [Removing flagged apps](#removing-flagged-apps--building-a-patched-superimg)
  below for exactly what this does and does **not** handle (notably: no
  AVB/dm-verity/vbmeta handling).

## Getting started

```bash
npm install
npm run dev      # starts a Vite dev server
```

Then open the printed local URL in **Chrome, Edge, or another
Chromium-based browser** for full folder-saving support. Two ready-made test
images are included:
- `sample-data/super.img` — 3 fake partitions (`boot`, `system`, `vendor`)
  with synthetic (non-filesystem) bytes, for exercising the sparse/LP
  extraction flow.
- `sample-data/super_demo.img` — 2 partitions (`system_a` on real ext4,
  `product_a` on real EROFS), each containing real APKs including one that
  registers as a Device Administrator — use this one to try out the
  "4. Security scan" and "5. Remove flagged apps" features end-to-end.
  Regenerate it any time with `node test/build-demo-super.mjs`.

```bash
npm run build     # production build to dist/
npm test          # Node-based unit tests for the binary parsers
```

## How it works

```
src/
├── sparse.js        Android sparse image chunk indexer
├── virtual-disk.js  Presents one or more (sparse) files as one seekable,
│                    streamable "unsparsed" virtual disk
├── lp.js            liblp metadata format: geometry, header, partition/
│                    extent/group/block-device tables, checksum verification
├── extractor.js      Resolves a partition's extents and streams its bytes;
│                    also exposes makePartitionReader()/makePartitionWriter()
│                    for random-access reads/writes straight off a
│                    partition's extents (used by the scanner/remover, no
│                    extraction-to-disk needed; writes go through a PatchSet,
│                    never touching the original loaded file)
├── patchset.js        A small sparse "patch overlay": records removal edits
│                    as (absolute disk offset, bytes) pairs against the
│                    loaded disk without ever mutating the original
│                    (immutable, File-backed) source, so reads during
│                    removal see prior edits, and the final "build patched
│                    super.img" step streams the whole disk back out with
│                    all patches applied
├── saver.js          File System Access API sinks + Blob-download fallback
├── crc32c.js          Castagnoli CRC32 (used for ext4 metadata_csum and the
│                    EROFS superblock checksum, both recomputed after edits)
├── ext4.js             ext4 driver: superblock, 32/64-bit group descriptors,
│                    extent-tree block mapping, classic (linear, possibly
│                    multi-block) directory parsing — plus write support:
│                    removeDirEntry() patches a directory's dirent chain
│                    in place (merging the freed slot into a neighbor's
│                    rec_len, ext4's own on-disk convention) and recomputes
│                    any affected metadata_csum
├── erofs.js            EROFS driver: superblock, compact/extended inodes,
│                    FLAT_PLAIN/FLAT_INLINE file & directory reads — plus
│                    write support: removeDirEntry() rebuilds a directory's
│                    entire content from its surviving entries (EROFS has no
│                    per-entry slack to merge into, unlike ext4) and
│                    recomputes the whole-superblock CRC32-C checksum
├── zip.js             Minimal read-only ZIP reader (stored + deflate) for
│                    extracting AndroidManifest.xml out of APKs
├── axml.js            Parses compiled Android binary XML (AXML) to pull out
│                    the package name, app label, and Device Administrator
│                    receiver declarations from AndroidManifest.xml
├── scanner.js          Orchestrates the above: fs-type auto-detect -> walk
│                    -> .apk discovery -> zip+axml -> device-admin +
│                    security-plugin-name report, with a removalUnit
│                    (which directory/file to delete) attached per APK
└── main.js           UI wiring, including the "remove selected & build
                     patched super.img" flow
```

The on-disk layout `lp.js` parses (per AOSP's `liblp`):

```
[reserved 4096B] [geometry 4096B] [geometry backup 4096B]
[metadata slot 0] [metadata slot 1] ... [backup slot 0] [backup slot 1] ...
[logical partition data (referenced by extents) ...]
```

Each partition is a list of extents; a `LINEAR` extent points at a sector
range within a block device (for a single-file `super.img` there's normally
exactly one block device — the image itself), and a `ZERO` extent just means
"this region reads as zeroes" (no physical bytes are stored for it).
Extraction walks each partition's extents in order and streams the
corresponding bytes (or synthesized zeros) to the output sink in bounded
chunks (default 16 MiB), so memory use stays flat regardless of partition
size.

Format references (AOSP, Apache-2.0):
- `system/core/libsparse/sparse_format.h`
- `system/core/fs_mgr/liblp/include/liblp/metadata_format.h`
- `system/core/fs_mgr/liblp/reader.cpp`, `utility.cpp`

## How the security scan works

For each selected partition, `scanner.js` reads the first bytes at file
offset 1024 and checks for an ext4 magic (`0xEF53` at superblock offset
0x38) or an EROFS magic (`0xE0F5E1E2` at the very start of the superblock)
to pick the right driver — no filesystem type needs to be specified by hand.
It then walks the directory tree from the root inode, and for every `.apk`
found, reads its bytes straight out of the partition (via `ext4.js`/
`erofs.js`), opens it as a ZIP (`zip.js`), extracts `AndroidManifest.xml`,
and parses the compiled binary XML (`axml.js`) looking for a `<receiver>`
with `android:permission="android.permission.BIND_DEVICE_ADMIN"` and/or an
`android.app.action.DEVICE_ADMIN_ENABLED` intent-filter action — the
standard way an app registers a
[`DeviceAdminReceiver`](https://developer.android.com/reference/android/app/admin/DeviceAdminReceiver).
Each APK is reported as `deviceAdmin: yes / no / unknown` (the latter when
its contents couldn't be read at all, e.g. unsupported compression — see
below), with its package name, app label, and the matching receiver's class
name when applicable.

Separately, `looksLikeSecurityPlugin` runs a looser, best-effort regex over
each APK's package name, app label, and containing folder/file name
(`security`, `admin`, `polic(y|ies)`, `mdm`, `plugin`, `guard`, `protect`,
...). It's a naming *hint* meant to also catch apps like a hypothetical
`com.example.spl` shipped in a folder literally called `SomeVendorPlugin` —
expect both false positives and false negatives; it is independent of, and
additional to, the precise manifest-based Device Administrator check.

**Scope decisions for this feature** (deliberate, not oversights):
- **ext4: no htree directory index traversal.** Android `super.img`
  partitions are built by offline `mkfs`-style tooling, which always lays
  out directories linearly (classic/linear dirents) even when the on-disk
  `dir_index` feature bit is set — htree is only ever constructed
  incrementally by a live, long-running kernel growing a directory, which
  never happens to a prebuilt system image. Verified empirically against a
  300+-entry ext4 test directory built with `mkfs.ext4 -d`, which still came
  out as a classic multi-block linear directory. If an htree-flagged
  directory is nonetheless encountered, the scanner still reads whatever is
  linearly parseable and surfaces a warning rather than failing outright.
- **EROFS: no compressed-inode decompression.** Fully supporting EROFS's
  compressed data layouts (`COMPRESSED_FULL`/`COMPRESSED_COMPACT`) requires
  first implementing its per-lcluster index table decoding, then an
  LZ4/LZMA decompressor — a substantial sub-project on its own. This build
  fully supports uncompressed layouts (`FLAT_PLAIN`, `FLAT_INLINE`, which
  covers the large majority of real-world system/product images, including
  ones built with `mkfs.erofs`'s default settings). A compressed APK is
  still *listed* (directories are always uncompressed) but reported as
  `deviceAdmin: unknown` with a clear note, instead of crashing the scan or
  silently skipping it.
- **No ZIP64 support** in `zip.js` — irrelevant for APKs, which are always
  well under the 4 GiB ZIP64 threshold.

## Removing flagged apps & building a patched super.img

⚠️ **Read this before flashing anything.** This feature can produce a
`super.img` that **fails to boot** unless you separately handle Android
Verified Boot. Keep a backup of your original `super.img`.

After a scan, each APK with a `removalUnit` gets a checkbox (pre-checked for
`deviceAdmin: yes` and security-plugin-name matches). Clicking "Remove
selected & build patched super.img":

1. Calls `volume.removeDirEntry(parentInode, entryName)` for each selected
   app's removal unit. This is computed by the scanner as:
   - the APK's own dedicated containing folder (e.g. `ScorpioSecurity/` in
     `/system/app/ScorpioSecurity/ScorpioSecurity.apk`) — the universal
     Android packaging convention, and what's removed in the overwhelming
     majority of cases; or
   - just the `.apk` file itself, if it's found loose directly inside a
     shared container directory (`app/`, `priv-app/`, `overlay/`, etc. —
     never removed as a whole, since that would delete every app in it).
2. Every edit is recorded in a `PatchSet` as `(absolute offset, bytes)`
   pairs — the original loaded file is **never** mutated, so a failed or
   cancelled run leaves nothing changed. Both `ext4.js` and `erofs.js`
   additionally recompute any affected on-disk checksums (ext4
   `metadata_csum` on the touched directory block/inode; the EROFS
   whole-superblock CRC32-C when the compat feature bit is set), verified
   against real `e2fsck`/`fsck.erofs` oracles in `test/`.
3. "Build patched super.img" streams the *entire* original disk back out
   (`streamPatchedDisk`) with all recorded patches applied, through the same
   folder/file-picker/Blob sinks used for extraction.

**Deliberate, minimal-risk design choices** (prioritizing "don't corrupt the
filesystem" over "reclaim space"):
- **Never frees inodes or data blocks.** The removed app's inode and blocks
  are simply abandoned (unlinked from their directory, left allocated but
  unreferenced) rather than updating the free-space bitmaps/counters. This
  is why `e2fsck -fn` reports (and this project's tests explicitly expect
  and whitelist) harmless "Unattached inode" / "Block bitmap differences" /
  "Inode bitmap differences" / "Directories count wrong" findings on a
  patched image — these are inert, pre-existing-pattern-safe leftovers,
  never a checksum mismatch or structural corruption.
- **Never resizes partitions or touches LP metadata.** The patched image is
  byte-for-byte the same size and partition layout as the original; only
  bytes inside already-allocated filesystem metadata (directory blocks,
  inode fields, superblock checksums) are patched.
- **No AVB / dm-verity / vbmeta handling, by design.** Changing partition
  contents breaks its dm-verity hash tree and/or AVB hash descriptor. This
  tool does not disable verity, strip AVB, or re-sign `vbmeta` — that
  remains an entirely separate, manual, device-specific step you must do
  yourself (typically something like
  `fastboot --disable-verity --disable-verification flash vbmeta vbmeta.img`
  on an unlocked bootloader) if you want the patched `super.img` to actually
  boot. This caveat is also shown directly in the UI before you can remove
  anything.
- **No EROFS compressed-inode editing.** Only `FLAT_PLAIN`/`FLAT_INLINE`
  directories/files can be removed (matches the scan's own read support,
  above); a compressed APK can't currently be auto-removed.

## Known limitations

- Only block device index 0 (the image(s) you actually loaded) can be read.
  If a `super.img` declares multiple physical block devices (seen on some
  "retrofit" A/B devices with separate `super` / `super_other` images) and a
  partition's extent points at a device you didn't load, that partition will
  fail to extract (or be scanned) with a clear error message.
- Sparse major version must be `1` (the only version ever shipped) and LP
  metadata major version must be `10` (current and, to date, only version).
- The File System Access API (true "save to folder") is Chromium-only today;
  other browsers fall back to per-file save dialogs or in-memory downloads.
- Filesystems other than ext4/EROFS (e.g. F2FS, which some older or
  vendor-specific devices use for `super` sub-partitions) aren't recognized
  by the scanner and are skipped with a warning.
- Removal/patching does not touch AVB/dm-verity/vbmeta (see above) — a
  patched image generally will not boot as-is on a device with verified
  boot enforced, until you separately handle that yourself.
- Removal does not reclaim storage space; the patched `super.img` is the
  same size as the original with the removed app's blocks left allocated
  but unreferenced.

## License

MIT for this project's code. Re-implements publicly documented AOSP
on-disk formats (Apache-2.0 licensed headers were used only as a reference
for field layouts/offsets, not copied as code).
