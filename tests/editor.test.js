import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareChanges, executeCommit } from '../src/editor.js';
import {
  diffDraft,
  parseVideoId,
  moveSelection,
  transferItems,
  removeItems,
  revertAddition,
  revertRemoval,
  revertOrder,
} from '../public/model.js';

test('revert removal restores only that entry without disrupting another staged removal or current order', () => {
  const original = ['a', 'b', 'c', 'd'].map((itemId) => ({ itemId }));
  const items = [{ itemId: 'new:1' }, original[2], original[0]];
  const restored = revertRemoval({ original, items }, 'b');
  assert.deepEqual(
    restored.filter((x) => x.itemId !== 'b'),
    items,
  );
  assert.deepEqual(
    diffDraft({ original, items: restored }).removed.map((x) => x.itemId),
    ['d'],
  );
  assert.equal(
    restored.findIndex((x) => x.itemId === 'b') + 1,
    restored.findIndex((x) => x.itemId === 'c'),
  );
  assert.throws(() => revertRemoval({ original, items }, 'a'));
  assert.deepEqual(revertRemoval({ original, items: [] }, 'd'), [original[3]]);
});

test('reverting order keeps additions in their slots and removals staged', () => {
  const original = ['a', 'b', 'c', 'd'].map((itemId) => ({ itemId }));
  const draft = { original, items: [original[3], { itemId: 'new:1' }, original[0], original[2]] };
  const restored = revertOrder(draft);
  assert.deepEqual(
    restored.map((x) => x.itemId),
    ['a', 'new:1', 'c', 'd'],
  );
  assert.equal(diffDraft({ ...draft, items: restored }).reordered, false);
  assert.deepEqual(
    diffDraft({ ...draft, items: restored }).removed.map((x) => x.itemId),
    ['b'],
  );
  assert.deepEqual(
    draft.items.map((x) => x.itemId),
    ['d', 'new:1', 'a', 'c'],
  );
});

test('reverting one batch addition preserves the other addition, existing order, and staged removals', () => {
  const original = [{ itemId: 'a' }, { itemId: 'b' }, { itemId: 'removed' }];
  const first = { itemId: 'new:first', videoId: 'same-video' };
  const second = { itemId: 'new:second', videoId: 'same-video' };
  const draft = { original, items: [original[1], first, original[0], second] };
  const before = structuredClone(draft);
  const reverted = { ...draft, items: revertAddition(draft, first.itemId) };
  assert.deepEqual(
    reverted.items.map((x) => x.itemId),
    ['b', 'a', 'new:second'],
  );
  assert.deepEqual(diffDraft(reverted).added, [second]);
  assert.deepEqual(
    diffDraft(reverted).removed.map((x) => x.itemId),
    ['removed'],
  );
  assert.equal(diffDraft(reverted).reordered, true);
  assert.deepEqual(draft, before, 'the helper does not mutate the undo snapshot');
  assert.throws(() => revertAddition(draft, 'a'), /Only a staged addition/u);
  assert.throws(() => revertAddition(draft, 'missing'), /no longer staged/u);
});

test('single and bulk removals are local and preserve unselected duplicate videos', () => {
  const original = [
    { itemId: 'first', videoId: 'same' },
    { itemId: 'second', videoId: 'same' },
    { itemId: 'third', videoId: 'other' },
  ];
  const single = removeItems(original, new Set(['first']));
  assert.deepEqual(
    single.map((x) => x.itemId),
    ['second', 'third'],
  );
  assert.equal(original.length, 3);
  assert.equal(diffDraft({ original, items: single }).removed.length, 1);
  assert.deepEqual(
    removeItems(original, new Set(['first', 'third'])).map((x) => x.itemId),
    ['second'],
  );
});

const item = (itemId, videoId = 'abcdefghijk') => ({
  itemId,
  videoId,
  title: itemId,
  channel: 'Artist',
});
const snapshot = (id, items) => ({
  info: { id, title: id, channelId: 'owner', editable: true },
  items,
});
const addition = (videoId) => ({ itemId: `new:${randomUUID()}`, videoId });
function fixture(snapshots) {
  const state = structuredClone(Object.fromEntries(snapshots.map((x) => [x.info.id, x])));
  const events = [];
  let serial = 0;
  const client = {
    async playlistSnapshot(id) {
      events.push(`check:${id}`);
      return structuredClone(state[id]);
    },
    async playlistItems(id) {
      events.push(`read:${id}`);
      return structuredClone(state[id].items);
    },
    async addItem(id, videoId) {
      events.push(`add:${id}`);
      state[id].items.push(item(`added-${serial++}`, videoId));
    },
    async removeItem(id, itemId) {
      events.push(`remove:${id}`);
      state[id].items = state[id].items.filter((x) => x.itemId !== itemId);
    },
    async moveItem(id, itemId, successor) {
      events.push(`move:${id}`);
      const list = state[id].items;
      const [moving] = list.splice(
        list.findIndex((x) => x.itemId === itemId),
        1,
      );
      list.splice(
        successor ? list.findIndex((x) => x.itemId === successor) : list.length,
        0,
        moving,
      );
    },
  };
  return { state, events, client };
}
const run = (client, changes, extra = {}) =>
  executeCommit(client, changes, { pause: async () => {}, ...extra });

test('local draft operations preserve duplicate entries, selection order, and video URLs', () => {
  const items = [item('a'), item('b'), item('c')];
  assert.deepEqual(
    moveSelection(items, new Set(['a', 'c']), 1).map((x) => x.itemId),
    ['b', 'a', 'c'],
  );
  const source = { original: structuredClone(items), items: [...items] };
  const destination = { original: [], items: [] };
  transferItems(source, destination, new Set(['a', 'b']), true, () => `new:${randomUUID()}`);
  assert.equal(destination.items.length, 2);
  assert.notEqual(destination.items[0].itemId, destination.items[1].itemId);
  assert.equal(diffDraft(source).removed.length, 2);
  assert.equal(diffDraft(destination).added.length, 2);
  assert.equal(parseVideoId('https://youtu.be/abcdefghijk?t=3'), 'abcdefghijk');
  assert.equal(parseVideoId('https://music.youtube.com/watch?v=abcdefghijk'), 'abcdefghijk');
  assert.throws(() => parseVideoId('https://evil.example/watch?v=abcdefghijk'));
});

test('commits validate duplicate targets, unknown IDs, read-only and consumed snapshots', () => {
  const s = snapshot('PLone', [item('a')]);
  assert.throws(() => prepareChanges([s], [{ items: [item('a'), item('a')] }]), /duplicate/u);
  assert.throws(() => prepareChanges([s], [{ items: [item('untrusted')] }]), /Unknown/u);
  assert.throws(() => prepareChanges([{ ...s, claimedBy: 'job' }], [{ items: [] }]), /already/u);
  assert.throws(
    () => prepareChanges([{ ...s, info: { ...s.info, editable: false } }], [{ items: [] }]),
    /read-only/u,
  );
});

test('transfer verifies destination additions before any source removal, including duplicate videos', async () => {
  const snapshots = [
    snapshot('source', [item('a'), item('b'), item('c')]),
    snapshot('dest', [item('d')]),
  ];
  const changes = prepareChanges(snapshots, [
    { items: [item('c')] },
    { items: [addition('abcdefghijk'), item('d'), addition('abcdefghijk')] },
  ]);
  const { state, events, client } = fixture(snapshots);
  const writes = await run(client, changes);
  assert.equal(state.source.items.length, 1);
  assert.equal(state.dest.items.length, 3);
  assert.equal(state.dest.items[1].itemId, 'd');
  assert.ok(events.indexOf('read:dest') < events.indexOf('remove:source'));
  assert.ok(events.indexOf('check:dest') < events.indexOf('add:dest'));
  assert.equal(writes, 5);
});

test('failed or unverified additions never remove transfer sources', async () => {
  for (const throws of [true, false]) {
    const snapshots = [snapshot('source', [item('a')]), snapshot('dest', [])];
    const changes = prepareChanges(snapshots, [
      { items: [] },
      { items: [addition('abcdefghijk')] },
    ]);
    const { state, client } = fixture(snapshots);
    client.addItem = async () => {
      if (throws) throw new Error('Rejected');
    };
    await assert.rejects(run(client, changes));
    assert.equal(state.source.items.length, 1);
  }
});

test('external edits abort preflight before any writes', async () => {
  const snapshots = [snapshot('one', [item('a'), item('b')]), snapshot('two', [item('c')])];
  const changes = prepareChanges(snapshots, [{ items: [item('b'), item('a')] }, { items: [] }]);
  const { state, events, client } = fixture(snapshots);
  state.two.items.push(item('external'));
  await assert.rejects(run(client, changes), /changed since loading/u);
  assert.ok(events.every((x) => x.startsWith('check:')));
});

test('manual reorder, empty target and no-op commits verify exactly', async () => {
  for (const target of [['c', 'a', 'b'], [], ['a', 'b', 'c']]) {
    const snapshots = [
      snapshot(
        'one',
        ['a', 'b', 'c'].map((x) => item(x)),
      ),
    ];
    const changes = prepareChanges(snapshots, [{ items: target.map((x) => item(x)) }]);
    const { state, client } = fixture(snapshots);
    await run(client, changes);
    assert.deepEqual(
      state.one.items.map((x) => x.itemId),
      target,
    );
  }
});

test('write rate limit and submitted/confirmed reports apply to every mutation', async () => {
  const snapshots = [snapshot('one', [item('a'), item('b')])];
  const changes = prepareChanges(snapshots, [{ items: [addition('abcdefghijk'), item('b')] }]);
  const { client } = fixture(snapshots);
  const delays = [];
  const reports = [];
  const writes = await run(client, changes, {
    delayMs: 1,
    pause: async (ms) => delays.push(ms),
    report: async (phase, message, n) => reports.push({ phase, n }),
  });
  assert.equal(delays.length, writes - 1);
  assert.ok(delays.every((ms) => ms >= 1000));
  assert.equal(reports.filter((x) => x.phase === 'write').length, writes);
  assert.equal(reports.filter((x) => x.phase === 'confirmed').length, writes);
});

test('journal failure before submission causes no write', async () => {
  const snapshots = [snapshot('one', [item('a')])];
  const { client, events } = fixture(snapshots);
  await assert.rejects(
    run(client, prepareChanges(snapshots, [{ items: [] }]), {
      report: async (phase) => {
        if (phase === 'write') throw new Error('Reporter unavailable');
      },
    }),
  );
  assert.ok(!events.some((x) => x.startsWith('remove:')));
});

test('graceful shutdown stops before the next write without rollback or retries', async () => {
  const snapshots = [snapshot('one', [item('a'), item('b')])];
  const { client, events } = fixture(snapshots);
  let stop = false;
  await assert.rejects(
    run(client, prepareChanges(snapshots, [{ items: [] }]), {
      shouldStop: () => stop,
      report: async (phase) => {
        if (phase === 'confirmed') stop = true;
      },
    }),
    /shutting down/u,
  );
  assert.equal(events.filter((x) => x.startsWith('remove:')).length, 1);
});
