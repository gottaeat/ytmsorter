// Disposable UI verification server: only in-memory playlists; no YouTube calls.
import { createApp } from '../src/server.js';
const titles = [
  ['Massive Attack', 'Teardrop'],
  ['Portishead', 'Roads'],
  ['Air', 'La femme d’argent'],
  ['Massive Attack', 'Angel'],
  ['Björk', 'Jóga'],
  ['Portishead', 'Glory Box'],
  ['Air', 'All I Need'],
  ['Boards of Canada', 'Dayvan Cowboy'],
  ['Björk', 'Hyperballad'],
  ['Aphex Twin', 'Avril 14th'],
  ['Boards of Canada', 'Roygbiv'],
  ['Aphex Twin', 'Xtal'],
];
const tracks = titles.map(([channel, title], i) => ({
  itemId: `fixture-${i}`,
  videoId: `test${String(i).padStart(7, '0')}`,
  title,
  channel,
  position: i,
}));
const playlists = {
  PLworkshop: {
    info: {
      id: 'PLworkshop',
      title: 'TEST / Workshop rotation',
      channelId: 'fixture',
      editable: true,
    },
    items: tracks,
  },
  PLarchive: {
    info: {
      id: 'PLarchive',
      title: 'TEST / Night shift archive',
      channelId: 'fixture',
      editable: true,
    },
    items: tracks.slice(0, 3).map((x) => ({ ...x, itemId: `archive-${x.itemId}` })),
  },
};
let serial = 0;
const client = {
  async listPlaylists() {
    return Object.values(playlists).map((x) => ({ ...x.info, count: `${x.items.length} tracks` }));
  },
  async playlistSnapshot(id) {
    if (!playlists[id]) throw new Error('Fixture playlist not found');
    return structuredClone(playlists[id]);
  },
  async playlistItems(id) {
    return structuredClone(playlists[id].items);
  },
  async addItem(id, videoId) {
    playlists[id].items.push({
      itemId: `new-fixture-${serial++}`,
      videoId,
      title: videoId,
      channel: '',
    });
  },
  async removeItem(id, itemId) {
    playlists[id].items = playlists[id].items.filter((x) => x.itemId !== itemId);
  },
  async moveItem(id, itemId, successor) {
    const list = playlists[id].items;
    const [track] = list.splice(
      list.findIndex((x) => x.itemId === itemId),
      1,
    );
    list.splice(successor ? list.findIndex((x) => x.itemId === successor) : list.length, 0, track);
  },
};
createApp({ editorClientFactory: async () => client, demo: true }).listen(
  Number(process.env.PORT || 3001),
  '0.0.0.0',
  () => console.log('Disposable fixture UI ready; no YouTube calls.'),
);
