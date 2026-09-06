import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, readBackup, validateWorkspace } from '../public/persistence.js';

const workspace = () => ({
  library: [],
  active: 'PLtest',
  drafts: {
    PLtest: {
      snapshotId: 'snapshot',
      info: { id: 'PLtest', title: 'Test', editable: true },
      original: [{ itemId: 'a', videoId: 'abcdefghijk', title: 'Original' }],
      items: [{ itemId: 'new:123', videoId: '12345678901', title: 'Added' }],
      options: {},
    },
  },
});

test('portable backup round-trips staged changes, never credentials or commit intents', () => {
  const input = {
    ...workspace(),
    credentials: 'SECRET',
    workspaceToken: 'SECRET',
    pending: { auth: 'SECRET' },
    undoHistory: ['SECRET'],
    receipts: ['SECRET'],
    preferences: { density: 'comfortable' },
  };
  input.drafts.PLtest.info.cookie = 'SECRET';
  const json = JSON.stringify(createBackup(input));
  assert.equal(json.includes('SECRET'), false);
  const restored = readBackup(JSON.parse(json));
  assert.equal(restored.drafts.PLtest.items[0].title, 'Added');
  assert.equal(restored.drafts.PLtest.original[0].title, 'Original');
  assert.equal(restored.preferences.density, 'comfortable');
  assert.equal(restored.pending, null);
});

test('backup validation rejects malformed tracks, duplicate IDs and unsupported versions', () => {
  const value = workspace();
  value.drafts.PLtest.items.push(value.drafts.PLtest.items[0]);
  assert.throws(() => validateWorkspace(value), /track/u);
  assert.throws(() => readBackup({ format: 'ytmsorter-workspace', version: 2 }), /supported/u);
  assert.throws(() => validateWorkspace({ library: [], drafts: [] }), /Invalid/u);
});

test('import cannot poison object prototypes or restore arbitrary active keys', () => {
  const value = workspace();
  value.active = '__proto__';
  assert.equal(validateWorkspace(value).active, 'PLtest');
  const malicious = JSON.parse(
    '{"library":[],"drafts":{"__proto__":{"info":{"id":"__proto__","title":"Oops"},"snapshotId":"id","items":[],"original":[]}}}',
  );
  assert.throws(() => validateWorkspace(malicious), /playlist/u);
  assert.equal({}.polluted, undefined);
});
