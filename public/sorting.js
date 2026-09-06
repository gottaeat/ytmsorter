const TITLE_SEPARATORS = [' - ', ' – ', ' — ', ' | ', ': '];
const GENERIC_CHANNELS = new Set([
  'youtube',
  'youtube music',
  'various artists',
  'various artists - topic',
]);
const collator = new Intl.Collator('en', {
  sensitivity: 'base',
  numeric: true,
  ignorePunctuation: true,
});

function cleanChannel(channel) {
  let value = String(channel || '')
    .trim()
    .replace(/\s+-\s+Topic$/iu, '');
  if (!value.includes(' ') && value.toLocaleLowerCase('en').endsWith('vevo') && value.length > 4) {
    value = value.slice(0, -4);
  }
  return value.trim();
}

function artistFromTitle(title) {
  const value = String(title || '').trim();
  for (const separator of TITLE_SEPARATORS) {
    if (value.includes(separator)) {
      const candidate = value.split(separator, 1)[0].trim();
      if (candidate) return candidate;
    }
  }
  return value || 'Unknown artist';
}

export function inferArtist(item, { source = 'auto', overrides = {} } = {}) {
  const override = Object.hasOwn(overrides, item.videoId) ? overrides[item.videoId] : undefined;
  if (typeof override === 'string' && override.trim()) return override.trim();
  if (!['auto', 'channel', 'title'].includes(source)) {
    throw new Error(`Unsupported artist source: ${source}`);
  }

  const channel = cleanChannel(item.channel);
  if (source === 'title') return artistFromTitle(item.title);
  if (source === 'channel') return channel || 'Unknown artist';
  if (channel && !GENERIC_CHANNELS.has(String(item.channel).trim().toLocaleLowerCase('en'))) {
    return channel;
  }
  return artistFromTitle(item.title);
}

function sortableText(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .replace(/^[\s\W_]+/u, '')
    .replace(/^the\s+/iu, '');
}

export function sortItems(
  items,
  { artistSource = 'auto', overrides = {}, withinArtist = 'original', reverse = false } = {},
) {
  if (!['original', 'title'].includes(withinArtist)) {
    throw new Error(`Unsupported within-artist order: ${withinArtist}`);
  }
  const planned = items.map((item) => ({
    item,
    artist: inferArtist(item, { source: artistSource, overrides }),
  }));
  const direction = reverse ? -1 : 1;
  return planned.sort((left, right) => {
    const artistComparison = collator.compare(
      sortableText(left.artist),
      sortableText(right.artist),
    );
    if (artistComparison !== 0) return artistComparison * direction;
    if (withinArtist === 'title') {
      const titleComparison = collator.compare(
        sortableText(left.item.title),
        sortableText(right.item.title),
      );
      if (titleComparison !== 0) return titleComparison;
    }
    return left.item.position - right.item.position;
  });
}

export function computeMoves(current, target) {
  const targetSet = new Set(target);
  if (new Set(current).size !== current.length || targetSet.size !== target.length) {
    throw new Error('Playlist item IDs must be unique');
  }
  if (current.length !== target.length || current.some((id) => !targetSet.has(id))) {
    throw new Error('Current and target playlists do not contain the same items');
  }

  const targetRank = new Map(target.map((id, index) => [id, index]));
  const ranks = current.map((id) => targetRank.get(id));
  const tails = [];
  const tailIndices = [];
  const predecessors = Array(current.length).fill(-1);

  for (let index = 0; index < ranks.length; index += 1) {
    const rank = ranks[index];
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (tails[middle] < rank) low = middle + 1;
      else high = middle;
    }
    if (low === tails.length) {
      tails.push(rank);
      tailIndices.push(index);
    } else {
      tails[low] = rank;
      tailIndices[low] = index;
    }
    if (low > 0) predecessors[index] = tailIndices[low - 1];
  }

  const retained = new Set();
  if (tailIndices.length) {
    let index = tailIndices.at(-1);
    while (index >= 0) {
      retained.add(current[index]);
      index = predecessors[index];
    }
  }

  const nextAnchors = Array(target.length).fill(null);
  let anchor = null;
  for (let index = target.length - 1; index >= 0; index -= 1) {
    if (retained.has(target[index])) anchor = target[index];
    else nextAnchors[index] = anchor;
  }

  const working = [...current];
  const moves = [];
  target.forEach((desiredId, targetPosition) => {
    if (retained.has(desiredId)) return;
    const fromPosition = working.indexOf(desiredId);
    const [itemId] = working.splice(fromPosition, 1);
    const anchorId = nextAnchors[targetPosition];
    const toPosition = anchorId === null ? working.length : working.indexOf(anchorId);
    working.splice(toPosition, 0, itemId);
    if (fromPosition !== toPosition) moves.push({ itemId, fromPosition, toPosition });
  });

  if (working.some((id, index) => id !== target[index])) {
    throw new Error('Could not construct a valid reorder plan');
  }
  return moves;
}
