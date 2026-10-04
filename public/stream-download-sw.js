// A tiny "man-in-the-middle" service worker that turns an in-page
// ReadableStream (fed chunk-by-chunk from the main thread) into a normal
// browser download -- streamed straight through the browser's own
// download manager into the user's default Downloads folder, with no
// folder picker, no "Save As" dialog, and no need to buffer the whole
// file in page memory first.
//
// How it works: the page registers a pending stream under a random id
// (register-stream message, below), then navigates a hidden iframe to
// /__download__/<id>. This service worker's fetch handler intercepts
// that same-origin request and responds with a Response wrapping the
// ReadableStream, with a Content-Disposition: attachment header -- which
// makes the browser treat it exactly like any other file download.
//
// Backpressure: the ReadableStream uses a count queuing strategy with
// highWaterMark 1, and only asks the page for the next chunk (a "pull"
// message) once the previous one has actually been consumed by the
// browser's download/network stack -- so at most ~1 chunk is ever
// in flight, keeping memory bounded regardless of the total file size.

const pending = new Map(); // id -> ReadableStream

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'register-stream') return;
  const port = event.ports[0];

  const stream = new ReadableStream(
    {
      start(controller) {
        port.onmessage = (ev) => {
          const data = ev.data;
          if (!data) return;
          if (data.type === 'chunk') {
            controller.enqueue(new Uint8Array(data.chunk));
          } else if (data.type === 'end') {
            controller.close();
          } else if (data.type === 'abort') {
            controller.error(new Error(data.reason || 'Upload to download-stream aborted.'));
          }
        };
        // Permit the very first chunk right away.
        port.postMessage({ type: 'pull' });
      },
      pull() {
        // The consumer (browser network/download stack) just dequeued a
        // chunk and has room for another -- ask the page for more.
        port.postMessage({ type: 'pull' });
      },
      cancel(reason) {
        port.postMessage({ type: 'cancelled', reason: String(reason || '') });
      },
    },
    new CountQueuingStrategy({ highWaterMark: 1 })
  );

  pending.set(msg.id, { stream, filename: msg.filename, size: msg.size });
  // Explicit ack: the page MUST wait for this before navigating to
  // /__download__/<id> -- postMessage delivery is asynchronous, so without
  // this handshake there's a real race where the download navigation could
  // arrive before this handler has stored the pending stream, causing the
  // fetch handler below to fall through to a normal (non-intercepted) 404
  // response and actually navigate the page away.
  port.postMessage({ type: 'registered' });
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^\/__download__\/([^/]+)$/);
  if (!match) return; // not ours -- let the page/network handle it normally

  const entry = pending.get(match[1]);
  if (!entry) return; // unknown/already-consumed id -- fall through to a normal 404

  pending.delete(match[1]);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(entry.filename)}"`,
    'Cache-Control': 'no-store',
  };
  if (entry.size != null) headers['Content-Length'] = String(entry.size);
  event.respondWith(new Response(entry.stream, { headers }));
});
