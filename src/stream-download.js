// True streaming downloads via a small service worker (see
// public/stream-download-sw.js), for browsers/contexts that don't support
// the File System Access API (Firefox, Safari, mobile browsers, or a
// desktop Chrome/Edge where the folder/file picker is blocked because the
// page is embedded in a cross-origin iframe). This is what makeSink() in
// main.js falls back to automatically -- no folder picker, no "Save As"
// dialog, no buffering the whole file in page memory: the browser's own
// download manager streams it straight to the user's normal Downloads
// folder, exactly like clicking any other download link.

/**
 * A simple counting semaphore: release() can be called before anyone is
 * waiting (the permit is banked for the next acquire()) or after (it wakes
 * the oldest waiter), and acquire() can be called before or after any
 * release() -- signals are never lost regardless of arrival order. Used
 * for the backpressure protocol between this page and the download
 * service worker's "pull" messages.
 *
 * Deliberately NOT implemented as a single reassigned Promise "gate": a
 * naive gate drops any release() that arrives while nothing is currently
 * awaiting it (the previous, buggy version of this file did exactly that),
 * which deadlocks a later acquire() forever once the worker's ReadableStream
 * sends more than one "pull" ahead of the page's writes -- which it does in
 * practice, e.g. once the browser's own download/network pipe starts
 * reading ahead.
 */
export function createPermitQueue() {
  let availablePermits = 0;
  const waiters = [];
  let failure = null;

  function acquire() {
    if (failure) return Promise.reject(failure);
    if (availablePermits > 0) {
      availablePermits--;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }

  function release() {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve();
    else availablePermits++;
  }

  function failAll(err) {
    failure = err;
    while (waiters.length) waiters.shift().reject(err);
  }

  return { acquire, release, failAll };
}

export function supportsStreamingDownload() {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof ReadableStream === 'function' &&
    typeof MessageChannel === 'function'
  );
}

let workerReadyPromise = null;

/** Registers (once) the streaming-download service worker and waits until
 * it's actually controlling *this* page -- `clients.claim()` in its
 * activate handler normally makes that near-instant even though the page
 * loaded before the worker existed, so no page reload is required. */
async function ensureStreamDownloadWorker() {
  if (!supportsStreamingDownload()) {
    throw new Error('Service workers are not available in this browser/context.');
  }
  if (!workerReadyPromise) {
    workerReadyPromise = (async () => {
      await navigator.serviceWorker.register('/stream-download-sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          const check = () => {
            if (navigator.serviceWorker.controller) {
              navigator.serviceWorker.removeEventListener('controllerchange', check);
              resolve();
            }
          };
          navigator.serviceWorker.addEventListener('controllerchange', check);
          // In case claim() already happened in the brief window before we
          // attached the listener above.
          const poll = setInterval(() => {
            if (navigator.serviceWorker.controller) {
              clearInterval(poll);
              navigator.serviceWorker.removeEventListener('controllerchange', check);
              resolve();
            }
          }, 50);
        });
      }
    })();
  }
  return workerReadyPromise;
}

/**
 * Creates a write()/close()/abort() sink (same shape as the other sinks in
 * saver.js) that streams its bytes straight into a real, automatic browser
 * download -- memory use stays bounded to ~1 chunk in flight regardless of
 * the total size, thanks to the worker's pull-based backpressure.
 *
 * @param {string} filename
 * @param {number|null} [totalSizeBytes] optional, used for a Content-Length
 *   header (nicer download-progress UI in the browser); omit if unknown.
 */
export async function createStreamingDownloadSink(filename, totalSizeBytes = null) {
  await ensureStreamDownloadWorker();

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const channel = new MessageChannel();

  // Backpressure for the worker's "pull" signals -- see createPermitQueue()
  // doc comment for why this can't just be a single reassigned Promise.
  const permits = createPermitQueue();

  let resolveRegistered = null;
  const registered = new Promise((resolve) => {
    resolveRegistered = resolve;
  });

  channel.port1.onmessage = (ev) => {
    const data = ev.data;
    if (!data) return;
    if (data.type === 'registered') {
      resolveRegistered();
    } else if (data.type === 'pull') {
      permits.release();
    } else if (data.type === 'cancelled') {
      permits.failAll(new Error(`Download was cancelled in the browser${data.reason ? `: ${data.reason}` : '.'}`));
    }
  };

  navigator.serviceWorker.controller.postMessage(
    { type: 'register-stream', id, filename, size: totalSizeBytes },
    [channel.port2]
  );
  // MUST wait for the worker's explicit ack before navigating to the
  // intercepted URL below -- postMessage delivery is asynchronous, so
  // without this handshake there's a real race where the download
  // navigation could reach the worker's fetch handler before its message
  // handler has stored the pending stream, falling through to a normal
  // (non-intercepted) 404 response that would navigate the whole page away.
  await registered;

  // Trigger the actual download: navigate a hidden same-origin iframe to
  // the intercepted URL. This is the same technique the battle-tested
  // StreamSaver.js library uses in secure (HTTPS) contexts: the service
  // worker's fetch handler responds with our stream, and
  // Content-Disposition: attachment makes the browser save it like any
  // normal download, without ever navigating (or being able to navigate)
  // the actual app page itself away.
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = `/__download__/${id}`;
  document.body.appendChild(iframe);

  let closed = false;
  return {
    write: async (chunk) => {
      await permits.acquire(); // backpressure: wait for a "pull" permit from the worker
      // Transfer (not copy) the chunk's backing buffer -- streamPatchedDisk
      // always yields a freshly-allocated Uint8Array per piece, so this is
      // safe and avoids doubling memory use for no reason.
      channel.port1.postMessage({ type: 'chunk', chunk }, [chunk.buffer]);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      channel.port1.postMessage({ type: 'end' });
      setTimeout(() => iframe.remove(), 60_000);
    },
    abort: async (reason) => {
      if (closed) return;
      closed = true;
      try {
        channel.port1.postMessage({ type: 'abort', reason: String(reason || 'cancelled') });
      } catch {
        /* ignore */
      }
      iframe.remove();
    },
  };
}
