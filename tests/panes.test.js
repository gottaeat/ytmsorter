import test from 'node:test';
import assert from 'node:assert/strict';
import { planTrackDrop, diffDraft } from '../public/model.js';
import { normalizeLayout } from '../public/layout.js';
import { createBackup, readBackup } from '../public/persistence.js';

const track = (itemId) => ({ itemId, videoId: 'abcdefghijk', title: itemId });
const draft = (id, ids, editable = true) => ({
  info: { id, title: id, editable },
  snapshotId: 'snapshot',
  items: ids.map(track),
  original: ids.map(track),
});

test('drop reorders before an anchor, after a row or at the end, preserving selected order', () => {
  const source = draft('PLone', ['a', 'b', 'c', 'd', 'e']);
  for (const [selected, beforeId, expected] of [
    [['a'], 'd', ['b', 'c', 'a', 'd', 'e']],
    [['d'], 'b', ['a', 'd', 'b', 'c', 'e']],
    [['b', 'd'], null, ['a', 'c', 'e', 'b', 'd']],
    [['a', 'b'], 'c', ['a', 'b', 'c', 'd', 'e']],
  ]) {
    const result = planTrackDrop(source, source, new Set(selected), { beforeId });
    assert.deepEqual(
      result.destinationItems.map((x) => x.itemId),
      expected,
    );
  }
  assert.deepEqual(
    source.items.map((x) => x.itemId),
    ['a', 'b', 'c', 'd', 'e'],
    'planning never mutates source',
  );
});

test('dropping on a selected row is a no-op, not a duplicate or lost track', () => {
  const source = draft('PLone', ['a', 'b', 'c']);
  const result = planTrackDrop(source, source, new Set(['a', 'b']), { beforeId: 'b', copy: true });
  assert.equal(result.changed, false);
  assert.equal(result.mode, 'reorder');
  assert.deepEqual(result.sourceItems, source.items);
});

test('cross-pane move stages exact duplicate entries and inserts at destination position', () => {
  const source = draft('PLone', ['a', 'b', 'c']),
    destination = draft('PLtwo', ['x', 'y']);
  let serial = 0;
  const result = planTrackDrop(
    source,
    destination,
    new Set(['b', 'a']),
    { beforeId: 'y' },
    () => `new:${serial++}`,
  );
  assert.deepEqual(
    result.sourceItems.map((x) => x.itemId),
    ['c'],
  );
  assert.deepEqual(
    result.destinationItems.map((x) => x.title),
    ['x', 'a', 'b', 'y'],
  );
  assert.equal(new Set(result.destinationItems.map((x) => x.itemId)).size, 4);
  assert.equal(diffDraft({ ...source, items: result.sourceItems }).removed.length, 2);
  assert.equal(diffDraft({ ...destination, items: result.destinationItems }).added.length, 2);
  assert.equal(source.items.length, 3);
  assert.equal(destination.items.length, 2);
});

test('copy leaves source untouched; read-only sources cannot move and destinations cannot accept writes', () => {
  const source = draft('LM', ['a', 'b'], false),
    destination = draft('PLtwo', []);
  const result = planTrackDrop(
    source,
    destination,
    new Set(['a']),
    { copy: true },
    () => 'new:copy',
  );
  assert.deepEqual(result.sourceItems, source.items);
  assert.equal(result.mode, 'copy');
  assert.throws(
    () => planTrackDrop(source, destination, new Set(['a']), {}, () => 'new:x'),
    /Read-only/u,
  );
  assert.throws(
    () => planTrackDrop(destination, source, new Set(), {}, () => 'new:x'),
    /read-only/u,
  );
  source.stale = true;
  assert.throws(
    () => planTrackDrop(source, destination, new Set(['a']), { copy: true }, () => 'new:x'),
    /Reload/u,
  );
});

test('invalid selections, stale anchors and ID collisions fail before any mutation', () => {
  const source = draft('PLone', ['a', 'b']),
    destination = draft('PLtwo', ['x']);
  assert.throws(
    () => planTrackDrop(source, destination, new Set(['missing']), {}, () => 'new:x'),
    /selection/u,
  );
  assert.throws(
    () =>
      planTrackDrop(source, destination, new Set(['a']), { beforeId: 'missing' }, () => 'new:x'),
    /position/u,
  );
  assert.throws(() => planTrackDrop(source, destination, new Set(['a']), {}, () => 'x'), /unique/u);
  assert.equal(source.items.length, 2);
  assert.equal(destination.items.length, 1);
});

test('layout sanitizes foreign IDs and unsafe sizes; closed/minimized panes remain closed on restore', () => {
  const drafts = { PLone: draft('PLone', ['a']), PLtwo: draft('PLtwo', ['b']) };
  const layout = normalizeLayout(
    {
      open: ['PLone', 'PLone', 'unknown', 'PLtwo'],
      minimized: ['PLtwo', 'unknown'],
      libraryWidth: -999,
      changesWidth: 99999,
      consoleHeight: 'bad',
      weights: { PLone: Infinity },
      consoleHidden: true,
    },
    drafts,
    'PLone',
  );
  assert.deepEqual(layout.open, ['PLone', 'PLtwo']);
  assert.deepEqual(layout.minimized, ['PLtwo']);
  assert.equal(layout.libraryWidth, 160);
  assert.equal(layout.changesWidth, 600);
  assert.equal(layout.consoleHeight, 160);
  assert.equal(layout.weights.PLone, 1);
  assert.equal(layout.consoleHidden, true);
  assert.deepEqual(normalizeLayout({ open: [] }, drafts, 'PLone').open, []);
  assert.deepEqual(normalizeLayout({}, drafts, 'PLone').open, []);
  assert.equal(normalizeLayout({ open: [], weights: { PLone: 3 } }, drafts).weights.PLone, 3);
  const restored = readBackup(createBackup({ library: [], drafts, active: null, layout }));
  assert.equal(restored.active, null);
  assert.deepEqual(restored.layout, layout);
});
