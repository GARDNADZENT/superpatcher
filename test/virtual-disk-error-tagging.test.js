// Confirms VirtualDisk tags a read failure with which underlying File it
// came from (fileIndex/fileName) -- used by main.js to tell the user
// exactly which file to re-select when recovering from a stale/unreadable
// File reference (see file-read-retry.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { VirtualDisk } from '../src/virtual-disk.js';

/** A fake Blob whose .slice(...).arrayBuffer() always throws the given
 * error, with a readable .name for identification in tests. */
function makeFailingFile(name, size, err) {
  return {
    name,
    size,
    slice() {
      return {
        async arrayBuffer() {
          throw err;
        },
      };
    },
  };
}

function rawIndex(size) {
  return { outputSize: size, chunks: [{ type: 'raw', outOffset: 0, outLength: size, fileOffset: 0 }] };
}

test('VirtualDisk: a failed read is tagged with the failing file\'s name and index', async () => {
  const err = Object.assign(
    new Error('The requested file could not be read, typically due to permission problems...'),
    { name: 'NotReadableError' }
  );
  const file = makeFailingFile('my-super.img', 1000, err);
  const disk = new VirtualDisk([{ file, index: rawIndex(1000) }], { retryOptions: { retries: 1, baseDelayMs: 1 } });

  await assert.rejects(
    () => disk.read(0, 100),
    (thrown) => {
      assert.equal(thrown.fileName, 'my-super.img');
      assert.equal(thrown.fileIndex, 0);
      return true;
    }
  );
});

test('VirtualDisk: tags the correct file/index for a multi-part (split) image', async () => {
  const err = Object.assign(new Error('could not be read'), { name: 'NotReadableError' });
  const goodFile = { name: 'super.img', size: 500, slice: (s, e) => ({ arrayBuffer: async () => new Uint8Array(e - s).buffer }) };
  const badFile = makeFailingFile('super_1.img', 500, err);
  const disk = new VirtualDisk(
    [
      { file: goodFile, index: rawIndex(500) },
      { file: badFile, index: rawIndex(500) },
    ],
    { retryOptions: { retries: 1, baseDelayMs: 1 } }
  );

  // Reading from the first part works fine.
  await disk.read(0, 100);

  // Reading from the second part fails and is tagged with ITS file/index.
  await assert.rejects(
    () => disk.read(500, 100),
    (thrown) => {
      assert.equal(thrown.fileName, 'super_1.img');
      assert.equal(thrown.fileIndex, 1);
      return true;
    }
  );
});

test('VirtualDisk: onReadRetry callback fires on each retry before final failure', async () => {
  let calls = 0;
  const err = Object.assign(new Error('could not be read'), { name: 'NotReadableError' });
  const file = {
    name: 'flaky.img',
    size: 100,
    slice() {
      return {
        async arrayBuffer() {
          calls++;
          throw err;
        },
      };
    },
  };
  const retryLog = [];
  const disk = new VirtualDisk([{ file, index: rawIndex(100) }], { onReadRetry: (attempt) => retryLog.push(attempt), retryOptions: { retries: 3, baseDelayMs: 1 } });
  await assert.rejects(() => disk.read(0, 10));
  assert.ok(retryLog.length > 0, 'onReadRetry should have fired at least once');
  assert.ok(calls > retryLog.length, 'should have made more read attempts than retries logged (initial + retries)');
});
