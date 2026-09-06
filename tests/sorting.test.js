import assert from 'node:assert/strict';
import test from 'node:test';

import { computeMoves, inferArtist, sortItems } from '../src/sorting.js';

function item(
  itemId,
  { videoId = itemId, title = 'Song', channel = 'Artist - Topic', position = 0 } = {},
) {
  return { itemId, videoId, title, channel, position };
}

test('artist inference cleans Topic and VEVO channel names', () => {
  assert.equal(inferArtist(item('1', { channel: 'Massive Attack - Topic' })), 'Massive Attack');
  assert.equal(inferArtist(item('2', { channel: 'AdeleVEVO' })), 'Adele');
});

test('generic channels fall back to Artist - Title parsing', () => {
  const value = item('1', { title: 'Nina Simone - Sinnerman', channel: 'Various Artists - Topic' });
  assert.equal(inferArtist(value), 'Nina Simone');
});

test('video ID override takes precedence', () => {
  assert.equal(
    inferArtist(item('1', { videoId: 'abc' }), { overrides: { abc: 'Custom' } }),
    'Custom',
  );
});

test('default sorting groups artists while preserving their track order', () => {
  const values = [
    item('a10', { title: 'Track 10', channel: 'Alpha - Topic', position: 0 }),
    item('b', { channel: 'Beta - Topic', position: 1 }),
    item('a2', { title: 'Track 2', channel: 'Alpha - Topic', position: 2 }),
  ];
  assert.deepEqual(
    sortItems(values).map((entry) => entry.item.itemId),
    ['a10', 'a2', 'b'],
  );
});

test('optional title sorting is numeric and accent insensitive', () => {
  const values = [
    item('10', { title: 'Track 10', channel: 'Álpha - Topic', position: 0 }),
    item('2', { title: 'Track 2', channel: 'Alpha - Topic', position: 1 }),
  ];
  assert.deepEqual(
    sortItems(values, { withinArtist: 'title' }).map((entry) => entry.item.itemId),
    ['2', '10'],
  );
});

function applyMoves(current, moves) {
  const working = [...current];
  for (const move of moves) {
    assert.equal(working[move.fromPosition], move.itemId);
    const [value] = working.splice(move.fromPosition, 1);
    working.splice(move.toPosition, 0, value);
  }
  return working;
}

test('move plan reaches mixed and reversed target orders', () => {
  for (const target of [
    ['b', 'd', 'a', 'c'],
    ['d', 'c', 'b', 'a'],
  ]) {
    const current = ['a', 'b', 'c', 'd'];
    assert.deepEqual(applyMoves(current, computeMoves(current, target)), target);
  }
});

test('move plan uses a minimum-length longest-subsequence strategy', () => {
  assert.deepEqual(computeMoves(['c', 'a', 'b'], ['a', 'b', 'c']), [
    { itemId: 'c', fromPosition: 0, toPosition: 2 },
  ]);
});

test('different item sets and duplicate IDs are rejected', () => {
  assert.throws(() => computeMoves(['a', 'b'], ['a', 'c']), /same items/u);
  assert.throws(() => computeMoves(['a', 'a'], ['a', 'a']), /unique/u);
});
