import { authenticatedSession, AuthenticationRequiredError } from './auth.js';
import { withSystemPlaylists } from '../public/model.js';

export class YouTubeApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'YouTubeApiError';
  }
}

async function request(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof YouTubeApiError || error instanceof AuthenticationRequiredError)
      throw error;
    // Never log client errors: they may include request headers and cookies.
    throw new YouTubeApiError(
      'YouTube rejected the request or could not be reached. Stop and check your session; replace expired cookies if needed.',
    );
  }
}

export function createYouTubeOperations(session) {
  let firstPage = null;
  let firstPageId = null;
  return {
    async listPlaylists() {
      const result = new Map();
      let page = await request(() => session.getPlaylists());
      let pages = 0;
      do {
        for (const playlist of page.playlists) {
          const id = playlist.id || playlist.content_id;
          if (typeof id !== 'string' || !/^[\w-]{2,128}$/u.test(id)) continue;
          result.set(id, {
            id,
            title: String(playlist.title || playlist.metadata?.title || id),
            count: String(playlist.video_count_short || playlist.video_count || ''),
          });
        }
        if (!page.has_continuation) break;
        if (++pages >= 100)
          throw new YouTubeApiError(
            'Playlist library exceeded 100 pages. Open a playlist by URL instead.',
          );
        page = await request(() => page.getContinuation());
      } while (true);
      return withSystemPlaylists([...result.values()]);
    },

    async playlistSnapshot(playlistId) {
      const info = await this.playlistInfo(playlistId);
      const items = await this.playlistItems(playlistId, { allowReadOnly: !info.editable });
      return { info, items };
    },

    async playlistInfo(playlistId) {
      const playlist = await request(() => session.getPlaylist(playlistId));
      firstPage = playlist;
      firstPageId = playlistId;
      const { is_editable: isEditable, can_reorder: canReorder } = playlist.info;
      // The library's moveVideo guard requires is_editable. can_reorder is
      // optional in the response; absence is not a denial. Still honor false.
      let permissionError = null;
      if (isEditable === false) {
        permissionError =
          'YouTube reports this playlist is not editable by the connected channel. Check that the playlist belongs to the same channel as your cookies; automatic playlists may not be editable.';
      } else if (isEditable !== true) {
        permissionError =
          'YouTube did not provide edit permissions for this playlist, so no changes are allowed. Check the playlist URL and signed-in channel, then try fresh cookies.';
      } else if (canReorder === false) {
        permissionError =
          'YouTube reports this playlist is editable but reordering is disabled. Open it on YouTube, select manual ordering if available, and create a fresh preview.';
      }
      if (playlistId === 'LM') {
        permissionError =
          'Liked Music follows your likes. This app treats it as read-only: copy selected tracks into a loaded editable playlist to sort them. Changing likes is not implemented.';
      }
      return {
        id: playlistId,
        title: String(playlist.info.title || 'Untitled playlist'),
        channelId: playlist.info.author?.id || '',
        editable: permissionError === null,
        permissionError,
      };
    },

    async playlistItems(playlistId, { allowReadOnly = false } = {}) {
      const items = [];
      const seen = new Set();
      let page = firstPageId === playlistId ? firstPage : null;
      firstPage = null;
      firstPageId = null;
      page ||= await request(() => session.getPlaylist(playlistId));
      let pages = 0;
      do {
        for (const video of page.items) {
          const videoId = video.id || video.content_id;
          const itemId =
            video.set_video_id ||
            (allowReadOnly && videoId ? `readonly:${items.length}:${videoId}` : null);
          if (!itemId || !videoId || seen.has(itemId)) {
            throw new YouTubeApiError(
              'YouTube returned incomplete or duplicate playlist item IDs. No further changes will be made.',
            );
          }
          seen.add(itemId);
          items.push({
            itemId,
            videoId,
            title: String(video.title || video.metadata?.title || 'Unavailable video'),
            channel: String(
              video.author?.name ||
                video.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.text ||
                '',
            ),
            position: items.length,
          });
        }
        if (!page.has_continuation) break;
        if (++pages >= 100)
          throw new YouTubeApiError('Playlist exceeds the 10,000-track workspace limit.');
        page = await request(() => page.getContinuation());
      } while (true);
      return items;
    },

    async editItem(playlistId, action) {
      const result = await request(() =>
        session.actions.execute('/browse/edit_playlist', { playlistId, actions: [action] }),
      );
      if (!result.success || result.data?.status !== 'STATUS_SUCCEEDED') {
        throw new YouTubeApiError(
          'YouTube did not confirm this edit. Stop and reload affected playlists; do not replay the commit.',
        );
      }
    },
    async addItem(playlistId, videoId) {
      return this.editItem(playlistId, { action: 'ACTION_ADD_VIDEO', addedVideoId: videoId });
    },
    async removeItem(playlistId, itemId) {
      return this.editItem(playlistId, { action: 'ACTION_REMOVE_VIDEO', setVideoId: itemId });
    },
    async moveItem(playlistId, itemId, successor) {
      const action = { action: 'ACTION_MOVE_VIDEO_BEFORE', setVideoId: itemId };
      if (successor) action.movedSetVideoIdSuccessor = successor;
      return this.editItem(playlistId, action);
    },

    async applyMoves({ playlistId, items, moves, delayMs, progress = () => {} }) {
      const working = items.map((item) => item.itemId);
      for (let index = 0; index < moves.length; index += 1) {
        const move = moves[index];
        if (working[move.fromPosition] !== move.itemId)
          throw new YouTubeApiError('Move plan does not match the current order.');
        working.splice(move.fromPosition, 1);
        const successor = working[move.toPosition];
        const action = { action: 'ACTION_MOVE_VIDEO_BEFORE', setVideoId: move.itemId };
        if (successor) action.movedSetVideoIdSuccessor = successor;
        const result = await request(() =>
          session.actions.execute('/browse/edit_playlist', {
            playlistId,
            actions: [action],
          }),
        );
        if (!result.success || result.data?.status !== 'STATUS_SUCCEEDED') {
          throw new YouTubeApiError(
            'YouTube did not confirm the playlist edit. Create a fresh preview before continuing.',
          );
        }
        working.splice(move.toPosition, 0, move.itemId);
        progress(index + 1, moves.length, move);
        // No automatic retries for cookie-authenticated writes.
        if (index + 1 < moves.length) {
          await new Promise((resolve) => setTimeout(resolve, Math.max(1000, delayMs)));
        }
      }
    },
  };
}

export async function youtubeClient(auth) {
  return createYouTubeOperations(await authenticatedSession(auth));
}
