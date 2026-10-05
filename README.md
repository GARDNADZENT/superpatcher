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
- **Also loads standalone raw partition images directly** (most commonly a
  GSI — Generic System Image — but equally a lone `vendor.img`/`product.img`
  pulled individually): these have no LP header at all (they're just one
  ext4/EROFS filesystem starting at byte 0), so rather than failing with
  "not a super.img", the app detects the filesystem directly and treats the
  whole file as one synthetic partition, named by sniffing the filename
  (`system`/`vendor`/`product`/`system_ext`, falling back to the bare
  filename). Every other feature — the partition table, extraction, the
  security scan, "remove flagged apps" — works on it exactly the same way
  as a real super.img partition; only "Remove Device Lock Components" is
  hidden for this case, since its three fixed target paths assume a real
  multi-partition dynamic image. See `src/raw-image.js`.
- Lists every logical partition with its size and attributes
  (readonly / slot-suffixed / updated / disabled), with checkboxes to pick
  which ones to extract.
- Supports `LINEAR` extents (the normal case) and `ZERO` (dm-zero) extents.
- Multiple metadata slots (A/B devices) are selectable from a dropdown.
- **Saving**, in order of preference:
  1. `showDirectoryPicker()` — pick one output folder up front (section 3's
     "Choose a specific output folder…" button), and every subsequent
     partition/build streams straight into it as `<name>.img`, with zero
     in-memory buffering regardless of size. Only available on Chromium
     with a real top-level tab (not embedded in an iframe, and not on
     Firefox/Safari/most mobile browsers) — look for the "Open in a new
     tab" link shown when this isn't available.
  2. **Explicit download link (the default whenever no folder was
     chosen).** The file is built fully in memory, then a real, clickable
     "⬇ Download `<name>`" link appears (plus a "Save As…" button when the
     File System Access save-file picker is available, for explicitly
     choosing a destination folder/filename). Nothing is auto-triggered —
     you decide when and how to save, and can simply click the link again
     if a save attempt is ever interrupted. This is the standard,
     universally-supported `<a download>` + `Blob` browser download
     mechanism, so it honors your browser's own "ask where to save each
     file" setting if you have that turned on.
- Live per-partition progress bars (with periodic 25%-step log lines, not
  just a silent bar), a running log that narrates every step of a build —
  hashing, per-target verification, per-chunk build progress, each
  validation check, and report writing all get their own log line — and
  cancellation.
- **Browse files**: open any partition's filesystem (ext4 or EROFS,
  auto-detected) and navigate its directory tree directly in the browser —
  breadcrumbs, folder-by-folder navigation, file type/size per entry — and
  download any individual file on its own, without having to extract the
  whole partition first just to see what's inside it or pull out one file.
- **Edit & merge partitions**: delete partitions you don't want, replace one
  with your own custom-built image (e.g. swap in your own `system`), or add
  a brand new partition — then build a new `super.img` reflecting those
  changes. Unlike every other removal feature in this app, this one *does*
  relay out the dynamic-partition table (recomputing extents/sizes), since
  a replacement image is essentially never exactly the same size as the
  original — a space-reclaiming allocator reuses whatever a delete/replace
  freed up before resorting to appending brand new space, so swapping in a
  differently-sized image doesn't necessarily grow the output at all. An
  optional "output as Android sparse image" checkbox produces a real
  multi-chunk sparse file (what `fastboot flash super` actually expects —
  a raw image can be rejected outright even at the correct size), usually
  much smaller than raw too. See
  [Edit & merge partitions](#edit--merge-partitions) below for exactly how
  the relayout/reuse and sparse encoding work and what they do and don't
  guarantee.
- **Handles the browser's `NotReadableError` on very large loaded files as
  well as it realistically can.** Every raw byte read from a loaded
  File/Blob (`src/file-read-retry.js`) retries briefly (a handful of
  attempts, short exponential backoff) on the specific `NotReadableError`
  ("the requested file could not be read, typically due to permission
  problems...") that can surface during a long multi-gigabyte read.
  Per the File API spec this error covers two different situations that
  look identical in JS: a genuinely transient concurrent lock (e.g.
  antivirus briefly scanning the file), which a short retry can ride out,
  and the File's underlying snapshot having gone *permanently* stale for
  the rest of the page's lifetime (a well-documented real-world issue,
  especially for files above a couple of GB) — which no amount of retrying
  the same File object can ever fix. Retries are deliberately brief rather
  than extremely patient, since blindly retrying for minutes doesn't help
  the second case and this app works with exactly the large files where
  that case is common. If every retry is exhausted, the error is replaced
  with a specific, actionable explanation naming exactly which loaded file
  failed to read and why reloading the page and re-selecting the file(s)
  fresh (right before building, not long before) is the real fix for a
  stale reference — plus the usual other suspects (cloud-sync placeholder
  files, antivirus, system sleep) worth ruling out too.
- **Sets expectations for the browser's own slow "finalize" step when
  saving a large file into a chosen folder.** When writing through the File
  System Access API (`showDirectoryPicker()`), the browser stages every
  write into a hidden `<name>.crswap` temp file and only does the real
  work — scanning that whole temp file and atomically renaming it into
  place — when you `close()` the stream. This is a documented, currently
  unfixed browser behavior (not something this app's code controls) that
  can take anywhere from under a minute to tens of minutes for
  multi-gigabyte files, especially on slower drives or with antivirus
  scanning the finished file. Rather than leaving you watching a
  "finalizing…" message with zero feedback, this app warns up front when a
  large file is about to be saved this way, and logs periodic "still
  finalizing, this is normal" reassurance every 20 seconds while it's
  happening, so a long wait doesn't look identical to a frozen tab. If you'd
  rather avoid this step entirely, don't choose an output folder for very
  large builds — the download-link path doesn't go through
  `FileSystemWritableFileStream` at all (at the cost of needing enough free
  memory to hold the whole file first).
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
- **"Remove Device Lock Components"**: a separate, narrower action that
  deletes three specific, hardcoded APKs by their exact path — regardless
  of what the scan reports — for the case where the scan can't read a
  target's content at all. See
  [Remove Device Lock Components](#remove-device-lock-components-fixed-targets)
  below. Also available as a standalone CLI script
  (`scripts/remove-device-lock-components.mjs`) for automation/testing.

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
├── lp-writer.js       The write-side counterpart of lp.js: encodes a
│                    partition/extent/group/block-device table set back
│                    into the exact on-disk header+tables byte layout
│                    lp.js reads -- used by partition-editor.js to rebuild
│                    metadata after a delete/replace/add edit
├── partition-editor.js "Edit & merge partitions": plans a delete/replace/add
│                    edit against an already-parsed super.img (space-
│                    reclaiming first-fit allocator reusing freed extents
│                    before appending new space, validating group capacity
│                    and metadata-slot-size limits up front) and streams
│                    the rebuilt image -- geometry untouched, every
│                    untouched/abandoned byte copied verbatim, only the
│                    metadata slots and newly-allocated partition content
│                    actually change
├── sparse-encode.js   Streaming Android sparse-image encoder (the write-side
│                    counterpart of sparse.js's decoder) -- classifies the
│                    source in a first pass (RAW/FILL/DONT_CARE, no bytes
│                    kept) so the sparse header's chunk count can be written
│                    correctly up front, then re-streams it a second time to
│                    actually emit the encoded output; used by "Edit & merge
│                    partitions" (and the other build features) whenever
│                    "output as Android sparse image" is checked
├── raw-image.js      Fallback for standalone raw partition images (no LP
│                    header at all, e.g. a GSI system.img): detects the
│                    ext4/EROFS filesystem directly and synthesizes a
│                    single-partition geo/meta pair in the exact shape
│                    lp.js normally produces, so every other feature works
│                    on it unmodified
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
├── stream-download.js  An automatic, no-folder-picker streaming-download
│                    sink (built on public/stream-download-sw.js, a small
│                    service worker) -- implemented, unit-tested, and kept
│                    in the repo, but NOT currently wired into the default
│                    save flow: it produced "Disk full" download-manager
│                    failures in some real browser/OS combinations in
│                    practice, which is worse than the current explicit
│                    download-link flow in main.js. Available for future
│                    use/revisiting if that turns out to be worth chasing
│                    down further.
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

Once a scan finishes, a **search box** appears above the results to filter
the (potentially very long) table live by path, package name, app label, or
partition name — useful for jumping straight to a known app on a partition
with hundreds of APKs. A **"Selected APKs" panel** below the results always
shows exactly which apps are currently checked (updating live as you
(un)check boxes), so you can review the full removal list before clicking
"Remove selected" without having to scroll back through the whole table.

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
- **Removal only requires the *containing directory* to be
  `FLAT_PLAIN`/`FLAT_INLINE`** — `removeDirEntry()` edits the parent
  directory's dirent list, never the removed file's own data, so a
  **compressed APK can still be removed** even though the scanner can't
  read its manifest content (see ["Remove Device Lock
  Components"](#remove-device-lock-components-fixed-targets) below, which
  exercises exactly this: all three of its hardcoded targets are built as
  `COMPRESSED_COMPACT` EROFS inodes and are still cleanly removed). The
  only thing actually blocked is removing an entry whose *parent
  directory itself* is compressed — directories are essentially never
  worth compressing, so real-world images don't hit this.

## Remove Device Lock Components (fixed targets)

This is a **separate, narrower action** from the general scan-and-remove
feature above — not a replacement for it. It exists for one specific,
real-world case: a scan that reports `deviceAdmin: unknown` / 0 findings
for an app because its APK is stored as a compressed EROFS inode the
scanner can't decompress and read. **Directory listings work regardless of
compression — only reading a file's *content* is affected** — so this
action locates and removes files by their exact, known path instead of
relying on the scan's (content-dependent) findings at all.

It removes exactly these three files, and nothing else, ever:

| Partition      | Path                                              | Package                  |
|----------------|----------------------------------------------------|---------------------------|
| `product_a`    | `priv-app/SecurityCom/SecurityCom.apk`             | `com.scorpio.securitycom` |
| `system_ext_a` | `app/TranPluginApp/TranPluginApp.apk`              | `com.transsion.spl`       |
| `system_ext_a` | `app/TranDaemonApp/TranDaemonApp.apk`              | `com.transsion.spld`      |

**Workflow** (identical in the UI's "6. Remove Device Lock Components" card
and in `scripts/remove-device-lock-components.mjs`, both built on the same
`src/device-lock-removal.js` core module):

1. Parse the loaded `super.img`'s LP metadata as usual.
2. Open `product_a` and `system_ext_a` read-through-patch and confirm both
   are EROFS (required — this action is hardcoded to this exact partition
   layout; it refuses to proceed, unmodified, if either is missing or isn't
   EROFS).
3. **Verify all three target files exist at their exact path — by walking
   directory entries directly, never via the scanner — before touching
   anything.** If even one is missing, the whole operation **stops**
   immediately with no files written and names exactly which target(s)
   couldn't be found (this is a strict two-phase verify-then-remove: even
   if 2 of 3 are found, finding the 3rd missing still aborts with zero
   changes made).
4. Remove only each target `.apk` file's own directory entry from its
   immediate parent folder (`removeDirEntry`) — deliberately **not** the
   whole containing folder, unlike the general feature's `removalUnit`
   logic, since every sibling file (decoy apps, `etc/permissions/*.xml`,
   etc.) must be byte-for-byte preserved.
5. Stream the entire original disk back out with those patches applied,
   via the same folder/file-picker/Blob sinks as everything else in this
   app. The **source file is never overwritten**: output is always named
   `<original>_MODIFIED.img` (e.g. `super.img` → `super_MODIFIED.img`).
6. Write a `modification-report.json` next to the output, containing the
   source/output filenames, an ISO-8601 timestamp, SHA-256 of both the
   original and modified image, which partitions were touched, the exact
   3 removed files (`{partition, path, package}`), original vs. rebuilt
   partition sizes (always identical — see below), and the full validation
   result.
7. Validate the result: reparse `*_MODIFIED.img` with this project's own
   LP/EROFS readers; confirm every original partition (including untouched
   ones) is still present; confirm the 3 target paths are gone; confirm,
   by diffing a full pre/post file-path tree per touched partition, that
   **no other file was added or removed**; confirm no LP extents overlap;
   confirm each rebuilt filesystem still fits its unchanged, originally
   allocated partition size. The CLI script additionally shells out to a
   real `fsck.erofs` (if present on `PATH`) as an independent integrity
   oracle on both rebuilt partitions — the in-browser UI can't shell out,
   so it notes that check as skipped and points at the CLI script instead.

Same standing design choices as the general removal feature apply here:
**original LP metadata/group definitions are reused as-is** (partition
names, attributes, group names, block size, metadata slots, and extent
layout are never regenerated/relaid-out — only partition-data bytes already
allocated to `product_a`/`system_ext_a` are patched in place); no inodes or
blocks are ever freed, so the rebuilt image is exactly the same size as the
original; no AVB/dm-verity/vbmeta handling (same caveat as above); and this
action **never flashes anything** — it only ever produces a local file.

Run it from the command line against any `super.img`:

```bash
node scripts/remove-device-lock-components.mjs path/to/super.img
```

On success it prints:

```
BUILD SUCCESSFUL

Removed:
✓ com.scorpio.securitycom
✓ com.transsion.spl
✓ com.transsion.spld

Modified partitions:
✓ product_a
✓ system_ext_a

Output:
super_MODIFIED.img

Original:
UNCHANGED
```

and writes `super_MODIFIED.img` + `modification-report.json` next to the
source image. If any target can't be located it instead prints a `STOP`
message naming exactly which file(s), and writes **no** files at all.

A ready-made fixture that contains all three targets (built with real
`mkfs.erofs -zlz4hc`, so the targets are genuinely `COMPRESSED_COMPACT` —
the same layout the scanner can't read) lives at
`sample-data/super_devicelock_demo.img`; rebuild it anytime with
`node test/build-devicelock-demo-super.mjs`.

## Edit & merge partitions

Every other removal feature in this app follows the same deliberate rule:
**never resize anything, only patch bytes that are already allocated.**
This feature is the one exception, because its entire point is swapping in
a *different* image — your own custom-built `system`, say — which is
essentially never exactly the same size as what it's replacing. Supporting
that means the dynamic-partition table itself has to be recomputed
(extents, sizes), not just patched in place.

**Workflow:**

1. After parsing a `super.img`, section 3 lists every partition with a
   per-row action: **Keep**, **Delete**, or **Replace…** (which reveals a
   file picker). A separate "+ Add a new partition" form lets you introduce
   a brand new partition name under any existing group.
2. Any file you pick for a replacement or a new partition is validated
   immediately — sniffed for a real ext4 or EROFS superblock at byte offset
   1024, exactly like the rest of this app's filesystem detection. A file
   that doesn't look like a real filesystem image is rejected with a clear
   reason right there in its row, and the "Build" button stays disabled
   until it's fixed; nothing you upload is trusted blindly. Sparse (`.img`
   built with `img2simg`) or raw replacement files both work, since they go
   through the same sparse-or-raw decoder as the main super.img.
3. Clicking "Build modified super.img" does the following, entirely
   client-side:
   - **Deleting or replacing** a partition frees its old extent(s) for
     reuse — new/replacement content is allocated into that freed space
     first (first-fit, oldest-offset-first, splitting a single partition's
     content across multiple extents if one freed fragment isn't enough on
     its own — completely normal for a dynamic partition; freed fragments
     from *different* deleted/replaced partitions can both be reused for
     the same replacement), and only appended as brand new space once the
     freed pool is exhausted. This is what makes it possible to replace a
     partition with a *different-sized* image without necessarily growing
     the output at all — as long as something else freed up enough room in
     the same build (see `src/partition-editor.js`'s module doc comment
     for the full allocator design).
   - **Adding** a partition works the same way — allocated from the same
     reclaimed-space-then-append pool, under whichever existing group you
     chose for it (new groups can't be created by this feature).
   - Every byte **not** touched by an edit — including any leftover
     unreclaimed fragment of freed space — keeps its exact original file
     offset; nothing is ever shifted around.
   - LP **geometry is never touched** (`metadata_max_size`/
     `metadata_slot_count`/`logical_block_size` all stay byte-for-byte
     identical); only the per-slot metadata header+tables are regenerated
     (via `lp-writer.js`, the write-side counterpart of `lp.js`), written
     into every existing metadata slot (primary and backup alike).
     **Groups are preserved as-is** (name/flags/`maximum_size`); if a
     group declares a nonzero `maximum_size` cap, the planner checks the
     new layout still fits under it and refuses to build (with the exact
     numbers) rather than silently exceeding it.
4. If reclaimed space isn't enough, **the output can still end up larger
   than the original** — exactly how much (and how much was reclaimed vs.
   freshly appended) is shown live in the edit summary before you even
   click Build. This is intentional: a bigger output is clearly surfaced,
   not silently produced, and the summary explains the flashing implication
   (a real device's physical `super` partition is a fixed size, so a grown
   image may no longer fit back onto the same device, even though it's a
   perfectly valid, flashable-via-fastboot-to-a-big-enough-target image).
5. Optionally, check **"Output as Android sparse image"** before building.
   `fastboot flash super` (and the userspace fastbootd path most Android
   10+ devices use for dynamic partitions) can reject a raw image outright
   with `Invalid sparse file format at header magic`, even when its size is
   otherwise correct — this produces a real multi-chunk Android sparse file
   instead (`src/sparse-encode.js`, the write-side counterpart of
   `sparse.js`'s decoder), which also tends to come out much smaller
   whenever there's zero-padding or other repeated-pattern content to
   compress away. It takes longer to build (the data is read through
   twice — once to classify it, once to actually emit it — since the
   sparse format's header has to declare its exact chunk count up front)
   but produces byte-identical logical content either way.
6. The result is delivered through the same download-link flow as every
   other build in this app (or streamed straight to a pre-chosen folder) —
   see "Saving" above. **The original `super.img` is never modified.**

**What this feature does not do** (by design, not by oversight):
- It never creates new groups — only existing ones can be targeted for a
  new/replacement partition.
- It never inspects *why* a group's capacity might matter beyond the
  numeric `maximum_size` check above (e.g. it doesn't know about A/B slot
  conventions beyond what's literally encoded in the metadata).
- It never touches AVB/dm-verity/vbmeta, same caveat as every other
  build feature here — a partition whose content changed will need
  verification handled separately before the result can boot verified.
- It can reclaim space *within the same build*, but can't repartition a
  physical device — if your edits genuinely need more room than the
  original image's total size, the output will grow, and only you can
  decide whether that's acceptable for however you intend to use it.
- It never flashes anything.

## Known limitations

- Only block device index 0 (the image(s) you actually loaded) can be read.
  If a `super.img` declares multiple physical block devices (seen on some
  "retrofit" A/B devices with separate `super` / `super_other` images) and a
  partition's extent points at a device you didn't load, that partition will
  fail to extract (or be scanned) with a clear error message.
- Sparse major version must be `1` (the only version ever shipped) and LP
  metadata major version must be `10` (current and, to date, only version).
- The File System Access API (pick-one-folder-and-stream-everything-into-it)
  is Chromium-only today, and even there it's unavailable inside an
  embedded/iframed page (no folder picker is allowed in that context by the
  browser itself, not a bug in this app — look for the "Open in a new tab"
  link shown when this is detected). Everywhere else, every build/extract
  action instead finishes with an explicit, clickable download link (see
  "Saving" above) — which does mean the whole file is held in memory until
  you click it, so for a very large image on a memory-constrained device,
  picking a folder up front (where available) is still the better option.
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
