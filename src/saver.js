// Abstraction over the different ways we can get extracted partition bytes
// onto the user's actual disk, from best to most-compatible:
//
//  1. File System Access API directory handle: true "save to a folder",
//     streamed, works for files of any size.
//  2. File System Access API showSaveFilePicker: per-file "Save As" dialog,
//     still streamed straight to disk, no folder required.
//  3. Classic <a download> + Blob: works everywhere, but the whole file has
//     to be held in memory first, so it's unsuitable for very large
//     partitions on memory-constrained devices/browsers.

export function supportsDirectoryPicker() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export function supportsSaveFilePicker() {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

export async function pickDirectory() {
  return await window.showDirectoryPicker({ mode: 'readwrite' });
}

export async function verifyDirectoryPermission(dirHandle) {
  const opts = { mode: 'readwrite' };
  if ((await dirHandle.queryPermission(opts)) === 'granted') return true;
  return (await dirHandle.requestPermission(opts)) === 'granted';
}

/** Sink that writes into a file inside an already-picked directory handle. */
export async function directorySink(dirHandle, filename) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  return {
    write: (chunk) => writable.write(chunk),
    close: () => writable.close(),
    abort: () => writable.abort().catch(() => {}),
  };
}

/** Sink using a per-file native "Save As" dialog, still streamed to disk. */
export async function saveFilePickerSink(filename) {
  const handle = await window.showSaveFilePicker({ suggestedName: filename });
  const writable = await handle.createWritable();
  return {
    write: (chunk) => writable.write(chunk),
    close: () => writable.close(),
    abort: () => writable.abort().catch(() => {}),
  };
}

/**
 * Fallback sink: buffers everything in memory, then triggers a normal
 * browser download. `onLargeSizeWarning` fires once if the accumulated
 * size crosses `warnThresholdBytes`, so the UI can warn the user their
 * browser/tab may run out of memory.
 */
export function blobDownloadSink(filename, opts = {}) {
  const { warnThresholdBytes = 1.5 * 1024 * 1024 * 1024, onLargeSizeWarning } = opts;
  const parts = [];
  let total = 0;
  let warned = false;
  return {
    write: async (chunk) => {
      parts.push(chunk);
      total += chunk.length;
      if (!warned && total > warnThresholdBytes) {
        warned = true;
        onLargeSizeWarning && onLargeSizeWarning(total);
      }
    },
    close: async () => {
      const blob = new Blob(parts);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    abort: async () => {
      parts.length = 0;
    },
  };
}
