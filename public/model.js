// Pure draft operations shared by the browser and offline tests. No network calls.
export function withSystemPlaylists(playlists) {
  if (playlists.some((playlist) => playlist.id === 'LM')) return [...playlists];
  return [...playlists, { id: 'LM', title: 'Liked Music', count: '', kind: 'shortcut' }];
}

export function parseVideoId(value) {
  const text = String(value).trim();
  if (/^[\w-]{11}$/u.test(text)) return text;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Enter an 11-character video ID or a YouTube video URL.');
  }
  if (
    !['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be'].includes(
      url.hostname,
    )
  ) {
    throw new Error('Expected a YouTube video URL.');
  }
  const id =
    url.hostname === 'youtu.be'
      ? url.pathname.slice(1)
      : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/u)?.[1];
  if (!/^[\w-]{11}$/u.test(id || '')) throw new Error('The URL does not contain a video ID.');
  return id;
}

export function diffDraft(draft) {
  const original = new Set(draft.original.map((x) => x.itemId));
  const retained = new Set(draft.items.map((x) => x.itemId));
  const added = draft.items.filter((x) => !original.has(x.itemId));
  const removed = draft.original.filter((x) => !retained.has(x.itemId));
  const before = draft.original.filter((x) => retained.has(x.itemId)).map((x) => x.itemId);
  const after = draft.items.filter((x) => original.has(x.itemId)).map((x) => x.itemId);
  const reordered = before.some((id, i) => after[i] !== id);
  return { added, removed, reordered, dirty: !!(added.length || removed.length || reordered) };
}

export function moveSelection(items, selected, position) {
  const moving = items.filter((x) => selected.has(x.itemId));
  const rest = items.filter((x) => !selected.has(x.itemId));
  const index = Math.max(0, Math.min(rest.length, position));
  return [...rest.slice(0, index), ...moving, ...rest.slice(index)];
}

export function removeItems(items, selected) {
  // Remove playlist entries by their unique IDs, not all copies of a video.
  return items.filter((item) => !selected.has(item.itemId));
}

export function revertAddition(draft, itemId) {
  if (draft.original.some((item) => item.itemId === itemId)) {
    throw new Error('Only a staged addition can be reverted here.');
  }
  if (!draft.items.some((item) => item.itemId === itemId)) {
    throw new Error('This addition is no longer staged.');
  }
  return removeItems(draft.items, new Set([itemId]));
}

export function revertRemoval(draft, itemId) {
  const originalIndex = draft.original.findIndex((item) => item.itemId === itemId);
  if (originalIndex < 0 || draft.items.some((item) => item.itemId === itemId)) {
    throw new Error('This removal is no longer staged.');
  }
  const items = [...draft.items];
  const positions = new Map(items.map((item, index) => [item.itemId, index]));
  const successor = draft.original
    .slice(originalIndex + 1)
    .find((item) => positions.has(item.itemId));
  const predecessor = draft.original
    .slice(0, originalIndex)
    .reverse()
    .find((item) => positions.has(item.itemId));
  // Restore near an original neighbor without changing the order of other tracks.
  const position = successor
    ? positions.get(successor.itemId)
    : predecessor
      ? positions.get(predecessor.itemId) + 1
      : items.length;
  items.splice(position, 0, { ...draft.original[originalIndex] });
  return items;
}

export function revertOrder(draft) {
  const retained = new Map(draft.items.map((item) => [item.itemId, item]));
  const originalIds = new Set(draft.original.map((item) => item.itemId));
  const ordered = draft.original
    .filter((item) => retained.has(item.itemId))
    .map((item) => retained.get(item.itemId));
  let index = 0;
  // Keep additions in their current slots and keep removals staged.
  return draft.items.map((item) => (originalIds.has(item.itemId) ? ordered[index++] : item));
}

export function transferItems(source, destination, selected, remove, newId) {
  if (source === destination) throw new Error('Choose a different destination.');
  const moving = source.items.filter((x) => selected.has(x.itemId));
  if (!moving.length) throw new Error('Select tracks first.');
  destination.items.push(...moving.map((x) => ({ ...x, itemId: newId() })));
  if (remove) source.items = source.items.filter((x) => !selected.has(x.itemId));
  return moving.length;
}

export function planTrackDrop(
  source,
  destination,
  selected,
  { beforeId = null, copy = false } = {},
  newId,
) {
  if (!source || !destination || source.stale || destination.stale)
    throw new Error('Reload stale playlists before dragging tracks.');
  if (!destination.info.editable) throw new Error('The destination playlist is read-only.');
  if (!source.info.editable && (source === destination || !copy))
    throw new Error('Read-only sources can only be copied to another playlist.');
  const moving = source.items.filter((item) => selected.has(item.itemId));
  if (!moving.length || moving.length !== selected.size)
    throw new Error('The dragged selection changed. Select the tracks again.');
  if (beforeId !== null && !destination.items.some((item) => item.itemId === beforeId))
    throw new Error('The drop position changed. Try again.');
  if (source === destination) {
    const rest = source.items.filter((item) => !selected.has(item.itemId));
    const index =
      beforeId === null ? rest.length : rest.findIndex((item) => item.itemId === beforeId);
    const reordered = selected.has(beforeId)
      ? source.items
      : [...rest.slice(0, index), ...moving, ...rest.slice(index)];
    return {
      sourceItems: reordered,
      destinationItems: reordered,
      selectedIds: moving.map((item) => item.itemId),
      count: moving.length,
      mode: 'reorder',
      changed: reordered.some((item, i) => item.itemId !== source.items[i].itemId),
    };
  }
  const used = new Set(destination.items.map((item) => item.itemId));
  const added = moving.map((item) => {
    const itemId = newId();
    if (!itemId || used.has(itemId))
      throw new Error('Could not create unique destination entries.');
    used.add(itemId);
    return { ...item, itemId };
  });
  const index =
    beforeId === null
      ? destination.items.length
      : destination.items.findIndex((item) => item.itemId === beforeId);
  return {
    sourceItems: copy ? source.items : source.items.filter((item) => !selected.has(item.itemId)),
    destinationItems: [
      ...destination.items.slice(0, index),
      ...added,
      ...destination.items.slice(index),
    ],
    selectedIds: added.map((item) => item.itemId),
    count: moving.length,
    mode: copy ? 'copy' : 'move',
    changed: true,
  };
}
