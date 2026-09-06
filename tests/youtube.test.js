import assert from 'node:assert/strict';
import test from 'node:test';
import { createYouTubeOperations } from '../src/youtube.js';
import { computeMoves } from '../src/sorting.js';
import { AuthenticationRequiredError } from '../src/auth.js';

test('library listing paginates, normalizes modern cards and deduplicates IDs', async () => {
  const client = createYouTubeOperations({
    async getPlaylists() {
      return {
        playlists: [{ id: 'PLone', title: 'One' }],
        has_continuation: true,
        async getContinuation() {
          return {
            playlists: [
              { content_id: 'PLtwo', metadata: { title: 'Two' } },
              { id: 'PLone', title: 'One' },
            ],
            has_continuation: false,
          };
        },
      };
    },
  });
  assert.deepEqual(
    (await client.listPlaylists()).map((x) => x.title),
    ['One', 'Two', 'Liked Music'],
  );
});

test('LM shortcut requires no additional lookup and never duplicates an API entry', async () => {
  let calls = 0;
  const client = createYouTubeOperations({
    async getPlaylists() {
      calls++;
      return { playlists: [{ id: 'LM', title: 'Your Likes' }], has_continuation: false };
    },
  });
  assert.deepEqual(
    (await client.listPlaylists()).map((x) => x.id),
    ['LM'],
  );
  assert.equal(calls, 1);
});

test('Liked Music is an explicit read-only copy source even if legacy flags allow edits', async () => {
  const client = createYouTubeOperations({
    async getPlaylist() {
      return {
        info: { title: 'Liked Music', is_editable: true, can_reorder: true },
        items: [{ content_id: 'abcdefghijk', metadata: { title: 'Song' } }],
        has_continuation: false,
      };
    },
  });
  const snapshot = await client.playlistSnapshot('LM');
  assert.equal(snapshot.info.editable, false);
  assert.match(snapshot.info.permissionError, /Changing likes is not implemented/u);
  assert.equal(snapshot.items[0].videoId, 'abcdefghijk');
});

test('snapshot loads reuse the initial page; additions and removals use exact endpoint actions', async () => {
  let reads = 0;
  const actions = [];
  const client = createYouTubeOperations({
    async getPlaylist() {
      reads++;
      return { info: { title: 'One', is_editable: true }, items: [], has_continuation: false };
    },
    actions: {
      async execute(endpoint, body) {
        actions.push({ endpoint, body });
        return { success: true, data: { status: 'STATUS_SUCCEEDED' } };
      },
    },
  });
  await client.playlistSnapshot('PLone');
  assert.equal(reads, 1);
  await client.addItem('PLone', 'abcdefghijk');
  await client.removeItem('PLone', 'unique-entry-id');
  assert.deepEqual(
    actions.map((x) => x.body.actions[0]),
    [
      { action: 'ACTION_ADD_VIDEO', addedVideoId: 'abcdefghijk' },
      { action: 'ACTION_REMOVE_VIDEO', setVideoId: 'unique-entry-id' },
    ],
  );
});

test('expired sessions are not mislabeled as playlist permission errors', async () => {
  const error = new AuthenticationRequiredError('Session expired');
  const client = createYouTubeOperations({
    async getPlaylist() {
      throw error;
    },
  });
  await assert.rejects(client.playlistInfo('PLtest'), (actual) => actual === error);
});

test('playlist permissions require edit access but allow an omitted reorder flag', async () => {
  for (const isEditable of [true, false, undefined]) {
    for (const canReorder of [true, false, undefined]) {
      const session = {
        async getPlaylist() {
          return {
            info: { title: 'Test', is_editable: isEditable, can_reorder: canReorder },
          };
        },
      };
      const info = await createYouTubeOperations(session).playlistInfo('PLtest');
      const allowed = isEditable === true && canReorder !== false;
      assert.equal(info.editable, allowed);
      assert.equal(info.permissionError === null, allowed);
      if (isEditable === false) assert.match(info.permissionError, /not editable/u);
      else if (isEditable === undefined) assert.match(info.permissionError, /did not provide/u);
      else if (canReorder === false) assert.match(info.permissionError, /reordering is disabled/u);
    }
  }
});

test('moves use unique item IDs and support first and last positions with duplicate videos', async () => {
  for (const target of [
    ['c', 'a', 'b'],
    ['b', 'c', 'a'],
  ]) {
    const order = ['a', 'b', 'c'];
    const items = order.map((itemId) => ({ itemId, videoId: 'sameVideoId' }));
    const session = {
      actions: {
        async execute(endpoint, payload) {
          assert.equal(endpoint, '/browse/edit_playlist');
          const [action] = payload.actions;
          assert.equal(action.action, 'ACTION_MOVE_VIDEO_BEFORE');
          const [id] = order.splice(order.indexOf(action.setVideoId), 1);
          const position = action.movedSetVideoIdSuccessor
            ? order.indexOf(action.movedSetVideoIdSuccessor)
            : order.length;
          order.splice(position, 0, id);
          return { success: true, data: { status: 'STATUS_SUCCEEDED' } };
        },
      },
    };
    await createYouTubeOperations(session).applyMoves({
      playlistId: 'PLtest',
      items,
      moves: computeMoves([...order], target),
      delayMs: 1000,
    });
    assert.deepEqual(order, target);
  }
});

test('rejected edits stop without retries or leaking errors', async () => {
  let calls = 0;
  const session = {
    actions: {
      async execute() {
        calls += 1;
        throw new Error('cookie=private');
      },
    },
  };
  await assert.rejects(
    createYouTubeOperations(session).applyMoves({
      playlistId: 'PLtest',
      items: [{ itemId: 'a' }, { itemId: 'b' }],
      moves: [{ itemId: 'a', fromPosition: 0, toPosition: 1 }],
      delayMs: 1000,
    }),
    (error) => !error.message.includes('private'),
  );
  assert.equal(calls, 1);
});

test('pagination preserves duplicate videos and rejects missing playlist item IDs', async () => {
  const session = {
    async getPlaylist() {
      return {
        items: [{ id: 'video', set_video_id: 'a', title: 'Song', author: { name: 'Artist' } }],
        has_continuation: true,
        async getContinuation() {
          return { items: [{ id: 'video', set_video_id: 'b' }], has_continuation: false };
        },
      };
    },
  };
  assert.deepEqual(
    (await createYouTubeOperations(session).playlistItems('PLtest')).map((item) => item.itemId),
    ['a', 'b'],
  );
  session.getPlaylist = async () => ({ items: [{ id: 'video' }] });
  await assert.rejects(createYouTubeOperations(session).playlistItems('PLtest'), /incomplete/u);
});
