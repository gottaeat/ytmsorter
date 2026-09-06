// Browser-owned persistence. No remote storage, telemetry or credential exports.
import { normalizeLayout } from './layout.js';
const DATABASE = 'ytmsorter';
let connection;
export function openDatabase() {
  connection ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onerror = () =>
      reject(new Error('Browser storage is unavailable. Check private-mode or storage settings.'));
    request.onblocked = () =>
      reject(new Error('Close other ytmsorter tabs to finish the storage upgrade.'));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
  return connection;
}
export async function readRecord(key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('records', 'readonly').objectStore('records').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not read browser storage.'));
  });
}
export async function writeRecord(key, value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records', 'readwrite');
    const store = transaction.objectStore('records');
    if (value === undefined) store.delete(key);
    else store.put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(new Error('Browser save failed. Free storage space, then Retry save.'));
  });
}

export function validateWorkspace(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    !input.drafts ||
    typeof input.drafts !== 'object' ||
    Array.isArray(input.drafts) ||
    !Array.isArray(input.library) ||
    input.library.length > 10000 ||
    Object.keys(input.drafts).length > 100
  )
    throw new Error('Invalid workspace file.');
  const drafts = Object.create(null);
  const cleanItems = (items) => {
    if (!Array.isArray(items) || items.length > 10000) throw new Error('Invalid workspace tracks.');
    const seen = new Set();
    return items.map((item) => {
      if (
        !item ||
        typeof item.itemId !== 'string' ||
        !item.itemId ||
        item.itemId.length > 512 ||
        seen.has(item.itemId) ||
        !/^[\w-]{11}$/u.test(item.videoId || '') ||
        typeof item.title !== 'string' ||
        item.title.length > 2000
      )
        throw new Error('Invalid workspace track.');
      seen.add(item.itemId);
      return {
        itemId: item.itemId,
        videoId: item.videoId,
        title: item.title,
        channel: String(item.channel || '').slice(0, 1000),
        position: Number.isInteger(item.position) ? item.position : 0,
      };
    });
  };
  for (const [id, draft] of Object.entries(input.drafts)) {
    if (
      !/^[\w-]{2,128}$/u.test(id) ||
      ['__proto__', 'constructor', 'prototype'].includes(id) ||
      draft?.info?.id !== id ||
      typeof draft.info.title !== 'string' ||
      draft.info.title.length > 1000 ||
      typeof draft.snapshotId !== 'string'
    )
      throw new Error('Invalid workspace playlist.');
    drafts[id] = {
      info: {
        id,
        title: draft.info.title,
        channelId: String(draft.info.channelId || ''),
        editable: draft.info.editable === true,
        permissionError:
          typeof draft.info.permissionError === 'string' ? draft.info.permissionError : null,
      },
      items: cleanItems(draft.items),
      original: cleanItems(draft.original),
      snapshotId: draft.snapshotId,
      loadedAt: typeof draft.loadedAt === 'string' ? draft.loadedAt : new Date().toISOString(),
      stale: draft.stale === true,
      options: {
        artistSource: ['auto', 'title', 'channel'].includes(draft.options?.artistSource)
          ? draft.options.artistSource
          : 'auto',
        withinArtist: draft.options?.withinArtist === 'title' ? 'title' : 'original',
        reverse: draft.options?.reverse === true,
        overrides: Object.fromEntries(
          Object.entries(draft.options?.overrides || {}).filter(
            ([key, value]) => /^[\w-]{11}$/u.test(key) && typeof value === 'string',
          ),
        ),
      },
    };
  }
  const library = input.library
    .filter((item) => /^[\w-]{2,128}$/u.test(item?.id || '') && typeof item.title === 'string')
    .map((item) => ({
      id: item.id,
      title: item.title.slice(0, 1000),
      count: String(item.count || '').slice(0, 100),
      kind: item.kind === 'shortcut' ? 'shortcut' : undefined,
    }));
  const active =
    input.active === null
      ? null
      : Object.hasOwn(drafts, input.active)
        ? input.active
        : Object.keys(drafts)[0] || null;
  return {
    library,
    drafts,
    active,
    layout: normalizeLayout(input.layout, drafts, active),
    pending: null,
    preferences: {
      density: input.preferences?.density === 'comfortable' ? 'comfortable' : 'compact',
    },
  };
}

export function createBackup(state) {
  // Whitelist export fields. Credentials, workspace tokens and pending jobs never leave the browser vault.
  return {
    format: 'ytmsorter-workspace',
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: validateWorkspace(state),
  };
}
export function readBackup(value) {
  if (value?.format !== 'ytmsorter-workspace' || value.version !== 1)
    throw new Error('Not a supported ytmsorter workspace backup.');
  return validateWorkspace(value.workspace);
}
