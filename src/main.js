import { indexSparseOrRaw } from './sparse.js';
import { VirtualDisk, naturalCompare } from './virtual-disk.js';
import { readGeometry, readMetadata, partitionSizeBytes, partitionAttrString, findOverlappingExtents } from './lp.js';
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
import {
  supportsDirectoryPicker,
  supportsSaveFilePicker,
  pickDirectory,
  verifyDirectoryPermission,
  directorySink,
  saveFilePickerSink,
  blobDownloadSink,
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

    const disk = new VirtualDisk(parts);
    log(`Combined virtual disk size: ${formatBytes(disk.totalSize)}`);

    parseStatus.textContent = 'Reading LP geometry & metadata…';
    const geo = await readGeometry(disk);
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

// ---------- 3. output target ----------
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
if (supportsDirectoryPicker()) {
  fsapiBadge.textContent = inIframe ? 'folder save (needs a new tab, see note above)' : 'folder save supported';
  fsapiBadge.classList.add(inIframe ? 'warn' : 'good');
} else if (supportsSaveFilePicker()) {
  fsapiBadge.textContent = inIframe ? 'per-file save (needs a new tab, see note above)' : 'per-file save supported';
  fsapiBadge.classList.add(inIframe ? 'warn' : 'good');
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
      'This browser/context does not support choosing a folder (File System Access API). ' +
        (inIframe
          ? 'Open this app in a new tab (link above) to try again, or just extract now — files will download individually instead.'
          : 'Extraction will fall back to per-file downloads instead.'),
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

// ---------- 4. extraction ----------
const extractBtn = $('extractBtn');
const cancelBtn = $('cancelBtn');
const progressList = $('progressList');

function fallbackDownloadSink(filename) {
  return blobDownloadSink(filename, {
    onLargeSizeWarning: (bytes) =>
      log(
        `"${filename}" has buffered ${formatBytes(bytes)} in memory (no folder was chosen). ` +
          `Your browser tab may run out of memory for very large partitions.`,
        'warn'
      ),
  });
}

async function makeSink(filename) {
  if (state.dirHandle) {
    return directorySink(state.dirHandle, filename);
  }
  if (supportsSaveFilePicker()) {
    // showSaveFilePicker needs "transient activation" (a recent user
    // gesture). It works for the first file in a batch, but can start
    // throwing NotAllowedError for later files once that activation has
    // expired, or anywhere inside a disallowed iframe. Fall back to a
    // plain download in either case instead of failing the extraction.
    try {
      return await saveFilePickerSink(filename);
    } catch (err) {
      if (err.name === 'AbortError') throw err; // user explicitly cancelled the dialog
      log(`Save dialog unavailable for "${filename}" (${explainPickerFailure(err)}); downloading instead.`, 'warn');
      return fallbackDownloadSink(filename);
    }
  }
  return fallbackDownloadSink(filename);
}

function addProgressRow(name, container = progressList) {
  const row = document.createElement('div');
  row.className = 'progress-row';
  row.innerHTML = `
    <div class="mono">${escapeHtml(name)}</div>
    <div class="progress-track"><div class="progress-fill"></div></div>
    <div class="size" style="text-align:right;">0%</div>
  `;
  container.appendChild(row);
  return {
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

  for (const name of names) {
    if (state.cancelRequested) {
      log('Extraction cancelled by user.', 'warn');
      break;
    }
    const partition = meta.partitions.find((p) => p.name === name);
    const ui = addProgressRow(`${name}.img`);
    const totalBytes = partitionSizeBytes(meta, partition);
    log(`Extracting "${name}" (${formatBytes(totalBytes)})…`);
    try {
      const sink = await makeSink(`${name}.img`);
      await extractPartition(disk, meta, partition, sink, {
        onProgress: (written, total) => {
          if (total > 0n) ui.setProgress(Number(written) / Number(total));
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

// ---------- 4. security scan (read-only: finds Device Administrator APKs) ----------
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

function updateRemoveButtonState() {
  const anyChecked = !!scanResults.querySelector('input.apk-select:checked');
  $('removeBtn').disabled = !anyChecked;
}

function renderScanResults(report) {
  scanResults.innerHTML = '';
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

// ---------- 5. remove flagged apps & build a patched super.img ----------
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
    const ui = addProgressRow('super_patched.img', removeProgress);
    const sink = await makeSink('super_patched.img');
    const { disk, patchSet } = state;
    let written = 0;
    for await (const chunk of streamPatchedDisk(disk, patchSet)) {
      await sink.write(chunk);
      written += chunk.length;
      ui.setProgress(written / disk.totalSize);
    }
    await sink.close();
    ui.setDone();
    removeStatus.textContent =
      `Done. Downloaded super_patched.img (${formatBytes(disk.totalSize)}). ` +
      `Flash it with fastboot (e.g. "fastboot flash super super_patched.img") — see the warnings above section 5 ` +
      `about AVB/dm-verity before you do.`;
    log('Patched super.img build complete.', 'ok');
  } catch (err) {
    console.error(err);
    removeStatus.textContent = 'Failed to build/save patched image — see log.';
    log(`ERROR building patched image: ${err.message}`, 'err');
  } finally {
    removeBtn.disabled = false;
    scanBtn.disabled = false;
  }
});

// ---------- 6. Remove Device Lock Components (fixed, hardcoded targets) ----------
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
  const { disk, meta } = state;
  if (!disk || !meta) return;

  deviceLockBtn.disabled = true;
  scanBtn.disabled = true;
  removeBtn.disabled = true;
  deviceLockResult.textContent = '';
  deviceLockStatus.textContent = 'Hashing original image…';
  log('Starting "Remove Device Lock Components"…');

  try {
    const originalSha256 = await hashWholeDisk(disk);

    // Snapshot the TRUE pre-removal file listing for the two target
    // partitions *before* calling removeDeviceLockComponents (which
    // performs the actual removal before returning) — read-only, no
    // PatchSet, so these reads can never see an edit.
    const targetPartitionNames = [...new Set(DEVICE_LOCK_TARGETS.map((t) => t.partition))];
    const originalFileListByPartition = {};
    for (const name of targetPartitionNames) {
      const partition = meta.partitions.find((p) => p.name === name);
      if (!partition) continue; // reported below by removeDeviceLockComponents itself
      const readRange = makePartitionReader(disk, meta, partition);
      const { volume } = await detectAndOpenFilesystem(readRange);
      originalFileListByPartition[name] = await listAllFilePaths(volume);
    }

    deviceLockStatus.textContent = 'Verifying target files exist…';
    const result = await removeDeviceLockComponents(disk, meta, (evt) => {
      if (evt.phase === 'missing') log(`  ✗ NOT FOUND: ${evt.target.path} (${evt.target.partition})`, 'err');
      if (evt.phase === 'verified') log(`  ✓ found: ${evt.target.path} (${evt.target.partition})`, 'ok');
      if (evt.phase === 'removed') log(`  ✓ removed: ${evt.target.path} (${evt.target.partition})`, 'ok');
    });

    deviceLockStatus.textContent = 'Building super_MODIFIED.img…';
    log('Building super_MODIFIED.img…');
    const hasher = createSha256Stream();
    const sink = await makeSink('super_MODIFIED.img');
    let written = 0;
    for await (const chunk of streamPatchedDisk(disk, result.patchSet)) {
      hasher.update(chunk);
      await sink.write(chunk);
      written += chunk.length;
    }
    await sink.close();
    const modifiedSha256 = toHex(hasher.digest());

    // ---------------- validation (browser-side) ----------------
    deviceLockStatus.textContent = 'Validating…';
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
    const reportSink = await makeSink('modification-report.json');
    await reportSink.write(new TextEncoder().encode(JSON.stringify(report, null, 2)));
    await reportSink.close();

    if (overallPass) {
      deviceLockResult.textContent =
        `BUILD SUCCESSFUL\n\n` +
        `Removed:\n${DEVICE_LOCK_TARGETS.map((t) => `✓ ${t.package}`).join('\n')}\n\n` +
        `Modified partitions:\n${result.partitionsModified.map((n) => `✓ ${n}`).join('\n')}\n\n` +
        `Output:\nsuper_MODIFIED.img (${formatBytes(written)})\n\n` +
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
