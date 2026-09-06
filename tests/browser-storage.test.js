import test from 'node:test';
import assert from 'node:assert/strict';

// A tiny transaction harness: prove that a successful put request alone is not
// treated as a durable save. Browser-level reload/locking checks use the demo.
async function harness(t, name) {
  const previous = globalThis.indexedDB;
  let transaction;
  const database = {
    close() {},
    transaction() {
      transaction = { objectStore: () => ({ put() {}, delete() {} }) };
      return transaction;
    },
  };
  globalThis.indexedDB = {
    open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  };
  t.after(() => {
    globalThis.indexedDB = previous;
  });
  const module = await import(`../public/persistence.js?${name}`);
  await module.openDatabase();
  return { module, transaction: () => transaction };
}

test('browser save resolves only after the IndexedDB transaction completes', async (t) => {
  const h = await harness(t, 'complete');
  let saved = false;
  const pending = h.module.writeRecord('workspace', { drafts: {} }).then(() => {
    saved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved, false);
  h.transaction().oncomplete();
  await pending;
  assert.equal(saved, true);
});

test('aborted browser transactions reject, so unsaved intent cannot pass the save gate', async (t) => {
  const h = await harness(t, 'abort');
  const pending = h.module.writeRecord('workspace', { drafts: {} });
  const rejected = assert.rejects(pending, /Browser save failed/u);
  await new Promise((resolve) => setImmediate(resolve));
  h.transaction().onabort();
  await rejected;
});
