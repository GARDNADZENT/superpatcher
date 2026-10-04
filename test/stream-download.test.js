// Unit tests for the pure, environment-independent logic in
// src/stream-download.js. The module as a whole needs a real browser
// (navigator.serviceWorker, MessageChannel, document, a real service
// worker) to exercise end-to-end, which this Node-based suite can't do --
// that was instead verified manually against a live Chrome instance this
// session (small + 640 MiB transfers, byte-exact, ~20 MB flat JS heap
// throughout, and a full click-through of the app's UI). This file covers
// createPermitQueue() in isolation, since a bug in exactly this logic
// (a naive single-Promise "gate" that silently dropped release() signals
// arriving before anyone was waiting) caused a real, reproducible deadlock
// that only manifested after a few chunks -- exactly the kind of bug a
// unit test should pin down so it can never silently come back.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPermitQueue } from '../src/stream-download.js';

test('createPermitQueue: acquire() resolves immediately once a permit is already banked', async () => {
  const q = createPermitQueue();
  q.release();
  await q.acquire(); // must not hang
});

test('createPermitQueue: acquire() waits until release() is called', async () => {
  const q = createPermitQueue();
  let acquired = false;
  const p = q.acquire().then(() => {
    acquired = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(acquired, false, 'must not resolve before release()');
  q.release();
  await p;
  assert.equal(acquired, true);
});

test('createPermitQueue: multiple release() calls before any acquire() are all banked (the exact regression case)', async () => {
  // This is exactly the scenario that broke the old single-Promise "gate"
  // implementation: several releases ("pull" messages from the download
  // worker) arrive back-to-back before the consumer ever calls acquire()
  // (writes a chunk). Every banked permit must still be honored in order,
  // with no permit silently lost.
  const q = createPermitQueue();
  q.release();
  q.release();
  q.release();

  await q.acquire();
  await q.acquire();
  await q.acquire();
  // A 4th acquire() must NOT resolve yet (no 4th permit was ever released).
  let fourthResolved = false;
  const fourth = q.acquire().then(() => {
    fourthResolved = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fourthResolved, false);
  q.release();
  await fourth;
  assert.equal(fourthResolved, true);
});

test('createPermitQueue: interleaved acquire()/release() in FIFO order, simulating real chunk-by-chunk traffic', async () => {
  const q = createPermitQueue();
  const order = [];

  async function consumer(id) {
    await q.acquire();
    order.push(id);
  }

  // Start 5 consumers immediately (none have a permit yet).
  const consumers = [1, 2, 3, 4, 5].map((id) => consumer(id));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, []);

  // Release one at a time, with a delay between each -- each release
  // should unblock exactly the next-oldest waiting consumer, in order.
  for (let i = 0; i < 5; i++) {
    q.release();
    await new Promise((r) => setTimeout(r, 5));
  }
  await Promise.all(consumers);
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
});

test('createPermitQueue: failAll() rejects every currently-waiting acquire() and all future ones', async () => {
  const q = createPermitQueue();
  const p1 = q.acquire();
  const p2 = q.acquire();
  const err = new Error('boom');
  q.failAll(err);
  await assert.rejects(p1, err);
  await assert.rejects(p2, err);
  await assert.rejects(q.acquire(), err);
});

test('createPermitQueue: a release() banked before failAll() does not un-fail the queue afterward', async () => {
  const q = createPermitQueue();
  q.release(); // bank one permit
  q.failAll(new Error('boom'));
  // The already-banked permit is irrelevant once failed -- every acquire()
  // from here on must reject, never silently "use up" the stale permit.
  await assert.rejects(q.acquire());
});
