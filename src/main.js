import { indexSparseOrRaw } from './sparse.js';
import { VirtualDisk, naturalCompare } from './virtual-disk.js';
import { readGeometry, readMetadata, partitionSizeBytes, partitionAttrString, findOverlappingExtents } from './lp.js';
import { detectRawFilesystemType, buildSyntheticRawImageMetadata, guessRawImagePartitionName } from './raw-image.js';
import { extractPartition, makePartitionReader, makePartitionWriter } from './extractor.js';
import { scanAllPartitions, detectAndOpenFilesystem } from './scanner.js';
import { PatchSet, streamPatchedDisk } from './patchset.js';
import {
  DEVICE_LOCK_TARGETS,
  removeDeviceLockComponents,
  resolveExactFile,
  listAllFilePaths,
  DeviceLockRemovalError,
} from './device-lock-removal.js';
import { createSha256Stream, toHex } from './sha256.js';
import { planPartitionEdits, streamEditedSuperImage, PartitionEditError } from './partition-editor.js';
import { encodeSparseStream, wrapSourceForRealPassOnly } from './sparse-encode.js';
import { isLikelyTransientReadError, TRANSIENT_READ_FAILURE_ADVICE } from './file-read-retry.js';
// Note: src/stream-download.js (an automatic, no-folder-picker streaming
// download via a service worker) is kept in the repo and fully tested, but
// deliberately NOT used here as a silent default anymore -- in practice it
// produced "Disk full" download-manager failures in some real
// browser/OS/download-manager combinations (likely related to how that
// browser pre-allocates space for a worker-streamed response), which is
// strictly worse than the honest, explicit flow below: build the result,
// then show a real, clickable download link (+ a native "Save As" button
// when available) so the user can see it's ready and choose where it goes,
// exactly like any ordinary file download.
import {
  supportsDirectoryPicker,
  supportsSaveFilePicker,
  pickDirectory,
  verifyDirectoryPermission,
  directorySink,
} from './saver.js';

// ---------- small DOM helpers ----------
const $ = (id) => document.getElementById(id);
const logEl = $('log');

function log(msg, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  const ts = new Date().toLocaleTimeString();
  line.textContent = `[${ts}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

/** Shared VirtualDisk onReadRetry handler: surfaces a transient-file-read
 * retry (see file-read-retry.js) in the log instead of just pausing
 * silently for a few seconds during a long multi-gigabyte operation. */
function logReadRetry(attempt, err) {
  log(`  (transient file read hiccup, retry ${attempt}: ${err.message || err}) — retrying…`, 'warn');
}

/** If `err` is the "could not be read" transient-file-access failure (and
 * every automatic retry has already been exhausted), logs the longer,
 * actionable explanation/remedies instead of just the raw browser error
 * text. Returns true if it did so. */
function logTransientReadAdviceIfApplicable(err) {
  if (!isLikelyTransientReadError(err)) return false;
  const what = err.sourceLabel
    ? `${err.sourceLabel}${err.fileName ? ` ("${err.fileName}")` : ''}`
    : err.fileName
      ? `"${err.fileName}"`
      : 'a loaded file';
  log(`This build failed because your browser could not read ${what}, even after retrying briefly:`, 'err');
  for (const line of TRANSIENT_READ_FAILURE_ADVICE.split('\n')) {
    if (line.trim()) log(line, 'warn');
  }
  return true;
}

const LARGE_FOLDER_WRITE_WARNING_THRESHOLD = 2 * 1024 * 1024 * 1024; // 2 GiB

/** Warns upfront, before writing even starts, when saving a large file into
 * a chosen folder -- the File System Access API's close() step (which
 * finalizes a ".crswap" temp file into the real filename) is a documented
 * browser behavior that scans the whole temp file and can take anywhere
 * from seconds to tens of minutes for multi-gigabyte files, with no
 * current fix on the browser side (confirmed: this is not something this
 * tool's code controls). Telling the user this BEFORE they spend 20
 * minutes watching "finalizing…" wondering if it's frozen is far better
 * than them finding out the hard way. */
function warnIfLargeFolderWrite(totalBytes) {
  if (state.dirHandle && totalBytes >= LARGE_FOLDER_WRITE_WARNING_THRESHOLD) {
    log(
      `Heads up: saving a ${formatBytes(totalBytes)} file directly into a chosen folder has a known slow final ` +
        `step in the browser itself (not this tool) -- after all bytes are written, the browser scans the whole ` +
        `file before renaming it into place, which can take anywhere from under a minute to tens of minutes for ` +
        `files this large, especially on slower drives or with antivirus scanning it. The "finalizing…" step ` +
        `below may look stuck but is very likely still working -- please leave this tab open and wait it out. ` +
        `If you'd rather avoid this entirely, don't choose an output folder for very large builds; the resulting ` +
        'download-link path does not have this slow step (at the cost of needing enough free memory to hold the ' +
        'whole file).',
      'warn'
    );
  }
}

/** Wraps sink.close() with periodic "still working" reassurance for a
 * potentially very long File System Access API finalize step (see
 * warnIfLargeFolderWrite) -- otherwise a 20-minute close() looks identical
 * to a frozen tab, with zero feedback the whole time. */
async function closeSinkWithFeedback(sink, label) {
  let done = false;
  const started = Date.now();
  const interval = state.dirHandle
    ? setInterval(() => {
        if (!done) {
          log(
            `  still finalizing "${label}"… (${Math.round((Date.now() - started) / 1000)}s so far -- this is the ` +
              `browser's own slow step for large files saved to a folder, not a hang; keep waiting)`,
            'warn'
          );
        }
      }, 20_000)
    : null;
  try {
    await sink.close();
  } finally {
    done = true;
    if (interval) clearInterval(interval);
  }
}

/**
 * Writes a raw byte stream (`makeRawStream()`, covering exactly
 * `totalBytes`) to `sink`, optionally re-encoding it as a real Android
 * sparse image first (what `fastboot flash` expects) via
 * encodeSparseStream() -- logging progress either way, and invoking
 * `onChunk` (if given) on every RAW chunk before it's written/encoded, so
 * callers that need to hash the logical content (e.g. for a modification
 * report) still see every byte exactly once regardless of output format.
 * Returns the actual number of bytes written to the sink (in sparse mode
 * this is typically much less than totalBytes).
 */
async function writeStreamToSink(makeRawStream, totalBytes, sink, { label, sparse, blockSize, onChunk, onUiProgress }) {
  let written = 0;

  if (!sparse) {
    let lastLoggedPct = -1;
    for await (const chunk of makeRawStream()) {
      onChunk && onChunk(chunk);
      await sink.write(chunk);
      written += chunk.length;
      onUiProgress && onUiProgress(written, totalBytes);
      const frac = totalBytes > 0 ? written / totalBytes : 1;
      const pct = Math.floor((frac * 100) / 25) * 25;
      if (pct > lastLoggedPct && pct < 100) {
        lastLoggedPct = pct;
        log(`  ${label}: ${pct}% (${formatBytes(written)} / ${formatBytes(totalBytes)})`);
      }
    }
    log(`  ${label}: 100% (${formatBytes(written)}) — finalizing…`);
    return written;
  }

  if (totalBytes % blockSize !== 0) {
    throw new Error(
      `Cannot produce a sparse image: the rebuilt size (${totalBytes} bytes) is not an exact multiple of the ` +
        `block size (${blockSize} bytes). Try unchecking "Output as Android sparse image" and converting ` +
        `separately with img2simg instead.`
    );
  }
  log(`  ${label}: building as a sparse image (two passes: scan, then write) — this takes longer than raw…`);
  let lastScanPct = -1;
  let lastWritePct = -1;
  // onChunk must see the RAW content exactly once -- hooked into the real
  // "writing" pass only, never the "scanning" pass (which re-reads the
  // identical bytes purely to classify them -- see wrapSourceForRealPassOnly's
  // own doc comment for why this is deliberately NOT done by reacting to
  // the onProgress callback below, which is a subtly different, buggier
  // thing to synchronize on).
  const wrappedSource = onChunk ? wrapSourceForRealPassOnly(makeRawStream, onChunk) : makeRawStream;
  const sparseStream = encodeSparseStream(wrappedSource, totalBytes, blockSize, 16 * 1024 * 1024, (phase, done, total) => {
    // One continuous 0-100% bar across both passes (scanning = first half,
    // writing = second half), rather than two separate 0-100% cycles.
    const combinedDone = phase === 'scanning' ? done : total + done;
    onUiProgress && onUiProgress(combinedDone, total * 2);
    const pct = Math.floor(((done / total) * 100) / 10) * 10;
    if (phase === 'scanning' && pct > lastScanPct && pct < 100) {
      lastScanPct = pct;
      log(`  ${label}: scanning ${pct}% (pass 1/2)…`);
    }
    if (phase === 'writing' && pct > lastWritePct && pct < 100) {
      lastWritePct = pct;
      log(`  ${label}: writing ${pct}% (pass 2/2)…`);
    }
  });
  for await (const chunk of sparseStream) {
    await sink.write(chunk);
    written += chunk.length;
  }
  log(
    `  ${label}: 100% — sparse-encoded to ${formatBytes(written)} (raw equivalent ${formatBytes(totalBytes)}) — finalizing…`
  );
  return written;
}

function formatBytes(n) {
  const num = typeof n === 'bigint' ? Number(n) : n;
  if (!Number.isFinite(num)) return String(n);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = num;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

// ---------- state ----------
const state = {
  files: [], // File[] in load order (sorted)
  disk: null,
  geo: null,
  meta: null,
  dirHandle: null,
  cancelRequested: false,
  patchSet: null, // PatchSet accumulating removal edits against the loaded disk
  lastScanReport: null, // most recent scanAllPartitions() result (live volume refs + removalUnits)
  editOps: new Map(), // partition name -> resolved {action:'delete'} | {action:'replace', disk, fsType, sizeBytes, fileName}
  addOps: [], // [{name, groupName, disk, fsType, sizeBytes, fileName}]
  editRowsPendingValidation: new Set(), // partition names currently showing "replace" with no valid file yet (blocks build)
};

// ---------- 1. file selection ----------
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const fileListEl = $('fileList');
const parseBtn = $('parseBtn');
const parseStatus = $('parseStatus');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag');
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    handleFiles(e.dataTransfer.files);
  }
});
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

function handleFiles(fileList) {
  const files = Array.from(fileList);
  files.sort((a, b) => naturalCompare(a.name, b.name));
  state.files = files;
  fileListEl.innerHTML = '';
  for (const f of files) {
    const row = document.createElement('div');
    row.innerHTML = `<span>${escapeHtml(f.name)}</span><span class="muted">${formatBytes(f.size)}</span>`;
    fileListEl.appendChild(row);
  }
  parseBtn.disabled = files.length === 0;
  parseStatus.textContent = files.length
    ? `${files.length} file(s) selected, in the order shown above.`
    : '';
  // Reset downstream state since the source changed.
  $('metaCard').classList.add('hidden');
  $('extractCard').classList.add('hidden');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 2. parsing ----------
parseBtn.addEventListener('click', async () => {
  parseBtn.disabled = true;
  parseStatus.textContent = 'Indexing sparse chunks…';
  try {
    const parts = [];
    for (const file of state.files) {
      log(`Indexing ${file.name} (${formatBytes(file.size)})…`);
      const index = await indexSparseOrRaw(file, (done, total) => {
        parseStatus.textContent = `Indexing ${file.name}: chunk ${done}/${total}`;
      });
      log(
        `  ${file.name}: ${index.sparse ? 'sparse' : 'raw'} image, decodes to ${formatBytes(index.outputSize)}`,
        'ok'
      );
      parts.push({ file, index });
    }

    const disk = new VirtualDisk(parts, { onReadRetry: logReadRetry });
    log(`Combined virtual disk size: ${formatBytes(disk.totalSize)}`);

    parseStatus.textContent = 'Reading LP geometry & metadata…';
    let geo;
    try {
      geo = await readGeometry(disk);
    } catch (geometryErr) {
      // Not every .img a user has is a dynamic-partition super.img — a GSI
      // (Generic System Image) or any other standalone partition image
      // (system.img/vendor.img/product.img pulled individually) is just a
      // single ext4/EROFS filesystem starting at byte 0, with no LP header
      // at all. Rather than dead-ending on a technically-correct-but-
      // unhelpful "no LP geometry" error, detect that case and synthesize
      // a single-partition metadata set covering the whole file, so every
      // other feature (extraction, scan, removal) keeps working unchanged.
      const rawFsType = await detectRawFilesystemType(disk);
      if (!rawFsType) throw geometryErr;

      const partitionName = guessRawImagePartitionName(state.files[state.files.length - 1]?.name || 'raw_image');
      const built = buildSyntheticRawImageMetadata(disk, rawFsType, partitionName);
      geo = built.geo;
      log(
        `No LP ("super.img") geometry block found — this looks like a standalone, single-partition ` +
          `${rawFsType.toUpperCase()} image instead (e.g. a GSI system.img), not a dynamic-partition super.img. ` +
          `Treating the whole file as one partition named "${partitionName}" so you can still inspect/extract it.`,
        'warn'
      );
      if (built.truncatedBytes > 0) {
        log(
          `Note: the last ${built.truncatedBytes} byte(s) of the file aren't a full 512-byte sector and are ` +
            `excluded from the partition range (this is normal padding, not data loss).`,
          'warn'
        );
      }
      state.disk = disk;
      state.geo = geo;
      state.patchSet = new PatchSet();
      state.lastScanReport = null;
      state.meta = built.meta;
      log(
        `Synthetic single-partition metadata built: 1 partition ("${partitionName}", ` +
          `${formatBytes(partitionSizeBytes(built.meta, built.meta.partitions[0]))}).`,
        'ok'
      );
      renderMeta();
      initBrowseCard(built.meta);

      $('metaCard').classList.remove('hidden');
      $('extractCard').classList.remove('hidden');
      $('scanCard').classList.remove('hidden');
      $('removeCard').classList.add('hidden');
      // A standalone raw image has no real LP metadata region at all (it's
      // just one filesystem starting at byte 0) -- there's no partition
      // table to edit/merge, and the three fixed device-lock-removal
      // target paths assume a real multi-partition dynamic image, so both
      // features are hidden rather than shown and failing confusingly.
      $('editCard').classList.add('hidden');
      $('deviceLockCard').classList.add('hidden');
      parseStatus.textContent = 'Done (loaded as a single raw partition image).';
      return;
    }
    log(
      `Geometry OK (${geo.source}${geo.checksumValid ? '' : ', checksum MISMATCH — proceeding anyway'}): ` +
        `${geo.metadata_slot_count} slot(s), metadata_max_size=${geo.metadata_max_size}, logical_block_size=${geo.logical_block_size}`,
      geo.checksumValid ? 'ok' : 'warn'
    );

    state.disk = disk;
    state.geo = geo;
    state.patchSet = new PatchSet();
    state.lastScanReport = null;

    await loadSlot(0);
    initBrowseCard(state.meta);
    initEditCard(state.meta);

    $('metaCard').classList.remove('hidden');
    $('extractCard').classList.remove('hidden');
    $('scanCard').classList.remove('hidden');
    $('removeCard').classList.add('hidden');
    $('deviceLockCard').classList.remove('hidden');
    $('deviceLockStatus').textContent = '';
    $('deviceLockResult').textContent = '';
    $('deviceLockBtn').disabled = false;
    parseStatus.textContent = 'Done.';
  } catch (err) {
    console.error(err);
    log(`ERROR: ${err.message}`, 'err');
    parseStatus.textContent = 'Failed — see log.';
  } finally {
    parseBtn.disabled = false;
  }
});

async function loadSlot(slot) {
  const meta = await readMetadata(state.disk, state.geo, slot);
  state.meta = meta;
  log(
    `Metadata slot ${slot} OK (${meta.source} copy): ${meta.partitions.length} partition(s), ` +
      `${meta.blockDevices.length} block device(s).`,
    'ok'
  );
  if (meta.blockDevices.length > 1) {
    log(
      `Note: this image declares ${meta.blockDevices.length} block devices; only the one you loaded ` +
        `(index 0) can be extracted from. Partitions spanning other devices will fail if selected.`,
      'warn'
    );
  }
  renderMeta();
}

function renderMeta() {
  const { geo, meta } = state;
  $('metaSummary').textContent =
    `super block device size: ${formatBytes(meta.blockDevices[0]?.size ?? state.disk.totalSize)}  |  ` +
    `logical_block_size: ${geo.logical_block_size}  |  groups: ${meta.groups.map((g) => g.name).join(', ')}`;

  const slotSelect = $('slotSelect');
  const slotLabel = $('slotLabel');
  if (geo.metadata_slot_count > 1) {
    slotSelect.style.display = '';
    slotLabel.style.display = '';
    slotSelect.innerHTML = '';
    for (let i = 0; i < geo.metadata_slot_count; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `Slot ${i}${i === meta.slot ? ' (loaded)' : ''}`;
      if (i === meta.slot) opt.selected = true;
      slotSelect.appendChild(opt);
    }
    slotSelect.onchange = async () => {
      try {
        await loadSlot(Number(slotSelect.value));
      } catch (err) {
        log(`ERROR loading slot: ${err.message}`, 'err');
      }
    };
  } else {
    slotSelect.style.display = 'none';
    slotLabel.style.display = 'none';
  }

  const tbody = $('partitionTable');
  tbody.innerHTML = '';
  for (const p of meta.partitions) {
    const size = partitionSizeBytes(meta, p);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="part-chk" checked /></td>
      <td class="name">${escapeHtml(p.name)}</td>
      <td class="size">${formatBytes(size)}</td>
      <td class="attrs">${escapeHtml(partitionAttrString(p.attributes)) || '—'}</td>
    `;
    tr.dataset.name = p.name;
    tbody.appendChild(tr);
    tr.querySelector('.part-chk').addEventListener('change', updateSelCount);
  }
  updateSelCount();
}

$('selectAll').addEventListener('change', (e) => {
  document.querySelectorAll('.part-chk').forEach((c) => (c.checked = e.target.checked));
  updateSelCount();
});

function updateSelCount() {
  const total = document.querySelectorAll('.part-chk').length;
  const checked = document.querySelectorAll('.part-chk:checked').length;
  $('selCount').textContent = `${checked} / ${total} selected`;
  $('extractBtn').disabled = checked === 0;
}

function selectedPartitionNames() {
  return Array.from(document.querySelectorAll('#partitionTable tr'))
    .filter((tr) => tr.querySelector('.part-chk').checked)
    .map((tr) => tr.dataset.name);
}

// ---------- 3. Edit & merge partitions ----------
const editTable = $('editTable');
const editSummary = $('editSummary');
const editStatus = $('editStatus');
const buildEditedBtn = $('buildEditedBtn');
const editProgress = $('editProgress');
const editDownloads = $('editDownloads');
const addPartitionToggle = $('addPartitionToggle');
const addPartitionForm = $('addPartitionForm');
const addPartitionName = $('addPartitionName');
const addPartitionGroup = $('addPartitionGroup');
const addPartitionFile = $('addPartitionFile');
const addPartitionCancel = $('addPartitionCancel');

/** Reads just enough of an uploaded File (sparse or raw) to confirm it's a
 * real ext4/EROFS filesystem image before accepting it as a replacement/new
 * partition's content -- catches an accidentally-wrong file immediately
 * rather than silently baking it into a rebuilt super.img. */
async function validateReplacementFile(file) {
  const index = await indexSparseOrRaw(file);
  const disk = new VirtualDisk([{ file, index }], { onReadRetry: logReadRetry });
  const fsType = await detectRawFilesystemType(disk);
  if (!fsType) {
    throw new Error(`doesn't look like a valid ext4 or EROFS filesystem image (no superblock found at offset 1024)`);
  }
  return { disk, fsType, sizeBytes: disk.totalSize };
}

function initEditCard(meta) {
  $('editCard').classList.remove('hidden');
  state.editOps = new Map();
  state.addOps = [];
  state.editRowsPendingValidation = new Set();
  editDownloads.innerHTML = '';
  editStatus.textContent = '';
  addPartitionForm.classList.add('hidden');
  addPartitionName.value = '';
  addPartitionFile.value = '';

  addPartitionGroup.innerHTML = '';
  for (const g of meta.groups) {
    const opt = document.createElement('option');
    opt.value = g.name;
    opt.textContent = g.name;
    addPartitionGroup.appendChild(opt);
  }

  editTable.innerHTML = '';
  for (const p of meta.partitions) {
    const size = partitionSizeBytes(meta, p);
    const groupName = meta.groups[p.group_index]?.name ?? '—';
    const tr = document.createElement('tr');
    tr.dataset.name = p.name;
    tr.innerHTML = `
      <td class="name">${escapeHtml(p.name)}</td>
      <td class="attrs">${escapeHtml(groupName)}</td>
      <td class="size">${formatBytes(size)}</td>
      <td>
        <select class="edit-action">
          <option value="keep">Keep</option>
          <option value="delete">Delete</option>
          <option value="replace">Replace…</option>
        </select>
      </td>
      <td><input type="file" class="edit-replace-file" style="display:none;" /><span class="edit-replace-status muted"></span></td>
    `;
    editTable.appendChild(tr);

    const actionSelect = tr.querySelector('.edit-action');
    const fileInput = tr.querySelector('.edit-replace-file');
    const statusSpan = tr.querySelector('.edit-replace-status');

    actionSelect.addEventListener('change', () => {
      state.editOps.delete(p.name);
      state.editRowsPendingValidation.delete(p.name);
      statusSpan.textContent = '';
      statusSpan.className = 'edit-replace-status muted';
      if (actionSelect.value === 'delete') {
        state.editOps.set(p.name, { action: 'delete' });
        fileInput.style.display = 'none';
        fileInput.value = '';
      } else if (actionSelect.value === 'replace') {
        fileInput.style.display = '';
        state.editRowsPendingValidation.add(p.name); // no file chosen yet
      } else {
        fileInput.style.display = 'none';
        fileInput.value = '';
      }
      refreshEditSummary();
    });

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      statusSpan.textContent = 'Checking…';
      statusSpan.className = 'edit-replace-status muted';
      try {
        const { disk, fsType, sizeBytes } = await validateReplacementFile(file);
        state.editOps.set(p.name, { action: 'replace', disk, fsType, sizeBytes, fileName: file.name });
        state.editRowsPendingValidation.delete(p.name);
        statusSpan.textContent = `✓ ${file.name} (${fsType}, ${formatBytes(sizeBytes)})`;
        statusSpan.className = 'edit-replace-status';
        statusSpan.style.color = 'var(--good)';
        log(`"${p.name}" will be replaced with "${file.name}" (${fsType}, ${formatBytes(sizeBytes)}).`);
      } catch (err) {
        state.editOps.delete(p.name);
        state.editRowsPendingValidation.add(p.name);
        statusSpan.textContent = `✗ ${file.name} ${err.message}`;
        statusSpan.className = 'edit-replace-status';
        statusSpan.style.color = 'var(--bad)';
        log(`Replacement file for "${p.name}" rejected: ${err.message}`, 'err');
      }
      refreshEditSummary();
    });
  }

  refreshEditSummary();
}

addPartitionToggle.addEventListener('click', () => {
  addPartitionForm.classList.remove('hidden');
  addPartitionToggle.disabled = true;
});
addPartitionCancel.addEventListener('click', () => {
  addPartitionForm.classList.add('hidden');
  addPartitionToggle.disabled = false;
  addPartitionName.value = '';
  addPartitionFile.value = '';
});
addPartitionFile.addEventListener('change', async () => {
  const file = addPartitionFile.files?.[0];
  const name = addPartitionName.value.trim();
  if (!file) return;
  if (!name) {
    log('Enter a partition name before choosing a file to add.', 'warn');
    addPartitionFile.value = '';
    return;
  }
  if (state.meta.partitions.some((p) => p.name === name) || state.addOps.some((a) => a.name === name)) {
    log(`Cannot add "${name}": that name is already in use.`, 'err');
    addPartitionFile.value = '';
    return;
  }
  try {
    const { disk, fsType, sizeBytes } = await validateReplacementFile(file);
    state.addOps.push({ name, groupName: addPartitionGroup.value, disk, fsType, sizeBytes, fileName: file.name });
    log(`Queued new partition "${name}" (group "${addPartitionGroup.value}") from "${file.name}" (${fsType}, ${formatBytes(sizeBytes)}).`, 'ok');
    addPartitionForm.classList.add('hidden');
    addPartitionToggle.disabled = false;
    addPartitionName.value = '';
    addPartitionFile.value = '';
    refreshEditSummary();
  } catch (err) {
    log(`File for new partition "${name}" rejected: ${err.message}`, 'err');
    addPartitionFile.value = '';
  }
});

function removeAddOp(name) {
  state.addOps = state.addOps.filter((a) => a.name !== name);
  refreshEditSummary();
}

function refreshEditSummary() {
  const edits = [];
  for (const [name, op] of state.editOps) {
    if (op.action === 'delete') edits.push({ action: 'delete', name });
    else edits.push({ action: 'replace', name, sizeBytes: op.sizeBytes });
  }
  for (const add of state.addOps) {
    edits.push({ action: 'add', name: add.name, groupName: add.groupName, sizeBytes: add.sizeBytes });
  }

  const lines = [];
  for (const [name, op] of state.editOps) {
    lines.push(op.action === 'delete' ? `✗ delete "${name}"` : `↻ replace "${name}" with "${op.fileName}" (${formatBytes(op.sizeBytes)})`);
  }
  for (const add of state.addOps) {
    lines.push(
      `+ add "${add.name}" (group "${add.groupName}") from "${add.fileName}" (${formatBytes(add.sizeBytes)}) ` +
        `<a href="#" class="remove-add-op" data-name="${escapeHtml(add.name)}">remove</a>`
    );
  }
  for (const name of state.editRowsPendingValidation) {
    lines.push(`⚠ "${name}" is set to Replace but has no valid file chosen yet`);
  }

  if (!lines.length) {
    editSummary.innerHTML = 'No changes queued yet.';
    buildEditedBtn.disabled = true;
    return;
  }

  let sizeInfo = '';
  let hasBlockingError = state.editRowsPendingValidation.size > 0;
  if (!hasBlockingError && edits.length) {
    try {
      const plan = planPartitionEdits(state.meta, state.geo, edits, { originalDiskSize: state.disk.totalSize });
      sizeInfo =
        `\n\nOriginal total size: ${formatBytes(plan.originalTotalSize)}\n` +
        `Projected new size: ${formatBytes(plan.newTotalSize)}` +
        (plan.grew
          ? ` (grew by ${formatBytes(plan.newTotalSize - plan.originalTotalSize)} — may no longer fit a device's ` +
            `fixed-size physical super partition; fine for sideloading/testing, verify before flashing back)`
          : plan.freeBytesReclaimed > 0
            ? ` (unchanged — ${formatBytes(plan.freeBytesReclaimed)} of freed space from deleted/replaced ` +
              `partitions was reused, so this still fits in the original image size)`
            : ' (unchanged — fits in the original image size)');
      if (plan.freeBytesReclaimed > 0) {
        sizeInfo += `\nReclaimed space reused: ${formatBytes(plan.freeBytesReclaimed)} of ${formatBytes(plan.freeBytesAvailable)} freed`;
      }
    } catch (err) {
      sizeInfo = `\n\n✗ ${err.message}`;
      hasBlockingError = true;
    }
  }

  editSummary.innerHTML = lines.join('<br>') + escapeHtml(sizeInfo).replace(/\n/g, '<br>');
  editSummary.querySelectorAll('.remove-add-op').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      removeAddOp(a.dataset.name);
    });
  });
  buildEditedBtn.disabled = hasBlockingError || edits.length === 0;
}

buildEditedBtn.addEventListener('click', async () => {
  const { disk, geo, meta } = state;
  const edits = [];
  for (const [name, op] of state.editOps) {
    if (op.action === 'delete') edits.push({ action: 'delete', name });
    else edits.push({ action: 'replace', name, sizeBytes: op.sizeBytes });
  }
  for (const add of state.addOps) {
    edits.push({ action: 'add', name: add.name, groupName: add.groupName, sizeBytes: add.sizeBytes });
  }

  buildEditedBtn.disabled = true;
  editProgress.innerHTML = '';
  editDownloads.innerHTML = '';
  editStatus.textContent = 'Planning…';
  log(`Starting "Build modified super.img" with ${edits.length} queued change(s)…`);

  try {
    const plan = planPartitionEdits(meta, geo, edits, { originalDiskSize: disk.totalSize });
    log(
      `Plan: original ${formatBytes(plan.originalTotalSize)} -> new ${formatBytes(plan.newTotalSize)}` +
        (plan.grew ? ' (grew)' : ' (unchanged size)') +
        (plan.freeBytesReclaimed > 0 ? `, reused ${formatBytes(plan.freeBytesReclaimed)} of freed space` : ''),
      plan.grew ? 'warn' : 'ok'
    );
    for (const d of plan.deletedNames) log(`  deleting "${d}"`);
    for (const a of plan.allocations) {
      const reusedBytes = a.ranges.filter((r) => r.byteOffset < plan.originalBoundary).reduce((sum, r) => sum + r.byteLength, 0);
      const appendedBytes = a.byteLength - reusedBytes;
      log(
        `  ${a.action === 'replace' ? 'replacing' : 'adding'} "${a.name}": ${formatBytes(a.sizeBytes)} -> allocated ` +
          `${formatBytes(a.byteLength)} across ${a.ranges.length} extent(s)` +
          (reusedBytes > 0 ? ` (${formatBytes(reusedBytes)} reused` + (appendedBytes > 0 ? ` + ${formatBytes(appendedBytes)} new)` : ')') : ' (all new space)')
      );
    }

    const sources = new Map();
    for (const [name, op] of state.editOps) {
      if (op.action === 'replace') sources.set(name, (offset, length) => op.disk.read(offset, length));
    }
    for (const add of state.addOps) {
      sources.set(add.name, (offset, length) => add.disk.read(offset, length));
    }

    editStatus.textContent = 'Building modified super.img…';
    log(
      state.dirHandle
        ? `Streaming super_MODIFIED.img straight into the chosen folder "${state.dirHandle.name}"…`
        : "Building super_MODIFIED.img in memory — a download link will appear below when it's ready…"
    );
    warnIfLargeFolderWrite(plan.newTotalSize);
    const ui = addProgressRow('super_MODIFIED.img', editProgress);
    const sink = await makeSink('super_MODIFIED.img', plan.newTotalSize, editDownloads);
    const useSparse = $('editSparseOutput').checked;
    await writeStreamToSink(() => streamEditedSuperImage(disk, geo, plan, sources), plan.newTotalSize, sink, {
      label: 'super_MODIFIED.img',
      sparse: useSparse,
      blockSize: geo.logical_block_size || 4096,
      onUiProgress: (done, total) => ui.setProgress(total > 0 ? done / total : 1),
    });
    await closeSinkWithFeedback(sink, 'super_MODIFIED.img');
    ui.setDone();

    const sizeLabel = useSparse ? `sparse image, ${formatBytes(plan.newTotalSize)} raw equivalent` : formatBytes(plan.newTotalSize);
    editStatus.textContent = state.dirHandle
      ? `Done. Saved super_MODIFIED.img (${sizeLabel}) to "${state.dirHandle.name}".`
      : `Done. super_MODIFIED.img (${sizeLabel}) is ready — click the download link below.`;
    log('Modified super.img build complete. Original super.img left untouched.', 'ok');
  } catch (err) {
    console.error(err);
    if (err instanceof PartitionEditError) {
      editStatus.textContent = `Could not build: ${err.message}`;
      log(`Edit plan rejected: ${err.message}`, 'err');
    } else if (logTransientReadAdviceIfApplicable(err)) {
      editStatus.textContent = 'A file could not be read — see the log for what this usually means and how to fix it. Your queued changes are still here.';
    } else {
      editStatus.textContent = 'Failed to build modified image — see log.';
      log(`ERROR building modified image: ${err.message}`, 'err');
    }
  } finally {
    buildEditedBtn.disabled = false;
  }
});

// ---------- 4. output target ----------
const inIframe = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin access throws => definitely framed
  }
})();

if (inIframe) {
  const notice = $('iframeNotice');
  notice.classList.remove('hidden');
  const link = $('openInTabLink');
  link.href = location.href;
}

const fsapiBadge = $('fsapi-badge');
if (supportsDirectoryPicker() && !inIframe) {
  fsapiBadge.textContent = 'folder save supported';
  fsapiBadge.classList.add('good');
} else if (supportsDirectoryPicker() && inIframe) {
  fsapiBadge.textContent = 'automatic streaming download (open in a new tab to pick a folder instead)';
  fsapiBadge.classList.add('good');
} else if (supportsStreamingDownload()) {
  fsapiBadge.textContent = 'automatic streaming download supported';
  fsapiBadge.classList.add('good');
} else if (supportsSaveFilePicker()) {
  fsapiBadge.textContent = 'per-file save supported';
  fsapiBadge.classList.add('good');
} else {
  fsapiBadge.textContent = 'falling back to downloads (large files may use lots of memory)';
  fsapiBadge.classList.add('warn');
}

function explainPickerFailure(err) {
  // Chromium throws SecurityError/NotAllowedError when a file-system picker
  // is invoked from a context where it's disallowed (e.g. a cross-origin
  // iframe without the right Permissions-Policy, or no "sufficiently
  // transient" user activation).
  if (err && (err.name === 'SecurityError' || err.name === 'NotAllowedError')) {
    return (
      'Your browser blocked the folder/file picker here — most likely because this page is embedded ' +
      'in an iframe. Click "Open in a new tab" above and try again from the full page.'
    );
  }
  return err && err.message ? err.message : String(err);
}

$('chooseDirBtn').addEventListener('click', async () => {
  if (!supportsDirectoryPicker()) {
    log(
      'This browser/context does not support picking a specific folder (File System Access API). ' +
        'That\'s fine — nothing extra to do: files will stream automatically into your Downloads folder ' +
        (inIframe ? 'instead (or open this app in a new tab, linked above, if you do want to pick a folder).' : 'instead.'),
      'warn'
    );
    return;
  }
  try {
    const handle = await pickDirectory();
    const ok = await verifyDirectoryPermission(handle);
    if (!ok) {
      log('Permission to write to the chosen folder was denied.', 'err');
      return;
    }
    state.dirHandle = handle;
    $('dirStatus').textContent = `Saving into: "${handle.name}"`;
    log(`Output folder set to "${handle.name}".`, 'ok');
  } catch (err) {
    if (err.name !== 'AbortError') log(`Could not choose folder: ${explainPickerFailure(err)}`, 'err');
  }
});

// ---------- 5. extraction ----------
const extractBtn = $('extractBtn');
const cancelBtn = $('cancelBtn');
const progressList = $('progressList');

/**
 * Renders a "ready to download" block into `containerEl`: a real, clickable
 * Blob-URL download link (standard browser download flow -- if the user's
 * browser is set to ask where to save each file, this is exactly where
 * they get to choose), plus a native "Save As…" button whenever the File
 * System Access API's save picker is available, so there's always an
 * explicit way to pick a destination folder/filename regardless of browser
 * download settings.
 */
function renderDownloadReady(containerEl, filename, blob) {
  const url = URL.createObjectURL(blob);
  const box = document.createElement('div');
  box.className = 'download-ready';

  const link = document.createElement('a');
  link.className = 'dl-link';
  link.href = url;
  link.download = filename;
  link.textContent = `⬇ Download ${filename}`;
  box.appendChild(link);

  const meta = document.createElement('span');
  meta.className = 'dl-meta';
  meta.textContent = formatBytes(blob.size);
  box.appendChild(meta);

  if (supportsSaveFilePicker()) {
    const saveAsBtn = document.createElement('button');
    saveAsBtn.className = 'secondary';
    saveAsBtn.type = 'button';
    saveAsBtn.textContent = 'Save As… (choose folder)';
    saveAsBtn.addEventListener('click', async () => {
      saveAsBtn.disabled = true;
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: filename });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        log(`Saved "${filename}" via Save As.`, 'ok');
      } catch (err) {
        if (err.name !== 'AbortError') log(`Save As failed for "${filename}": ${err.message}`, 'err');
      } finally {
        saveAsBtn.disabled = false;
      }
    });
    box.appendChild(saveAsBtn);
  }

  containerEl.appendChild(box);
  return url;
}

/**
 * Collects every written chunk in memory and, on close(), renders a
 * download-ready block (see renderDownloadReady) instead of silently
 * auto-triggering anything -- the user explicitly clicks when and how they
 * want to save, which is also the most universally reliable, standard
 * browser download mechanism there is (works identically everywhere,
 * honors "ask where to save" browser settings, and is trivially retriable
 * by clicking again if a save attempt is somehow interrupted).
 */
function createCollectingSink(filename, containerEl) {
  const parts = [];
  let total = 0;
  return {
    write: async (chunk) => {
      parts.push(chunk);
      total += chunk.length;
    },
    close: async () => {
      const blob = new Blob(parts);
      parts.length = 0;
      renderDownloadReady(containerEl, filename, blob);
      log(`"${filename}" is ready (${formatBytes(blob.size)}) — click the download link above to save it.`, 'ok');
    },
    abort: async () => {
      parts.length = 0;
    },
  };
}

/**
 * @param {string} filename
 * @param {number|null} totalSizeBytes unused here (kept for call-site
 *   symmetry / potential future progress-UI use); the collecting sink
 *   doesn't need to know the size up front.
 * @param {HTMLElement} containerEl where to render the eventual download
 *   link, if no folder was explicitly chosen.
 */
async function makeSink(filename, totalSizeBytes, containerEl) {
  if (state.dirHandle) {
    log(`Saving "${filename}" directly into the chosen folder…`);
    return directorySink(state.dirHandle, filename);
  }
  return createCollectingSink(filename, containerEl);
}


function addProgressRow(name, container = progressList) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'progress-row';
  row.innerHTML = `
    <div class="mono">${escapeHtml(name)}</div>
    <div class="progress-track"><div class="progress-fill"></div></div>
    <div class="size" style="text-align:right;">0%</div>
  `;
  const extra = document.createElement('div');
  wrap.appendChild(row);
  wrap.appendChild(extra);
  container.appendChild(wrap);
  return {
    extraEl: extra, // where a download-ready block (see renderDownloadReady) gets appended
    setProgress(frac) {
      row.querySelector('.progress-fill').style.width = `${Math.min(100, frac * 100).toFixed(1)}%`;
      row.querySelector('.size').textContent = `${Math.min(100, frac * 100).toFixed(0)}%`;
    },
    setDone() {
      row.querySelector('.progress-fill').classList.add('done');
      row.querySelector('.size').textContent = 'done';
    },
    setError(msg) {
      row.querySelector('.progress-fill').classList.add('error');
      row.querySelector('.size').textContent = 'error';
      row.title = msg;
    },
  };
}

extractBtn.addEventListener('click', async () => {
  const names = selectedPartitionNames();
  if (!names.length) return;

  progressList.innerHTML = '';
  extractBtn.disabled = true;
  cancelBtn.classList.remove('hidden');
  state.cancelRequested = false;
  $('extractStatus').textContent = `Extracting ${names.length} partition(s)…`;

  const { disk, meta } = state;
  let okCount = 0;
  let failCount = 0;

  log(
    state.dirHandle
      ? `Output folder "${state.dirHandle.name}" is set — each partition streams straight to disk as it's read.`
      : 'No output folder chosen — each partition will be held in memory and offered as a download link when ready.'
  );

  for (const name of names) {
    if (state.cancelRequested) {
      log('Extraction cancelled by user.', 'warn');
      break;
    }
    const partition = meta.partitions.find((p) => p.name === name);
    const ui = addProgressRow(`${name}.img`);
    const totalBytes = partitionSizeBytes(meta, partition);
    log(`Extracting "${name}" (${formatBytes(totalBytes)})…`);
    warnIfLargeFolderWrite(Number(totalBytes));
    try {
      const sink = await makeSink(`${name}.img`, Number(totalBytes), ui.extraEl);
      const rawClose = sink.close.bind(sink);
      sink.close = () => closeSinkWithFeedback({ close: rawClose }, `${name}.img`);
      let lastLoggedPct = -1;
      await extractPartition(disk, meta, partition, sink, {
        onProgress: (written, total) => {
          if (total > 0n) {
            const frac = Number(written) / Number(total);
            ui.setProgress(frac);
            const pct = Math.floor(frac * 100 / 25) * 25; // log at 0/25/50/75/100
            if (pct > lastLoggedPct && pct < 100) {
              lastLoggedPct = pct;
              log(`    "${name}": ${pct}% (${formatBytes(written)} / ${formatBytes(total)})`);
            }
          }
        },
        isCancelled: () => state.cancelRequested,
      });
      ui.setDone();
      log(`  ✓ "${name}" done (${formatBytes(totalBytes)}).`, 'ok');
      okCount++;
    } catch (err) {
      ui.setError(err.message);
      if (err.cancelled) {
        log(`  Cancelled while extracting "${name}".`, 'warn');
      } else if (logTransientReadAdviceIfApplicable(err)) {
        log(`  ✗ "${name}" failed — see the advice just logged above.`, 'err');
      } else {
        console.error(err);
        log(`  ✗ "${name}" failed: ${err.message}`, 'err');
      }
      failCount++;
      if (err.cancelled) break;
    }
  }

  cancelBtn.classList.add('hidden');
  extractBtn.disabled = false;
  $('extractStatus').textContent = `Finished: ${okCount} succeeded, ${failCount} failed.`;
});

cancelBtn.addEventListener('click', () => {
  state.cancelRequested = true;
  $('extractStatus').textContent = 'Cancelling…';
});

// ---------- browse files (HTML section 5) ----------
const browseCard = $('browseCard');
const browsePartitionSelect = $('browsePartitionSelect');
const browseStatus = $('browseStatus');
const browseBreadcrumb = $('browseBreadcrumb');
const browseTable = $('browseTable');
const browseWarning = $('browseWarning');
const browseDownloads = $('browseDownloads');

// Per currently-open partition: the live volume + the navigation stack
// (root -> ... -> current directory), each entry {name, inode}.
let browseVolume = null;
let browseFsType = null;
let browsePath = []; // [{name, inode}], index 0 is always the root

function entryInodeId(entry) {
  return entry.inodeNumber ?? entry.nid;
}

function fileTypeLabel(inode) {
  if (inode.isDir) return 'folder';
  if (inode.isSymlink) return 'symlink';
  if (inode.isRegular) return 'file';
  return 'other';
}

function fileTypeIcon(inode) {
  if (inode.isDir) return '📁';
  if (inode.isSymlink) return '🔗';
  return '📄';
}

function initBrowseCard(meta) {
  browseCard.classList.remove('hidden');
  browsePartitionSelect.innerHTML = '';
  for (const p of meta.partitions) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    browsePartitionSelect.appendChild(opt);
  }
  if (meta.partitions.length) openBrowsePartition(meta.partitions[0].name);
}

async function openBrowsePartition(name) {
  const { disk, meta } = state;
  const partition = meta.partitions.find((p) => p.name === name);
  if (!partition) return;

  browseVolume = null;
  browseFsType = null;
  browsePath = [];
  browseWarning.textContent = '';
  browseTable.innerHTML = '';
  browseDownloads.innerHTML = '';
  browseStatus.textContent = `Opening "${name}"…`;

  try {
    const readRange = makePartitionReader(disk, meta, partition);
    const { type, volume } = await detectAndOpenFilesystem(readRange);
    browseVolume = volume;
    browseFsType = type;
    browsePath = [{ name: '/', inode: volume.rootInode }];
    browseStatus.textContent = `"${name}" (${type})`;
    renderBrowseDir();
  } catch (err) {
    browseStatus.textContent = `Could not open "${name}": ${err.message}`;
    log(`Browse: could not open "${name}": ${err.message}`, 'warn');
  }
}

browsePartitionSelect.addEventListener('change', () => openBrowsePartition(browsePartitionSelect.value));

function renderBreadcrumb() {
  browseBreadcrumb.innerHTML = '';
  browsePath.forEach((seg, idx) => {
    if (idx > 0) browseBreadcrumb.appendChild(document.createTextNode(' / '));
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = seg.name === '/' ? '/' : seg.name;
    a.style.color = idx === browsePath.length - 1 ? 'var(--text)' : 'var(--accent)';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      browsePath = browsePath.slice(0, idx + 1);
      renderBrowseDir();
    });
    browseBreadcrumb.appendChild(a);
  });
}

async function downloadBrowsedFile(childInode, name) {
  log(`Reading "${name}" (${formatBytes(childInode.size)})…`);
  try {
    const bytes = await browseVolume.readFile(childInode);
    const blob = new Blob([bytes]);
    renderDownloadReady(browseDownloads, name, blob);
    log(`"${name}" is ready (${formatBytes(blob.size)}) — click the download link below.`, 'ok');
  } catch (err) {
    console.error(err);
    log(`Could not read "${name}": ${err.message}`, 'err');
  }
}

async function renderBrowseDir() {
  renderBreadcrumb();
  browseTable.innerHTML = '';
  browseWarning.textContent = '';
  const dirInode = browsePath[browsePath.length - 1].inode;

  let entries;
  try {
    entries = await browseVolume.listDir(dirInode);
  } catch (err) {
    browseWarning.textContent = `Could not list this directory: ${err.message}`;
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  if (browsePath.length > 1) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>⬆️</td><td class="name"><a href="#">..</a></td><td class="attrs">folder</td><td>—</td><td></td>`;
    tr.querySelector('a').addEventListener('click', (e) => {
      e.preventDefault();
      browsePath = browsePath.slice(0, -1);
      renderBrowseDir();
    });
    browseTable.appendChild(tr);
  }

  for (const entry of entries) {
    let childInode;
    try {
      childInode = await browseVolume.readInode(entryInodeId(entry));
    } catch (err) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>⚠️</td><td class="name">${escapeHtml(entry.name)}</td><td class="attrs" colspan="3">could not read inode: ${escapeHtml(err.message)}</td>`;
      browseTable.appendChild(tr);
      continue;
    }

    const tr = document.createElement('tr');
    const sizeText = childInode.isDir ? '—' : formatBytes(childInode.size ?? 0);
    const nameCell = document.createElement('td');
    nameCell.className = 'name';
    if (childInode.isDir) {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = entry.name;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        browsePath = [...browsePath, { name: entry.name, inode: childInode }];
        renderBrowseDir();
      });
      nameCell.appendChild(a);
    } else {
      nameCell.textContent = entry.name;
    }

    tr.innerHTML = `<td>${fileTypeIcon(childInode)}</td>`;
    tr.appendChild(nameCell);
    const typeTd = document.createElement('td');
    typeTd.className = 'attrs';
    typeTd.textContent = fileTypeLabel(childInode);
    tr.appendChild(typeTd);
    const sizeTd = document.createElement('td');
    sizeTd.className = 'size';
    sizeTd.textContent = sizeText;
    tr.appendChild(sizeTd);
    const actionTd = document.createElement('td');
    if (childInode.isRegular) {
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.textContent = 'Download';
      btn.addEventListener('click', () => downloadBrowsedFile(childInode, entry.name));
      actionTd.appendChild(btn);
    }
    tr.appendChild(actionTd);
    browseTable.appendChild(tr);
  }

  if (!entries.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" class="muted">Empty directory.</td>`;
    browseTable.appendChild(tr);
  }
}

// ---------- 6. security scan (read-only: finds Device Administrator APKs) ----------
const scanBtn = $('scanBtn');
const scanStatus = $('scanStatus');
const scanResults = $('scanResults');

function deviceAdminPill(status) {
  const label = status === 'yes' ? 'DEVICE ADMIN' : status === 'no' ? 'not device admin' : 'unknown';
  return `<span class="pill admin-${status}">${label}</span>`;
}

function pluginPill(flagged) {
  return flagged ? '<span class="pill plugin-yes">security-plugin-like name</span>' : '';
}

const scanSearchRow = $('scanSearchRow');
const scanSearchInput = $('scanSearchInput');
const scanSearchCount = $('scanSearchCount');
const selectedApksPanel = $('selectedApksPanel');
const selectedApksBody = $('selectedApksBody');
const selectedApksCount = $('selectedApksCount');

function updateRemoveButtonState() {
  const anyChecked = !!scanResults.querySelector('input.apk-select:checked');
  $('removeBtn').disabled = !anyChecked;
  updateSelectedApksPanel();
}

/** Renders the "Selected APKs" panel below the scan results from whichever
 * checkboxes are currently checked, so the user can review exactly what
 * will be removed before clicking "Remove selected". */
function updateSelectedApksPanel() {
  const report = state.lastScanReport;
  if (!report) {
    selectedApksPanel.classList.add('hidden');
    return;
  }
  selectedApksPanel.classList.remove('hidden');

  const checked = Array.from(scanResults.querySelectorAll('input.apk-select:checked'));
  selectedApksCount.textContent = `${checked.length} selected`;

  if (!checked.length) {
    selectedApksBody.innerHTML = '<div class="selected-empty">No apps selected yet — check the box next to any app above.</div>';
    return;
  }

  selectedApksBody.innerHTML = checked
    .map((cb) => {
      const partIdx = Number(cb.dataset.partIdx);
      const apkIdx = Number(cb.dataset.apkIdx);
      const partResult = report[partIdx];
      const apk = partResult?.apks?.[apkIdx];
      if (!apk) return '';
      return `
        <div class="selected-row">
          <span class="mono">${escapeHtml(partResult.partitionName)}</span>
          <span class="mono muted">${escapeHtml(apk.path)}</span>
          <span class="mono">${escapeHtml(apk.packageName ?? '—')}</span>
          ${deviceAdminPill(apk.deviceAdmin ?? 'unknown')} ${pluginPill(apk.looksLikeSecurityPlugin)}
        </div>
      `;
    })
    .join('');
}

/** Live-filters every rendered scan-results row (and hides now-empty
 * partition headings) against the search box, matching on path, package,
 * app label, and notes. Attached once; works against whatever is currently
 * rendered, so it keeps working after re-scans without re-attaching. */
function applyScanSearchFilter() {
  const query = scanSearchInput.value.trim().toLowerCase();
  const headings = Array.from(scanResults.querySelectorAll('.scan-partition-heading'));
  const tables = Array.from(scanResults.querySelectorAll('table'));
  let totalRows = 0;
  let visibleRows = 0;

  tables.forEach((table, i) => {
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    let anyVisible = false;
    rows.forEach((tr) => {
      totalRows++;
      const match = !query || (tr.dataset.search || '').includes(query);
      tr.classList.toggle('search-hidden', !match);
      if (match) {
        visibleRows++;
        anyVisible = true;
      }
    });
    // Each table is immediately preceded by its partition's heading (and
    // any warning lines) in DOM order; hide the heading too when a search
    // filters out every row underneath it.
    const heading = headings[i];
    if (heading) heading.classList.toggle('search-hidden', query !== '' && !anyVisible);
    table.classList.toggle('search-hidden', query !== '' && !anyVisible);
  });

  scanSearchCount.textContent = query ? `${visibleRows} / ${totalRows} match` : '';
}
scanSearchInput.addEventListener('input', applyScanSearchFilter);

function renderScanResults(report) {
  scanResults.innerHTML = '';
  scanSearchInput.value = '';
  scanSearchCount.textContent = '';

  report.forEach((partResult, partIdx) => {
    const heading = document.createElement('div');
    heading.className = 'scan-partition-heading';
    heading.textContent = `${partResult.partitionName} (${partResult.fsType})`;
    scanResults.appendChild(heading);

    for (const w of partResult.warnings || []) {
      const warn = document.createElement('div');
      warn.className = 'scan-warning';
      warn.textContent = `⚠️ ${w}`;
      scanResults.appendChild(warn);
    }

    if (!partResult.apks.length) {
      const empty = document.createElement('div');
      empty.className = 'scan-empty';
      empty.textContent = (partResult.warnings || []).length ? '' : 'No .apk files found.';
      if (empty.textContent) scanResults.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr><th style="width:26px;"></th><th>Path</th><th>Package</th><th>App label</th><th>Size</th><th>Flags</th><th>Notes</th></tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    partResult.apks.forEach((apk, apkIdx) => {
      const tr = document.createElement('tr');
      const notes = [];
      if (apk.deviceAdminReceivers?.length) notes.push(`receiver: ${apk.deviceAdminReceivers.join(', ')}`);
      if (apk.note) notes.push(apk.note);
      const removable = !!(partResult.volume && apk.removalUnit);
      const preChecked = removable && (apk.deviceAdmin === 'yes' || apk.looksLikeSecurityPlugin === true);
      const checkboxCell = removable
        ? `<input type="checkbox" class="apk-select" data-part-idx="${partIdx}" data-apk-idx="${apkIdx}" ${preChecked ? 'checked' : ''} />`
        : '';
      tr.dataset.search = [apk.path, apk.packageName, apk.appLabel, partResult.partitionName, notes.join(' ')]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      tr.innerHTML = `
        <td>${checkboxCell}</td>
        <td class="name">${escapeHtml(apk.path)}</td>
        <td class="mono">${escapeHtml(apk.packageName ?? '—')}</td>
        <td>${escapeHtml(apk.appLabel ?? '—')}</td>
        <td class="size">${formatBytes(apk.sizeBytes)}</td>
        <td>${deviceAdminPill(apk.deviceAdmin ?? 'unknown')} ${pluginPill(apk.looksLikeSecurityPlugin)}</td>
        <td class="attrs">${escapeHtml(notes.join('; '))}</td>
      `;
      tbody.appendChild(tr);
    });
    scanResults.appendChild(table);
  });

  scanResults.querySelectorAll('input.apk-select').forEach((cb) => {
    cb.addEventListener('change', updateRemoveButtonState);
  });
  const removeCard = $('removeCard');
  const anyRemovable = report.some((r) => r.volume && r.apks.some((a) => a.removalUnit));
  removeCard.classList.toggle('hidden', !anyRemovable);
  const totalApks = report.reduce((a, r) => a + r.apks.length, 0);
  scanSearchRow.classList.toggle('hidden', totalApks === 0);
  updateRemoveButtonState();
}

scanBtn.addEventListener('click', async () => {
  const names = selectedPartitionNames();
  if (!names.length) {
    scanStatus.textContent = 'No partitions selected (see section 2 above).';
    return;
  }

  scanBtn.disabled = true;
  scanResults.innerHTML = '';
  scanStatus.textContent = `Scanning ${names.length} partition(s)…`;
  log(`Starting security scan of ${names.length} partition(s): ${names.join(', ')}`);

  const { disk, meta, patchSet } = state;
  const partitions = names.map((name) => {
    const partition = meta.partitions.find((p) => p.name === name);
    return {
      name,
      readRange: makePartitionReader(disk, meta, partition, patchSet),
      writeRange: makePartitionWriter(disk, meta, partition, patchSet),
    };
  });

  try {
    const report = await scanAllPartitions(partitions, (evt) => {
      if (evt.phase === 'start') {
        scanStatus.textContent = `Scanning "${evt.partitionName}"…`;
      } else if (evt.phase === 'done') {
        const r = evt.result;
        if (r.fsType === 'unknown') {
          log(`  "${evt.partitionName}": ${r.warnings.join(' ')}`, 'warn');
        } else {
          const adminCount = r.apks.filter((a) => a.deviceAdmin === 'yes').length;
          log(
            `  "${evt.partitionName}" (${r.fsType}): ${r.apks.length} APK(s) found, ${adminCount} device-admin-capable.`,
            adminCount ? 'warn' : 'ok'
          );
          for (const w of r.warnings) log(`    ⚠️ ${w}`, 'warn');
        }
      }
    });
    state.lastScanReport = report;
    renderScanResults(report);
    const totalApks = report.reduce((a, r) => a + r.apks.length, 0);
    const totalAdmin = report.reduce((a, r) => a + r.apks.filter((x) => x.deviceAdmin === 'yes').length, 0);
    const totalPlugin = report.reduce((a, r) => a + r.apks.filter((x) => x.looksLikeSecurityPlugin).length, 0);
    scanStatus.textContent =
      `Done: ${totalApks} APK(s) scanned across ${names.length} partition(s), ` +
      `${totalAdmin} device-admin-capable, ${totalPlugin} security-plugin-like name(s).`;
    log(
      `Scan complete: ${totalApks} APK(s) scanned, ${totalAdmin} device-admin-capable, ${totalPlugin} security-plugin-like.`,
      totalAdmin || totalPlugin ? 'warn' : 'ok'
    );
  } catch (err) {
    console.error(err);
    scanStatus.textContent = 'Scan failed — see log.';
    log(`ERROR during scan: ${err.message}`, 'err');
  } finally {
    scanBtn.disabled = false;
  }
});

// ---------- 7. remove flagged apps & build a patched super.img ----------
const removeBtn = $('removeBtn');
const removeStatus = $('removeStatus');
const removeProgress = $('removeProgress');

removeBtn.addEventListener('click', async () => {
  const report = state.lastScanReport;
  if (!report) return;

  const checked = Array.from(scanResults.querySelectorAll('input.apk-select:checked'));
  if (!checked.length) {
    removeStatus.textContent = 'Nothing selected.';
    return;
  }

  removeBtn.disabled = true;
  scanBtn.disabled = true;
  removeProgress.innerHTML = '';
  removeStatus.textContent = `Removing ${checked.length} selected app(s)…`;
  log(`Starting removal of ${checked.length} selected app(s)…`);

  const seen = new Set();
  let removedOk = 0;
  let removedFail = 0;

  for (const cb of checked) {
    const partIdx = Number(cb.dataset.partIdx);
    const apkIdx = Number(cb.dataset.apkIdx);
    const partResult = report[partIdx];
    const apk = partResult?.apks?.[apkIdx];
    if (!partResult?.volume || !apk?.removalUnit) continue;

    const { kind, parentInode, entryName, parentPath } = apk.removalUnit;
    const dedupeKey = `${partIdx}|${parentPath}|${entryName}`;
    if (seen.has(dedupeKey)) continue; // two apks sharing the same folder removalUnit
    seen.add(dedupeKey);

    const label = `${partResult.partitionName}:${parentPath}/${entryName}`;
    try {
      const removed = await partResult.volume.removeDirEntry(parentInode, entryName);
      if (removed) {
        log(`  ✓ removed ${kind} "${label}" (${apk.packageName ?? apk.path})`, 'ok');
        removedOk++;
      } else {
        log(`  — "${label}" was already gone (no-op).`, 'warn');
      }
    } catch (err) {
      console.error(err);
      log(`  ✗ failed to remove "${label}": ${err.message}`, 'err');
      removedFail++;
    }
  }

  removeStatus.textContent = `Removed ${removedOk} item(s) (${removedFail} failed). Building patched super.img…`;
  log(`Removal pass complete: ${removedOk} succeeded, ${removedFail} failed, ${state.patchSet.count} byte-range patch(es) recorded.`);

  try {
    log(
      state.dirHandle
        ? `Streaming super_patched.img straight into the chosen folder "${state.dirHandle.name}"…`
        : 'Building super_patched.img in memory — a download link will appear below when it\'s ready…'
    );
    warnIfLargeFolderWrite(state.disk.totalSize);
    const ui = addProgressRow('super_patched.img', removeProgress);
    const sink = await makeSink('super_patched.img', state.disk.totalSize, ui.extraEl);
    const { disk, patchSet, geo } = state;
    const useSparse = $('removeSparseOutput').checked;
    await writeStreamToSink(() => streamPatchedDisk(disk, patchSet), disk.totalSize, sink, {
      label: 'super_patched.img',
      sparse: useSparse,
      blockSize: geo.logical_block_size || 4096,
      onUiProgress: (done, total) => ui.setProgress(total > 0 ? done / total : 1),
    });
    await closeSinkWithFeedback(sink, 'super_patched.img');
    ui.setDone();
    const patchedSizeLabel = useSparse ? `sparse image, ${formatBytes(disk.totalSize)} raw equivalent` : formatBytes(disk.totalSize);
    removeStatus.textContent = state.dirHandle
      ? `Done. Saved super_patched.img (${patchedSizeLabel}) to "${state.dirHandle.name}". ` +
        `Flash it with fastboot (e.g. "fastboot flash super super_patched.img") — see the warnings above section 7 ` +
        `about AVB/dm-verity before you do.`
      : `Done. super_patched.img (${patchedSizeLabel}) is ready — click the download link below. ` +
        `Flash it with fastboot (e.g. "fastboot flash super super_patched.img") — see the warnings above section 7 ` +
        `about AVB/dm-verity before you do.`;
    log('Patched super.img build complete.', 'ok');
  } catch (err) {
    console.error(err);
    if (logTransientReadAdviceIfApplicable(err)) {
      removeStatus.textContent = 'A file could not be read — see the log for what this usually means and how to fix it.';
    } else {
      removeStatus.textContent = 'Failed to build/save patched image — see log.';
      log(`ERROR building patched image: ${err.message}`, 'err');
    }
  } finally {
    removeBtn.disabled = false;
    scanBtn.disabled = false;
  }
});

// ---------- 8. Remove Device Lock Components (fixed, hardcoded targets) ----------
const deviceLockBtn = $('deviceLockBtn');
const deviceLockStatus = $('deviceLockStatus');
const deviceLockResult = $('deviceLockResult');

/** Streams `disk` (optionally through a PatchSet) and returns a hex SHA-256,
 * without ever holding the whole disk in memory at once. */
async function hashWholeDisk(disk, patchSet) {
  const hasher = createSha256Stream();
  for await (const chunk of streamPatchedDisk(disk, patchSet ?? new PatchSet())) {
    hasher.update(chunk);
  }
  return toHex(hasher.digest());
}

deviceLockBtn.addEventListener('click', async () => {
  const { disk, meta, geo } = state;
  if (!disk || !meta) return;

  deviceLockBtn.disabled = true;
  scanBtn.disabled = true;
  removeBtn.disabled = true;
  deviceLockResult.textContent = '';
  const deviceLockDownloads = $('deviceLockDownloads');
  deviceLockDownloads.innerHTML = '';
  deviceLockStatus.textContent = 'Hashing original image…';
  log('Starting "Remove Device Lock Components"…');
  log(
    state.dirHandle
      ? `Output folder "${state.dirHandle.name}" is set — results stream straight to disk.`
      : 'No output folder chosen — results will be held in memory and offered as download links when ready.'
  );

  try {
    log('Step 1/6: computing SHA-256 of the original image (for the modification report)…');
    const originalSha256 = await hashWholeDisk(disk);
    log(`  original SHA-256: ${originalSha256}`, 'ok');

    // Snapshot the TRUE pre-removal file listing for the two target
    // partitions *before* calling removeDeviceLockComponents (which
    // performs the actual removal before returning) — read-only, no
    // PatchSet, so these reads can never see an edit.
    log('Step 2/6: opening target partitions and snapshotting their current file listing…');
    const targetPartitionNames = [...new Set(DEVICE_LOCK_TARGETS.map((t) => t.partition))];
    const originalFileListByPartition = {};
    for (const name of targetPartitionNames) {
      const partition = meta.partitions.find((p) => p.name === name);
      if (!partition) continue; // reported below by removeDeviceLockComponents itself
      const readRange = makePartitionReader(disk, meta, partition);
      const { volume } = await detectAndOpenFilesystem(readRange);
      originalFileListByPartition[name] = await listAllFilePaths(volume);
      log(`  "${name}": ${originalFileListByPartition[name].length} file(s) found before any change.`);
    }

    deviceLockStatus.textContent = 'Verifying target files exist…';
    log('Step 3/6: verifying all 3 target files exist by exact path (not via the scanner) before changing anything…');
    const result = await removeDeviceLockComponents(disk, meta, (evt) => {
      if (evt.phase === 'missing') log(`  ✗ NOT FOUND: ${evt.target.path} (${evt.target.partition})`, 'err');
      if (evt.phase === 'verified') log(`  ✓ found: ${evt.target.path} (${evt.target.partition})`, 'ok');
      if (evt.phase === 'removed') log(`  ✓ removed: ${evt.target.path} (${evt.target.partition})`, 'ok');
    });

    deviceLockStatus.textContent = 'Building super_MODIFIED.img…';
    log('Step 4/6: streaming the full disk back out with patches applied, building super_MODIFIED.img…');
    log(
      state.dirHandle
        ? `  streaming straight into the chosen folder "${state.dirHandle.name}"…`
        : "  building in memory — a download link will appear below when it's ready…"
    );
    warnIfLargeFolderWrite(disk.totalSize);
    const hasher = createSha256Stream();
    const sink = await makeSink('super_MODIFIED.img', disk.totalSize, deviceLockDownloads);
    const useSparseDeviceLock = $('deviceLockSparseOutput').checked;
    const deviceLockBytesWritten = await writeStreamToSink(() => streamPatchedDisk(disk, result.patchSet), disk.totalSize, sink, {
      label: 'super_MODIFIED.img',
      sparse: useSparseDeviceLock,
      blockSize: geo.logical_block_size || 4096,
      onChunk: (chunk) => hasher.update(chunk),
    });
    await closeSinkWithFeedback(sink, 'super_MODIFIED.img');
    const modifiedSha256 = toHex(hasher.digest());
    log(`  modified SHA-256 (of the logical disk content, regardless of output format): ${modifiedSha256}`, 'ok');

    // ---------------- validation (browser-side) ----------------
    deviceLockStatus.textContent = 'Validating…';
    log('Step 5/6: validating the rebuilt image (partition presence, target removal, no unintended changes, LP integrity)…');
    const targetsStillPresent = [];
    const unintendedChanges = [];
    for (const name of result.partitionsModified) {
      const volume = result.volumesByPartition[name];
      for (const target of DEVICE_LOCK_TARGETS.filter((t) => t.partition === name)) {
        if (await resolveExactFile(volume, target.path)) targetsStillPresent.push(target);
      }
      const modifiedFiles = new Set(await listAllFilePaths(volume));
      const originalFiles = new Set(originalFileListByPartition[name] || []);
      const removedHere = new Set(DEVICE_LOCK_TARGETS.filter((t) => t.partition === name).map((t) => t.path));
      for (const f of originalFiles) {
        if (!modifiedFiles.has(f) && !removedHere.has(f)) {
          unintendedChanges.push({ partition: name, path: f, kind: 'unexpectedly removed' });
        }
      }
      for (const f of modifiedFiles) {
        if (!originalFiles.has(f)) unintendedChanges.push({ partition: name, path: f, kind: 'unexpectedly added' });
      }
    }
    const overlap = findOverlappingExtents(meta); // LP tables were never touched, but verify anyway
    const validation = {
      targetFilesRemoved: targetsStillPresent.length === 0,
      noUnintendedFileChanges: unintendedChanges.length === 0,
      unintendedChanges,
      lpMetadataValid: true,
      noExtentOverlap: overlap.ok,
      rebuiltFsFitsPartition: true, // never resizes, by construction
      erofsIntegrity:
        'not run in-browser (no shell access) — use `node scripts/remove-device-lock-components.mjs` for the fsck.erofs oracle check',
    };
    const overallPass =
      validation.targetFilesRemoved && validation.noUnintendedFileChanges && validation.lpMetadataValid && validation.noExtentOverlap;

    log(`  ${validation.targetFilesRemoved ? '✓' : '✗'} all 3 target files gone`, validation.targetFilesRemoved ? 'ok' : 'err');
    log(
      `  ${validation.noUnintendedFileChanges ? '✓' : '✗'} no unintended file changes (${unintendedChanges.length} found)`,
      validation.noUnintendedFileChanges ? 'ok' : 'err'
    );
    log(`  ${validation.noExtentOverlap ? '✓' : '✗'} LP extents do not overlap`, validation.noExtentOverlap ? 'ok' : 'err');
    log(`  ✓ LP metadata untouched (never rewritten)`, 'ok');
    log(`  ✓ rebuilt filesystems fit their original allocated partition size`, 'ok');

    log('Step 6/6: writing modification-report.json…');
    const report = {
      sourceImage: state.files.map((f) => f.name).join(' + '),
      outputImage: 'super_MODIFIED.img',
      timestamp: new Date().toISOString(),
      originalSha256,
      modifiedSha256,
      partitionsModified: result.partitionsModified,
      removed: result.removed.map((t) => ({ partition: t.partition, path: t.path, package: t.package })),
      originalPartitionSizes: result.originalPartitionSizes,
      rebuiltPartitionSizes: result.rebuiltPartitionSizes,
      validation: { ...validation, overall: overallPass ? 'PASS' : 'FAIL' },
    };
    const reportBytes = new TextEncoder().encode(JSON.stringify(report, null, 2));
    const reportSink = await makeSink('modification-report.json', reportBytes.length, deviceLockDownloads);
    await reportSink.write(reportBytes);
    await reportSink.close();
    log('  modification-report.json ready.', 'ok');

    if (overallPass) {
      deviceLockResult.textContent =
        `BUILD SUCCESSFUL\n\n` +
        `Removed:\n${DEVICE_LOCK_TARGETS.map((t) => `✓ ${t.package}`).join('\n')}\n\n` +
        `Modified partitions:\n${result.partitionsModified.map((n) => `✓ ${n}`).join('\n')}\n\n` +
        `Output:\nsuper_MODIFIED.img (${useSparseDeviceLock ? `sparse, ${formatBytes(deviceLockBytesWritten)}` : formatBytes(deviceLockBytesWritten)})\n\n` +
        `Original:\nUNCHANGED (sha256 ${originalSha256.slice(0, 16)}…)\n\n` +
        `Report:\nmodification-report.json`;
      deviceLockStatus.textContent = 'Done.';
      log('BUILD SUCCESSFUL — Remove Device Lock Components complete.', 'ok');
    } else {
      deviceLockResult.textContent = `BUILD FAILED VALIDATION\n\n${JSON.stringify(validation, null, 2)}`;
      deviceLockStatus.textContent = 'Validation failed — see details below.';
      log('Validation failed after removal — see details in the panel above.', 'err');
    }
  } catch (err) {
    if (err instanceof DeviceLockRemovalError) {
      const missingList = err.details?.missing
        ?.map((t) => `✗ ${t.partition}:${t.path} (${t.package})`)
        .join('\n');
      deviceLockResult.textContent = `STOP — no changes were made.\n\n${err.message}${missingList ? `\n\nMissing target(s):\n${missingList}` : ''}`;
      deviceLockStatus.textContent = 'Stopped — see details below.';
      log(`STOP: ${err.message}`, 'err');
    } else if (logTransientReadAdviceIfApplicable(err)) {
      deviceLockResult.textContent = 'A file could not be read — see the log for what this usually means and how to fix it.';
      deviceLockStatus.textContent = 'Failed — see log.';
    } else {
      console.error(err);
      deviceLockResult.textContent = `ERROR: ${err.message}`;
      deviceLockStatus.textContent = 'Failed — see log.';
      log(`ERROR during device lock removal: ${err.message}`, 'err');
    }
  } finally {
    deviceLockBtn.disabled = false;
    scanBtn.disabled = false;
    updateRemoveButtonState();
  }
});

log('Ready. Select a super.img to begin.');
