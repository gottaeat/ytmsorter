import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverDraft } from '../public/recovery.js';
import { createBackup, readBackup } from '../public/persistence.js';
const track = (id, videoId = id.repeat(11)) => ({ itemId: id, videoId, title: id });
const info = { id: 'PLtest', title: 'Test', channelId: 'owner', editable: true };
const make = () => ({
  info,
  original: [track('a'), track('b'), track('c')],
  items: [track('c'), track('new:x', 'xxxxxxxxxxx'), track('a')],
  stale: true,
  snapshotId: 'old',
});
const fresh = (items) => ({ info, items, snapshotId: 'fresh', loadedAt: '2026-09-10' });

test('legacy stale draft recovers without losing hours of order, additions or removals', () => {
  const draft = make();
  const recovered = recoverDraft(draft, fresh(draft.original));
  assert.deepEqual(recovered.items, draft.items);
  assert.equal(recovered.stale, false);
  assert.equal(recovered.snapshotId, 'fresh');
  assert.equal(draft.stale, true, 'input untouched');
  const restored = readBackup(createBackup({ library: [], drafts: { PLtest: recovered } }));
  assert.deepEqual(
    restored.drafts.PLtest.items.map((x) => x.itemId),
    ['c', 'new:x', 'a'],
  );
});
test('partial reorder and already-completed removal preserve the final intent', () => {
  const draft = make();
  const recovered = recoverDraft(draft, fresh([track('c'), track('a')]));
  assert.deepEqual(recovered.items, draft.items);
  assert.deepEqual(
    recovered.original.map((x) => x.itemId),
    ['c', 'a'],
  );
});
test('rotated item IDs can match unique videos but ambiguous duplicates never guessed', () => {
  const draft = make();
  const recovered = recoverDraft(
    draft,
    fresh(draft.original.map((x) => ({ ...x, itemId: 'fresh:' + x.itemId }))),
  );
  assert.deepEqual(
    recovered.items.map((x) => x.itemId),
    ['fresh:c', 'new:x', 'fresh:a'],
  );
  draft.original = [track('a'), track('b', 'aaaaaaaaaaa')];
  draft.items = [...draft.original].reverse();
  assert.throws(
    () => recoverDraft(draft, fresh([track('x', 'aaaaaaaaaaa'), track('y', 'aaaaaaaaaaa')])),
    /ambiguous/,
  );
  assert.deepEqual(recoverDraft(draft, fresh(draft.original)).items, draft.items);
});
test('wrong owner, missing desired entries and unknown additions preserve original draft', () => {
  const draft = make(),
    before = structuredClone(draft);
  assert.throws(
    () => recoverDraft(draft, { ...fresh(draft.original), info: { ...info, channelId: 'other' } }),
    /owner/,
  );
  assert.throws(() => recoverDraft(draft, fresh([track('a'), track('b')])), /missing/);
  assert.throws(() => recoverDraft(draft, fresh([...draft.original, track('z')])), /additional/);
  assert.deepEqual(draft, before);
});

test('a uniquely identifiable partial addition is kept once, never added twice', () => {
  const draft = make();
  const recovered = recoverDraft(
    draft,
    fresh([...draft.original, track('added-on-youtube', 'xxxxxxxxxxx')]),
  );
  assert.deepEqual(
    recovered.items.map((x) => x.itemId),
    ['c', 'added-on-youtube', 'a'],
  );
  draft.items.push(track('new:duplicate', 'xxxxxxxxxxx'));
  assert.throws(
    () => recoverDraft(draft, fresh([...draft.original, track('added-on-youtube', 'xxxxxxxxxxx')])),
    /additional/,
  );
});
