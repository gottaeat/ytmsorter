import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeDraftChanges,
  planTrackDrop,
  revertOrder,
  revertAddition,
} from '../public/model.js';

const track = (itemId) => ({ itemId, videoId: 'abcdefghijk', title: itemId });
const draft = (ids) => ({
  info: { editable: true },
  original: ids.map(track),
  items: ids.map(track),
});

test('copy into a destination, then reorder originals: buffer describes both changes', () => {
  const source = draft(['source']),
    target = draft(['a', 'b', 'c', 'd']);
  target.items = planTrackDrop(
    source,
    target,
    new Set(['source']),
    { copy: true },
    () => 'new:copy',
  ).destinationItems;
  target.items = planTrackDrop(target, target, new Set(['d']), { beforeId: 'a' }).destinationItems;
  target.items = planTrackDrop(target, target, new Set(['c']), { beforeId: 'a' }).destinationItems;
  const changes = describeDraftChanges(target);
  assert.deepEqual(
    changes.additions.map(({ item, to }) => [item.itemId, to]),
    [['new:copy', 5]],
  );
  assert.deepEqual(
    changes.orderChanges.map(({ item, from, to }) => [item.itemId, from, to]),
    [
      ['d', 4, 1],
      ['c', 3, 2],
      ['a', 1, 3],
      ['b', 2, 4],
    ],
  );
  assert.equal(changes.reordered, true);
  assert.equal(
    describeDraftChanges({ ...target, items: revertOrder(target) }).orderChanges.length,
    0,
  );
  assert.equal(
    describeDraftChanges({ ...target, items: revertAddition(target, 'new:copy') }).orderChanges
      .length,
    4,
  );
});

test('moving only an added song updates its displayed destination without inventing original positions', () => {
  const target = draft(['a', 'b']);
  target.items.push(track('new:copy'));
  assert.equal(describeDraftChanges(target).additions[0].to, 3);
  target.items = planTrackDrop(target, target, new Set(['new:copy']), {
    beforeId: 'a',
  }).destinationItems;
  const changes = describeDraftChanges(target);
  assert.equal(changes.additions[0].to, 1);
  assert.deepEqual(changes.orderChanges, []);
});

test('membership-only index shifts are not labeled reorders; duplicate videos use entry IDs', () => {
  const target = draft(['a', 'b', 'c']);
  target.items = [track('new:copy'), target.items[1], target.items[2]];
  const changes = describeDraftChanges(target);
  assert.deepEqual(changes.orderChanges, []);
  assert.equal(changes.removals[0].from, 1);
  target.items = [target.items[0], target.items[2], target.items[1]];
  assert.deepEqual(
    describeDraftChanges(target).orderChanges.map((x) => x.item.itemId),
    ['c', 'b'],
  );
});

test('relative reorders remain visible even when insertions keep an absolute position unchanged', () => {
  const target = draft(['a', 'b', 'c']);
  target.items = [track('new:copy'), target.items[1], target.items[0], target.items[2]];
  const b = describeDraftChanges(target).orderChanges.find((x) => x.item.itemId === 'b');
  assert.deepEqual([b.from, b.to, b.fromRank, b.toRank], [2, 2, 2, 1]);
});
