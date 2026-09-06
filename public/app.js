import { inferArtist, sortItems, computeMoves } from './sorting.js';
import { normalizeLayout } from './layout.js';
import { createPaneWorkspace, bindSash } from './panes.js';
import {
  readRecord,
  writeRecord,
  validateWorkspace,
  createBackup,
  readBackup,
} from './persistence.js';
import {
  diffDraft,
  describeDraftChanges,
  parseVideoId,
  moveSelection,
  transferItems,
  removeItems,
  withSystemPlaylists,
  revertAddition,
  revertRemoval,
  revertOrder,
  planTrackDrop,
} from './model.js';

const $ = (id) => document.getElementById(id);
const storageKey = 'ytm-workspace-v1';
const logKey = 'ytm-activity-v1';
const clone = (value) => structuredClone(value);
let state = { library: [], drafts: {}, active: null, pending: null };
let startupError = '';
let hasWorkspaceLock = false;
if (navigator.locks) {
  await new Promise((resolve) => {
    navigator.locks
      .request('ytmsorter-editor', { ifAvailable: true }, async (lock) => {
        hasWorkspaceLock = !!lock;
        resolve();
        if (lock)
          await new Promise((release) =>
            window.addEventListener('pagehide', release, { once: true }),
          );
      })
      .catch(() => resolve());
  });
}
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
try {
  const stored = await readRecord('workspace');
  const saved = stored || JSON.parse(localStorage.getItem(storageKey));
  if (saved) {
    const validated = validateWorkspace(saved);
    state = { ...saved, ...validated, pending: saved.pending || null };
  }
} catch (error) {
  startupError = error.message;
}
state.library = withSystemPlaylists(state.library);
let selected = new Set();
let history = Array.isArray(state.undoHistory) ? state.undoHistory.slice(-30) : [];
let redoHistory = Array.isArray(state.redoHistory) ? state.redoHistory.slice(-30) : [];
delete state.undoHistory;
delete state.redoHistory;
let busy = false;
let authenticated = false;
let credentials = null;
let workerInstance = null;
let workspaceToken = state.workspaceToken || crypto.randomUUID();
state.workspaceToken = workspaceToken;
let saveFailed = !!startupError;
let saveQueue = Promise.resolve();
try {
  const remembered = await readRecord('credentials');
  credentials = remembered || JSON.parse(sessionStorage.getItem('ytm-session-credentials'));
  $('remember-cookies').checked = !!remembered || !credentials;
} catch {
  /* reconnect if absent */
}
let maxUpdates = 180;
let writeDelayMs = 1000;
let requests = 0;
let polling = false;
let displayedEvents = 0;
let savedEvents = [];
try {
  const entries = (await readRecord('activity')) || JSON.parse(localStorage.getItem(logKey));
  if (Array.isArray(entries))
    savedEvents = entries
      .filter((x) => typeof x?.message === 'string' && typeof x.kind === 'string')
      .slice(-200);
} catch {
  /* optional history */
}
const current = () =>
  Object.hasOwn(state.drafts, state.active) ? state.drafts[state.active] : undefined;
const dirty = () => Object.values(state.drafts).filter((d) => diffDraft(d).dirty);
const newId = () => `new:${crypto.randomUUID()}`;
state.layout = normalizeLayout(state.layout, state.drafts, state.active);
// Restore data and dimensions, but let the user choose which editors to open.
state.layout.open = [];
state.layout.minimized = [];
state.active = null;
const paneUI = createPaneWorkspace({
  getState: () => state,
  isLocked: () => busy || !!state.pending || !hasWorkspaceLock,
  artist,
  videoLink,
  focus: focusPlaylist,
  onDrop: dropTracks,
  changed: () => {
    save();
    renderChrome();
  },
  controls: renderControls,
});
selected = paneUI.selection(state.active);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
function videoLink(item, label = item.title) {
  const link = node('a', label, 'track-link');
  link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = 'Open video on YouTube in a new tab';
  return link;
}

function appendLog(message, kind, at) {
  const li = node('li', undefined, kind);
  li.append(
    node('time', new Date(at).toLocaleTimeString()),
    node('span', kind.toUpperCase(), 'log-phase'),
    node('span', message),
  );
  $('activity-log').append(li);
  while ($('activity-log').children.length > 200) $('activity-log').firstChild.remove();
  $('activity-log').scrollTop = $('activity-log').scrollHeight;
  $('status').textContent = message;
  $('status').className = kind === 'error' ? 'error' : '';
}
function log(message, kind = 'local', at = new Date().toISOString()) {
  appendLog(message, kind, at);
  savedEvents.push({ message, kind, at });
  savedEvents = savedEvents.slice(-200);
  if (hasWorkspaceLock) void writeRecord('activity', clone(savedEvents)).catch(() => {});
}
function save() {
  if (!hasWorkspaceLock || startupError) return Promise.resolve(false);
  const data = clone({ ...state, undoHistory: history, redoHistory });
  $('save-state').textContent = 'SAVING…';
  saveQueue = saveQueue.then(async () => {
    try {
      await writeRecord('workspace', data);
      saveFailed = false;
      $('save-state').textContent = 'SAVED IN BROWSER';
      $('retry-save').hidden = true;
      return true;
    } catch (error) {
      saveFailed = true;
      $('save-state').textContent = 'NOT SAVED';
      $('retry-save').hidden = false;
      log(error.message, 'error');
      return false;
    }
  });
  return saveQueue;
}
async function api(path, body, { quiet = false } = {}) {
  const started = performance.now();
  requests += 1;
  $('request-count').textContent = `${requests} local requests`;
  const headers = {
    'X-Workspace-Token': workspaceToken,
    'X-Worker-Instance': state.pending?.instanceId || workerInstance || '',
  };
  const response = await fetch(
    path,
    body === undefined
      ? { headers, signal: AbortSignal.timeout(20000) }
      : {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...body,
            ...(path === '/api/connect' ? {} : { auth: credentials }),
          }),
          signal: AbortSignal.timeout(path === '/api/commits' ? 20000 : 300000),
        },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      authenticated = false;
      setConnection('SESSION REJECTED', 'rejected');
      openSession();
    }
    const error = new Error(data.error || `Local request failed (${response.status}).`);
    error.status = response.status;
    error.code = data.code;
    if (data.instanceId) workerInstance = data.instanceId;
    throw error;
  }
  if (!quiet) log(`Local service ${path} · ${(performance.now() - started).toFixed(0)} ms`, 'read');
  return data;
}
async function operation(label, action) {
  if (busy || state.pending || !hasWorkspaceLock) return;
  busy = true;
  if ($('connect-panel').open) $('session-error').hidden = true;
  $('operation-state').textContent = label.toUpperCase();
  log(label, 'read');
  renderControls();
  const started = Date.now();
  const timer = setInterval(() => {
    $('operation-state').textContent = `WORKING · ${Math.floor((Date.now() - started) / 1000)}s`;
  }, 1000);
  try {
    await action();
  } catch (error) {
    log(error.message, 'error');
    if ($('connect-panel').open) {
      $('session-error').textContent = error.message;
      $('session-error').hidden = false;
    }
  } finally {
    clearInterval(timer);
    busy = false;
    $('operation-state').textContent = 'IDLE';
    render();
  }
}
function remember() {
  redoHistory = [];
  history.push(
    Object.fromEntries(
      Object.entries(state.drafts).map(([id, d]) => [
        id,
        { items: clone(d.items), options: clone(d.options) },
      ]),
    ),
  );
  if (history.length > 30) history.shift();
}
function edit(label, action, { readOnlySource = false, draftId = state.active } = {}) {
  const d = state.drafts[draftId];
  if (
    !d ||
    busy ||
    state.pending ||
    !hasWorkspaceLock ||
    d.stale ||
    (!readOnlySource && !d.info.editable)
  )
    return;
  try {
    remember();
    action(d);
    save();
    render();
    log(`${label} · LOCAL ONLY / no YouTube calls`);
  } catch (error) {
    history.pop();
    log(error.message, 'error');
  }
}
function options() {
  const overrides = $('overrides').value.trim() ? JSON.parse($('overrides').value) : {};
  if (
    !overrides ||
    Array.isArray(overrides) ||
    typeof overrides !== 'object' ||
    Object.entries(overrides).some(
      ([id, value]) => !/^[\w-]{11}$/u.test(id) || typeof value !== 'string',
    )
  )
    throw new Error('Overrides must map video IDs to artist names.');
  return {
    artistSource: $('artist-source').value,
    withinArtist: $('within-artist').value,
    reverse: $('reverse').checked,
    overrides,
  };
}
function artist(item, draft = current()) {
  return inferArtist(item, {
    source: draft?.options?.artistSource || 'auto',
    overrides: draft?.options?.overrides || {},
  });
}
function visibleItems() {
  return paneUI.visibleItems(state.active);
}
function focusPlaylist(id) {
  if (id !== null && !Object.hasOwn(state.drafts, id)) return;
  const switched = state.active !== id;
  state.active = id;
  selected = paneUI.selection(id);
  $('track-filter').value = paneUI.filter(id);
  const opts = current()?.options || {};
  $('artist-source').value = opts.artistSource || 'auto';
  $('within-artist').value = opts.withinArtist || 'original';
  $('reverse').checked = !!opts.reverse;
  $('overrides').value = Object.keys(opts.overrides || {}).length
    ? JSON.stringify(opts.overrides, null, 2)
    : '';
  updateActiveHeading();
  paneUI.focus(id);
  renderControls();
  if (switched) save();
}
function activate(id) {
  state.layout = normalizeLayout(state.layout, state.drafts, state.active);
  if (id && Object.hasOwn(state.drafts, id)) {
    if (!state.layout.open.includes(id)) state.layout.open.push(id);
    state.layout.minimized = state.layout.minimized.filter((x) => x !== id);
  }
  focusPlaylist(id);
  render();
  save();
}
function dropTracks(sourceId, destinationId, ids, options) {
  if (busy || state.pending || !hasWorkspaceLock) return;
  try {
    const source = state.drafts[sourceId],
      destination = state.drafts[destinationId];
    const plan = planTrackDrop(source, destination, ids, options, newId);
    if (!plan.changed) {
      log('Drop kept the same order · no change staged.');
      return;
    }
    edit(
      `${plan.count} tracks: ${plan.mode} → ${destination.info.title}`,
      () => {
        source.items = plan.sourceItems;
        destination.items = plan.destinationItems;
        if (source !== destination && plan.mode === 'move') paneUI.selection(sourceId).clear();
        const targetSelection = paneUI.selection(destinationId);
        targetSelection.clear();
        for (const id of plan.selectedIds) targetSelection.add(id);
        focusPlaylist(destinationId);
      },
      { draftId: sourceId, readOnlySource: options.copy },
    );
  } catch (error) {
    log(error.message, 'error');
  }
}
function playlistId(value) {
  try {
    return new URL(value).searchParams.get('list') || value;
  } catch {
    return value;
  }
}
async function load(value, refresh = false) {
  const id = playlistId(value.trim());
  if (Object.hasOwn(state.drafts, id) && !refresh) {
    activate(id);
    log('Switched to loaded draft · no YouTube calls');
    return;
  }
  if (
    refresh &&
    Object.hasOwn(state.drafts, id) &&
    diffDraft(state.drafts[id]).dirty &&
    !confirm(
      'Reloading discards this playlist’s staged changes. Other playlist drafts are unchanged. Continue?',
    )
  )
    return;
  await operation(`Reading playlist ${id} (including continuation pages)…`, async () => {
    const snapshot = await api('/api/snapshots', { playlist: value });
    const { info, items, snapshotId, loadedAt } = snapshot;
    state.drafts[info.id] = {
      info,
      items: clone(items),
      original: clone(items),
      snapshotId,
      loadedAt,
      options: { artistSource: 'auto', withinArtist: 'original', reverse: false, overrides: {} },
      stale: false,
    };
    history = [];
    redoHistory = [];
    activate(info.id);
    log(
      `Loaded “${info.title}”: ${items.length} tracks · ${info.editable ? 'editable' : 'read-only'} · snapshot saved. No writes.`,
      'read',
    );
  });
}

function renderLibrary() {
  $('library-list').replaceChildren();
  const query = $('library-filter').value.toLocaleLowerCase();
  for (const p of state.library.filter((x) =>
    `${x.title} ${x.id}`.toLocaleLowerCase().includes(query),
  )) {
    const button = node('button', p.title, 'library-item');
    button.append(
      node(
        'small',
        `${p.kind === 'shortcut' ? 'System shortcut · load on demand' : p.count || p.id}${state.drafts[p.id] ? ' · loaded' : ''}`,
      ),
    );
    button.disabled =
      busy ||
      !!state.pending ||
      !hasWorkspaceLock ||
      (!authenticated && !Object.hasOwn(state.drafts, p.id));
    button.addEventListener('click', () => load(p.id));
    $('library-list').append(button);
  }
  if (!$('library-list').children.length)
    $('library-list').append(
      node(
        'p',
        state.library.length
          ? 'No matching playlists.'
          : 'No library loaded. Fetch it or open a URL below.',
        'empty',
      ),
    );
  $('loaded-list').replaceChildren();
  for (const d of Object.values(state.drafts)) {
    const button = node(
      'button',
      `${diffDraft(d).dirty ? '* ' : ''}${d.info.title}`,
      `library-item${state.active === d.info.id ? ' active' : ''}`,
    );
    button.append(
      node(
        'small',
        `${d.items.length} tracks · ${d.stale ? 'RELOAD REQUIRED' : d.info.editable ? 'editable' : 'read-only'}`,
      ),
    );
    button.addEventListener('click', () => activate(d.info.id));
    $('loaded-list').append(button);
  }
}
function renderTable() {
  paneUI.render();
}
function renderChrome() {
  state.layout = normalizeLayout(state.layout, state.drafts, state.active);
  const layout = state.layout;
  const root = document.documentElement;
  root.style.setProperty(
    '--library-width',
    layout.libraryHidden ? '0px' : `${layout.libraryWidth}px`,
  );
  root.style.setProperty(
    '--changes-width',
    layout.changesHidden ? '0px' : `${layout.changesWidth}px`,
  );
  root.style.setProperty('--library-sash', layout.libraryHidden ? '0px' : '5px');
  root.style.setProperty('--changes-sash', layout.changesHidden ? '0px' : '5px');
  root.style.setProperty('--console-height', `${layout.consoleHeight}px`);
  for (const id of ['library', 'changes', 'console']) {
    $(id + '-pane').hidden = layout[id + 'Hidden'];
    $(id + '-sash').hidden = layout[id + 'Hidden'];
    $('toggle-' + id).setAttribute('aria-pressed', !layout[id + 'Hidden']);
  }
  $('drop-mode').value = layout.dropMode;
  $('edit-controls').hidden = !layout.toolsOpen;
  $('toggle-edit-tools').setAttribute('aria-expanded', layout.toolsOpen);
}
function setupChrome() {
  $('toggle-edit-tools').onclick = () => {
    state.layout.toolsOpen = !state.layout.toolsOpen;
    renderChrome();
    save();
  };
  for (const id of ['library', 'changes', 'console']) {
    const toggle = () => {
      state.layout[id + 'Hidden'] = !state.layout[id + 'Hidden'];
      renderChrome();
      save();
    };
    $('toggle-' + id).onclick = toggle;
    $('minimize-' + id).onclick = toggle;
    const key =
      id === 'console' ? 'consoleHeight' : id === 'library' ? 'libraryWidth' : 'changesWidth';
    const minimum = id === 'console' ? 80 : id === 'library' ? 160 : 200;
    const maximum = id === 'console' ? 500 : id === 'library' ? 500 : 600;
    bindSash($(id + '-sash'), {
      axis: id === 'console' ? 'y' : 'x',
      reverse: id !== 'library',
      read: () => state.layout[key],
      min: () => minimum,
      max: () =>
        Math.min(
          maximum,
          id === 'console'
            ? Math.max(minimum, innerHeight - 320)
            : Math.max(minimum, innerWidth - 380),
        ),
      apply: (value) => {
        state.layout[key] = value;
        renderChrome();
      },
      end: () => save(),
      reset: () => {
        state.layout[key] = id === 'console' ? 160 : id === 'library' ? 210 : 250;
        renderChrome();
      },
    });
  }
  $('drop-mode').onchange = () => {
    state.layout.dropMode = $('drop-mode').value;
    save();
  };
  $('reset-layout').onclick = () => {
    state.layout = normalizeLayout({}, state.drafts, state.active);
    state.layout.open = Object.keys(state.drafts);
    save();
    render();
    log('Pane layout reset. Playlist drafts are unchanged.');
  };
}
function budget(d) {
  const diff = diffDraft(d);
  const retained = new Set(d.items.map((x) => x.itemId));
  const remaining = d.original.filter((x) => retained.has(x.itemId));
  const moves = diff.added.length
    ? Math.max(0, d.items.length - 1)
    : computeMoves(
        remaining.map((x) => x.itemId),
        d.items.map((x) => x.itemId),
      ).length;
  return diff.added.length + diff.removed.length + moves;
}
function renderChanges() {
  const changed = dirty();
  $('dirty-count').textContent = changed.length;
  $('change-list').replaceChildren();
  for (const d of changed) {
    const diff = describeDraftChanges(d);
    const block = node('div', undefined, 'change-block');
    block.append(
      node('h3', d.info.title),
      node('p', `+ ${diff.added.length} additions`, 'count-add'),
      node('p', `− ${diff.removed.length} removals`, 'count-remove'),
      node(
        'p',
        `${diff.reordered ? `${diff.orderChanges.length} existing tracks changed relative order` : 'Existing tracks keep their relative order'} · ≤ ${budget(d)} writes`,
      ),
    );
    const locked = busy || !!state.pending || !hasWorkspaceLock || d.stale || !d.info.editable;
    if (diff.added.length) {
      const additions = node('ul', undefined, 'staged-additions');
      for (const { item, to } of diff.additions) {
        const entry = node('li', undefined, 'staged-addition');
        const description = node('div', undefined, 'change-description');
        description.append(
          videoLink(item),
          node('small', `Add at final position #${to}`, 'change-position'),
        );
        entry.append(node('span', '+', 'count-add'), description);
        const revert = node('button', 'Revert', 'revert-addition');
        revert.setAttribute('aria-label', `Revert addition of ${item.title} to ${d.info.title}`);
        revert.title =
          'Cancel only this addition. Other staged edits, including transfer-source removals, remain unchanged.';
        revert.disabled = locked;
        revert.onclick = () =>
          edit(
            `Reverted addition of ${item.title} to ${d.info.title}; other staged changes kept`,
            (draft) => {
              draft.items = revertAddition(draft, item.itemId);
              if (state.active === draft.info.id) selected.delete(item.itemId);
            },
            { draftId: d.info.id },
          );
        entry.append(revert);
        additions.append(entry);
      }
      block.append(additions);
    }
    if (diff.removed.length) {
      const removals = node('ul', undefined, 'staged-additions');
      for (const { item, from } of diff.removals) {
        const entry = node('li', undefined, 'staged-addition');
        const description = node('div', undefined, 'change-description');
        description.append(
          videoLink(item),
          node('small', `Remove from loaded position #${from}`, 'change-position'),
        );
        entry.append(node('span', '−', 'count-remove'), description);
        const revert = node('button', 'Restore', 'revert-addition');
        revert.setAttribute('aria-label', `Revert removal of ${item.title} from ${d.info.title}`);
        revert.title =
          'Restore this entry near its original neighbors. Other entries keep their current order.';
        revert.disabled = locked;
        revert.onclick = () =>
          edit(
            `Reverted removal of ${item.title} from ${d.info.title}`,
            (draft) => {
              draft.items = revertRemoval(draft, item.itemId);
            },
            { draftId: d.info.id },
          );
        entry.append(revert);
        removals.append(entry);
      }
      block.append(removals);
    }
    if (diff.orderChanges.length) {
      const section = node('details', undefined, 'order-changes');
      section.open = true;
      section.append(node('summary', `ORDER CHANGES · ${diff.orderChanges.length} tracks`));
      const list = node('ul', undefined, 'staged-additions');
      for (const { item, from, to, fromRank, toRank } of diff.orderChanges) {
        const entry = node('li', undefined, 'staged-addition');
        const description = node('div', undefined, 'change-description');
        description.append(
          videoLink(item),
          node(
            'small',
            from === to
              ? `Still #${to} · relative order ${fromRank} → ${toRank}`
              : `Position #${from} → #${to}`,
            'change-position',
          ),
        );
        entry.append(node('span', '↕', 'count-order'), description);
        list.append(entry);
      }
      section.append(
        list,
        node(
          'p',
          'Loaded → final positions. Lists relative-order changes, not shifts caused only by additions/removals.',
          'buffer-note',
        ),
      );
      block.append(section);
    }
    const controls = node('div', undefined, 'buffer-controls');
    if (diff.reordered) {
      const revert = node('button', 'Revert order');
      revert.setAttribute('aria-label', `Revert order of ${d.info.title}`);
      revert.title =
        'Restore the relative order of original tracks, keeping additions and removals staged.';
      revert.disabled = locked;
      revert.onclick = () =>
        edit(
          `Reverted order of ${d.info.title}; additions and removals kept`,
          (draft) => {
            draft.items = revertOrder(draft);
          },
          { draftId: d.info.id },
        );
      controls.append(revert);
    }
    const reset = node('button', 'Revert playlist changes');
    reset.setAttribute('aria-label', `Revert all changes to ${d.info.title}`);
    reset.disabled = locked;
    reset.onclick = () => {
      if (
        !confirm(
          `Revert all staged changes to “${d.info.title}”? Other playlists stay unchanged. You can Undo this reset.`,
        )
      )
        return;
      edit(
        `Reverted all staged changes to ${d.info.title}`,
        (draft) => {
          draft.items = clone(draft.original);
          if (state.active === draft.info.id) selected.clear();
        },
        { draftId: d.info.id },
      );
    };
    controls.append(reset);
    block.append(controls);
    if (changed.length > 1 && (diff.added.length || diff.removed.length)) {
      block.append(
        node(
          'p',
          'Reverts affect this playlist only. For a transfer, revert both sides or use Undo.',
          'buffer-note',
        ),
      );
    }
    if (d.stale) block.append(node('p', 'RELOAD REQUIRED', 'warning'));
    $('change-list').append(block);
  }
  if (!changed.length) $('change-list').append(node('p', 'No staged changes.', 'empty'));
  const writes = changed.reduce((sum, d) => sum + budget(d), 0);
  $('commit-budget').textContent = changed.length
    ? `Budget ≤ ${writes} writes · limit ${maxUpdates || 'unlimited'} · ${writeDelayMs / 1000}s minimum spacing. Reads and verification take additional time.`
    : 'YouTube writes only on commit.';
  $('review').disabled =
    busy ||
    !!state.pending ||
    !hasWorkspaceLock ||
    saveFailed ||
    !authenticated ||
    !changed.length ||
    changed.some((d) => d.stale) ||
    !!(maxUpdates && writes > maxUpdates);
}
function renderControls() {
  const d = current();
  const locked = busy || !!state.pending || !hasWorkspaceLock;
  const canEdit = !!d?.info.editable && !d.stale && !locked;
  for (const id of ['sort', 'reset', 'add']) $(id).disabled = !canEdit;
  for (const id of [
    'move-top',
    'move-up',
    'move-down',
    'move-bottom',
    'move-to',
    'remove',
    'transfer',
  ])
    $(id).disabled = !canEdit || !selected.size;
  $('copy').disabled = !d || d.stale || locked || !selected.size;
  $('undo').disabled = locked || !history.length;
  $('redo').disabled = locked || !redoHistory.length;
  $('import-workspace').disabled = locked;
  $('reload').disabled = !d || locked || !authenticated;
  for (const id of ['load', 'library-refresh']) $(id).disabled = locked || !authenticated;
  for (const id of ['connect', 'disconnect', 'clear-workspace']) $(id).disabled = locked;
  $('verify-session').disabled = locked || !credentials;
  $('selection-count').textContent = `${selected.size} selected`;
  const destination = $('destination').value;
  $('destination').replaceChildren(node('option', 'Choose loaded destination…'));
  $('destination').firstChild.value = '';
  for (const target of Object.values(state.drafts).filter(
    (x) => x !== d && x.info.editable && !x.stale,
  )) {
    const option = node('option', target.info.title);
    option.value = target.info.id;
    $('destination').append(option);
  }
  $('destination').value = destination;
  renderChanges();
}
function updateActiveHeading() {
  const d = current();
  $('preview-title').textContent = d ? `ACTIVE / ${d.info.title}` : '02 / PLAYLIST WORKSPACE';
  $('preview-stats').textContent = d
    ? `${d.items.length} tracks · ${d.info.id} · loaded ${new Date(d.loadedAt).toLocaleTimeString()}`
    : 'Load a playlist to begin.';
  $('permission-warning').hidden = !d || (d.info.editable && !d.stale);
  $('permission-warning').textContent = d?.stale
    ? 'Snapshot consumed by a commit attempt. Reload this playlist before further edits. Its actual state may differ from the draft.'
    : d?.info.permissionError ||
      'Read-only playlist. Tracks can be copied to an editable destination.';
}
function render() {
  updateActiveHeading();
  renderChrome();
  renderLibrary();
  renderTable();
  renderControls();
}

$('library-refresh').onclick = () =>
  operation('Fetching playlist library from YouTube…', async () => {
    state.library = withSystemPlaylists((await api('/api/library', {})).playlists);
    save();
    log(
      `Cached ${state.library.length} library entries (including system shortcuts). Filtering and switching loaded playlists stay local.`,
      'read',
    );
  });
$('library-filter').oninput = renderLibrary;
$('track-filter').oninput = () => {
  paneUI.setFilter(state.active, $('track-filter').value);
  renderTable();
};
$('load').onclick = () => load($('playlist').value);
$('playlist').onkeydown = (event) => {
  if (event.key === 'Enter') $('load').click();
};
$('reload').onclick = () => load(state.active, true);
$('sort').onclick = () =>
  edit('Artist sort staged; adjust the final order with position controls', (d) => {
    const opts = options();
    d.items = sortItems(
      d.items.map((x, position) => ({ ...x, position })),
      opts,
    ).map((x) => x.item);
    d.options = opts;
  });
$('undo').onclick = () => {
  if (busy || state.pending || !hasWorkspaceLock || !history.length) return;
  redoHistory.push(
    Object.fromEntries(
      Object.entries(state.drafts).map(([id, d]) => [
        id,
        { items: clone(d.items), options: clone(d.options) },
      ]),
    ),
  );
  const previous = history.pop();
  for (const [id, data] of Object.entries(previous))
    if (state.drafts[id]) Object.assign(state.drafts[id], data);
  selected.clear();
  activate(state.active);
  log('Undid last workspace edit (including both sides of a transfer) · LOCAL ONLY');
};
$('redo').onclick = () => {
  if (busy || state.pending || !hasWorkspaceLock || !redoHistory.length) return;
  history.push(
    Object.fromEntries(
      Object.entries(state.drafts).map(([id, d]) => [
        id,
        { items: clone(d.items), options: clone(d.options) },
      ]),
    ),
  );
  const next = redoHistory.pop();
  for (const [id, data] of Object.entries(next))
    if (state.drafts[id]) Object.assign(state.drafts[id], data);
  selected.clear();
  activate(state.active);
  log('Redid the last workspace edit · LOCAL ONLY');
};
$('reset').onclick = () => {
  if (confirm('Reset this draft to its loaded snapshot? Other playlists are unchanged.'))
    edit('Draft reset', (d) => {
      d.items = clone(d.original);
      selected.clear();
    });
};
$('select-all').onclick = () => {
  for (const x of visibleItems()) selected.add(x.itemId);
  renderTable();
  renderControls();
};
$('select-none').onclick = () => {
  selected.clear();
  renderTable();
  renderControls();
};
function reposition(which) {
  edit('Manual order staged', (d) => {
    if (!selected.size) throw new Error('Select tracks first.');
    if (which === 'up' || which === 'down') {
      const items = [...d.items];
      if (which === 'up') {
        for (let i = 1; i < items.length; i++)
          if (selected.has(items[i].itemId) && !selected.has(items[i - 1].itemId))
            [items[i - 1], items[i]] = [items[i], items[i - 1]];
      } else {
        for (let i = items.length - 2; i >= 0; i--)
          if (selected.has(items[i].itemId) && !selected.has(items[i + 1].itemId))
            [items[i], items[i + 1]] = [items[i + 1], items[i]];
      }
      d.items = items;
    } else {
      const position =
        which === 'top'
          ? 0
          : which === 'bottom'
            ? d.items.length
            : Number($('move-position').value) - 1;
      if (!Number.isInteger(position) || position < 0)
        throw new Error('Position must be a positive whole number.');
      d.items = moveSelection(d.items, selected, position);
    }
  });
  $('playlist-panes')
    .querySelector('.playlist-pane.active tr.selected')
    ?.scrollIntoView({ block: 'nearest' });
}
for (const direction of ['top', 'up', 'down', 'bottom', 'to'])
  $(`move-${direction}`).onclick = () => reposition(direction);
$('remove').onclick = () =>
  edit(`Removal of ${selected.size} entries staged`, (d) => {
    d.items = removeItems(d.items, selected);
    selected.clear();
  });
for (const [id, remove] of [
  ['copy', false],
  ['transfer', true],
])
  $(id).onclick = () =>
    edit(
      `${remove ? 'Transfer' : 'Copy'} staged across playlists`,
      (d) => {
        const destination = state.drafts[$('destination').value];
        if (!destination || !destination.info.editable || destination.stale)
          throw new Error('Load and choose an editable destination first.');
        transferItems(d, destination, selected, remove, newId);
        if (remove) selected.clear();
      },
      { readOnlySource: !remove },
    );
$('add').onclick = () =>
  edit('Video additions staged; no metadata requests made', (d) => {
    const videos = $('add-videos')
      .value.trim()
      .split(/[\s,]+/u)
      .filter(Boolean)
      .map(parseVideoId);
    if (!videos.length) throw new Error('Enter video URLs or IDs first.');
    d.items.push(
      ...videos.map((videoId) => ({ itemId: newId(), videoId, title: videoId, channel: '' })),
    );
    $('add-videos').value = '';
  });
$('clear-workspace').onclick = () => {
  if (
    busy ||
    state.pending ||
    !hasWorkspaceLock ||
    !confirm(
      'Discard all local drafts and cached playlist metadata? Export a backup first if needed. This does not change YouTube or remove saved cookies.',
    )
  )
    return;
  state = {
    library: withSystemPlaylists([]),
    drafts: {},
    active: null,
    pending: null,
    workspaceToken,
  };
  state.layout = normalizeLayout({}, state.drafts, null);
  paneUI.clear();
  selected = paneUI.selection(null);
  history = [];
  redoHistory = [];
  selected.clear();
  save();
  render();
  log('Local workspace cleared. YouTube unchanged.');
};
function setConnection(label, status) {
  $('connection-state').textContent = label;
  $('connection-state').dataset.state = status;
}
function sessionName() {
  return typeof credentials?.identity?.name === 'string' ? credentials.identity.name : null;
}
function openSession() {
  $('session-error').hidden = true;
  $('session-identity').textContent = credentials
    ? sessionName()
      ? `Saved channel: ${sessionName()}`
      : 'Saved cookies · verify to identify the channel.'
    : 'No saved session.';
  $('account-index').value = credentials?.accountIndex ?? 0;
  $('channel-id').value = credentials?.channelId ?? '';
  if (!$('connect-panel').open) $('connect-panel').showModal();
}
async function storeCredentials(nextCredentials) {
  if ($('remember-cookies').checked) {
    await writeRecord('credentials', nextCredentials);
    sessionStorage.removeItem('ytm-session-credentials');
  } else {
    sessionStorage.setItem('ytm-session-credentials', JSON.stringify(nextCredentials));
    await writeRecord('credentials', undefined);
  }
  credentials = nextCredentials;
}
function connected() {
  authenticated = true;
  setConnection(`CONNECTED / ${sessionName() || 'CHANNEL NAME UNAVAILABLE'}`, 'connected');
  $('connect-panel').close();
}
$('session-toggle').onclick = openSession;
$('session-close').onclick = () => $('connect-panel').close();
$('connect-panel').addEventListener('close', () => {
  $('cookies').value = '';
});
$('verify-session').onclick = () =>
  operation('Checking saved session with YouTube…', async () => {
    const result = await api('/api/connect', credentials);
    await storeCredentials({ ...credentials, identity: result.identity });
    connected();
    log('Saved session verified. Channel name updated; playlists unchanged.', 'read');
  });
$('connect').onclick = () =>
  operation('Validating cookies with YouTube…', async () => {
    const nextCredentials = {
      cookies: $('cookies').value,
      accountIndex: Number($('account-index').value),
      channelId: $('channel-id').value.trim(),
    };
    const result = await api('/api/connect', nextCredentials);
    await storeCredentials({ ...nextCredentials, identity: result.identity });
    $('cookies').value = '';
    connected();
    log('Session accepted. Library fetch and playlist loading are on demand.', 'read');
  });
$('disconnect').onclick = () =>
  operation('Forgetting credentials in this browser…', async () => {
    await writeRecord('credentials', undefined);
    sessionStorage.removeItem('ytm-session-credentials');
    credentials = null;
    $('cookies').value = '';
    authenticated = false;
    setConnection('DISCONNECTED', 'disconnected');
    $('session-identity').textContent = 'No saved session.';
    log('Browser-stored credentials removed. Drafts remain; YouTube itself was not signed out.');
  });
$('log-clear').onclick = () => {
  savedEvents = [];
  $('activity-log').replaceChildren();
  if (hasWorkspaceLock) void writeRecord('activity', []).catch(() => {});
};

$('review').onclick = () => {
  if ($('review').disabled) return;
  const content = $('review-content');
  content.replaceChildren();
  for (const d of dirty()) {
    const diff = diffDraft(d);
    content.append(
      node('h3', `${d.info.title} · ${d.items.length} final tracks · ≤ ${budget(d)} writes`),
    );
    if (diff.removed.length) {
      content.append(node('p', 'REMOVE FROM THIS PLAYLIST', 'removed'));
      const removed = node('ol');
      for (const x of diff.removed) {
        const li = node('li', undefined, 'removed');
        li.append(videoLink(x, `${x.title} [${x.videoId}]`));
        removed.append(li);
      }
      content.append(removed);
    }
    const details = node('details');
    details.open = true;
    details.append(node('summary', 'Final order (+ marks new entries)'));
    const added = new Set(diff.added.map((x) => x.itemId));
    const order = node('ol');
    for (const x of d.items) {
      const li = node(
        'li',
        `${added.has(x.itemId) ? '+ ' : ''}${artist(x, d)} / `,
        added.has(x.itemId) ? 'added' : '',
      );
      li.append(videoLink(x, `${x.title} [${x.videoId}]`));
      order.append(li);
    }
    details.append(order);
    content.append(details);
  }
  $('commit-confirm').checked = false;
  $('commit').disabled = true;
  $('review-dialog').showModal();
  log('Commit review built locally. Nothing sent to YouTube.');
};
$('review-close').onclick = () => $('review-dialog').close();
$('commit-confirm').onchange = () => {
  $('commit').disabled = !$('commit-confirm').checked;
};

async function watchCommit() {
  if (polling || !state.pending || !hasWorkspaceLock) return;
  polling = true;
  busy = true;
  render();
  $('job-progress').hidden = false;
  const jobId = state.pending.commitId;
  try {
    while (state.pending?.commitId === jobId) {
      let job;
      try {
        job = await api(`/api/jobs/${jobId}`, undefined, { quiet: true });
      } catch (error) {
        if (error.code === 'WORKER_RESTARTED') {
          finishInterrupted(
            'Worker restarted. The last browser receipt is only a lower bound on completed writes. Reload affected playlists; this commit will not be replayed.',
          );
          break;
        }
        log(
          `Commit tracking unavailable: ${error.message} Drafts remain locked. Use “Resume tracking”; no YouTube writes are retried.`,
          'error',
        );
        $('resume-tracking').hidden = false;
        if (error.status === 404) $('recover-workspace').hidden = false;
        break;
      }
      for (const event of job.events.slice(displayedEvents))
        log(event.message, event.phase, event.at);
      displayedEvents = job.events.length;
      state.pending.receipt = job;
      if (!(await save())) {
        log(
          'Commit is running, but its browser receipt could not be saved. Keep this tab open and free browser storage.',
          'error',
        );
      }
      $('operation-state').textContent =
        `${job.status.toUpperCase()} · ${job.writes} CONFIRMED WRITES`;
      $('job-progress').max = Math.max(1, job.maximum);
      $('job-progress').value = job.writes;
      if (job.status !== 'running') {
        state.lastCommit = job;
        state.receipts = [...(state.receipts || []), job].slice(-20);
        for (const p of job.playlists) if (state.drafts[p.id]) state.drafts[p.id].stale = true;
        state.pending = null;
        history = [];
        redoHistory = [];
        save();
        if (job.status === 'succeeded') {
          $('job-progress').value = $('job-progress').max;
          log(
            `VERIFIED: ${job.writes} writes. Reload affected playlists to start a fresh draft.`,
            'local',
          );
        } else
          log(
            `${job.error || 'Commit interrupted.'} ${job.writes} writes confirmed; the last submitted write may also have succeeded. Reload affected playlists.`,
            'error',
          );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Local job journal only, never YouTube.
    }
  } finally {
    polling = false;
    busy = false;
    render();
  }
}
$('commit').onclick = async () => {
  if (!$('commit-confirm').checked || busy || state.pending || !hasWorkspaceLock || saveFailed)
    return;
  const drafts = dirty().map((d) => ({
    snapshotId: d.snapshotId,
    snapshot: { info: d.info, items: d.original },
    items: d.items.map((x) => ({ itemId: x.itemId, videoId: x.videoId })),
  }));
  state.pending = { commitId: crypto.randomUUID(), instanceId: workerInstance, drafts };
  busy = true;
  displayedEvents = 0;
  $('review-dialog').close();
  render();
  if (!(await save())) {
    state.pending = null;
    busy = false;
    render();
    log('Commit blocked: browser intent could not be saved. No request was submitted.', 'error');
    return;
  }
  log('Submitting reviewed commit to the local worker. It will preflight before writing.', 'write');
  try {
    await api('/api/commits', state.pending);
  } catch (error) {
    if (error.code === 'WORKER_RESTARTED') {
      finishInterrupted(
        'Worker changed before commit submission. Reload affected playlists and review again.',
      );
    }
    if (error.status && error.status < 500) {
      state.pending = null;
      save();
    }
    log(
      `${error.message}${state.pending ? ' Submission outcome unknown. Resume tracking before any new commit.' : ' Commit not accepted.'}`,
      'error',
    );
  } finally {
    busy = false;
    render();
  }
  if (state.pending) await watchCommit();
};
const resume = node('button', 'Resume tracking');
resume.id = 'resume-tracking';
resume.hidden = true;
$('operation-state').after(resume);
resume.onclick = () => {
  resume.hidden = true;
  void watchCommit();
};
const recover = node('button', 'Recover by reloading');
recover.id = 'recover-workspace';
recover.hidden = true;
resume.after(recover);
recover.onclick = () => {
  if (
    !state.pending ||
    polling ||
    !hasWorkspaceLock ||
    !confirm(
      'The worker has no receipt for this commit. Mark it uncertain and require affected playlists to be reloaded? No writes will be retried.',
    )
  )
    return;
  finishInterrupted(
    'No worker receipt found. Reload affected playlists to determine their actual state.',
  );
  recover.hidden = true;
  resume.hidden = true;
  render();
};
function finishInterrupted(message) {
  if (!state.pending) return;
  const snapshots = new Set(state.pending.drafts.map((x) => x.snapshotId));
  for (const draft of Object.values(state.drafts))
    if (snapshots.has(draft.snapshotId)) draft.stale = true;
  const receipt = {
    ...(state.pending.receipt || {}),
    id: state.pending.commitId,
    status: 'interrupted',
    writes: state.pending.receipt?.writes || 0,
    error: message,
    finishedAt: new Date().toISOString(),
  };
  state.lastCommit = receipt;
  state.receipts = [...(state.receipts || []), receipt].slice(-20);
  state.pending = null;
  history = [];
  redoHistory = [];
  save();
  log(message, 'error');
}

$('retry-save').onclick = async () => {
  await save();
  renderControls();
};
$('export-workspace').onclick = () => {
  try {
    const blob = new Blob([JSON.stringify(createBackup(state), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = node('a');
    anchor.href = url;
    anchor.download = `ytmsorter-workspace-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log(
      'Workspace backup exported. Credentials and pending jobs excluded. Playlist metadata is private—keep the file safe.',
    );
  } catch (error) {
    log(error.message, 'error');
  }
};
$('import-workspace').onclick = () => $('import-file').click();
$('import-file').onchange = async () => {
  const file = $('import-file').files[0];
  $('import-file').value = '';
  if (!file || busy || state.pending || !hasWorkspaceLock) return;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error('Workspace backup exceeds 16 MB.');
    const imported = readBackup(JSON.parse(await file.text()));
    if (
      !confirm(
        'Replace the current local workspace with this backup? Saved credentials are unchanged. Export the current workspace first if needed.',
      )
    )
      return;
    startupError = '';
    state = { ...imported, workspaceToken };
    $('density').value = state.preferences.density;
    document.body.dataset.density = state.preferences.density;
    history = [];
    redoHistory = [];
    selected.clear();
    activate(state.active);
    log('Workspace imported. No YouTube calls. Commit will recheck every affected playlist.');
  } catch (error) {
    log(error.message, 'error');
  }
};
$('density').value = state.preferences?.density || 'compact';
document.body.dataset.density = $('density').value;
$('density').onchange = () => {
  document.body.dataset.density = $('density').value;
  if (hasWorkspaceLock) {
    state.preferences = { ...state.preferences, density: $('density').value };
    save();
  }
};
for (const id of ['artist-source', 'within-artist', 'reverse', 'overrides'])
  $(id).addEventListener('change', () => {
    if (!current() || !hasWorkspaceLock || busy || state.pending) return;
    try {
      current().options = options();
      save();
      renderTable();
      renderControls();
    } catch (error) {
      log(error.message, 'error');
    }
  });
$('info-close').onclick = () => $('info-dialog').close();
$('help').onclick = () => {
  $('info-title').textContent = 'OPERATOR GUIDE';
  const content = $('info-content');
  content.replaceChildren();
  for (const [title, text] of [
    [
      '01 / Load',
      'Connect a browser session, then Fetch your library or paste a playlist URL. Loaded playlists are cached; switching between them does not contact YouTube.',
    ],
    [
      '02 / Stage',
      'Open playlists side by side from the library. The highlighted pane is active: shared controls apply to it. Drag the grip to reorder or move selected tracks between panes; hold Alt/Ctrl/⌘ to copy. Read-only sources only copy. Tools contains artist options, positions and additions. Each change stays in this browser.',
    ],
    [
      '03 / Review',
      'The commit buffer lets you revert individual additions/removals and order changes. Reverts affect only the named playlist. Undo reverses the whole last action, including both sides of a transfer.',
    ],
    [
      '04 / Commit',
      'Save intent in the browser, check live snapshots, add and verify destinations, remove sources, then reorder and verify. Writes are paced, not atomic. Never assume an interrupted commit rolled back.',
    ],
    [
      'Pane layout',
      'Drag dividers to resize; arrow keys work on focused dividers and double-click resets sizes. − minimizes a playlist to a vertical tab; × closes its view but keeps its draft. Use Library / Commit buffer / Activity to restore utility panels. Sizes persist, but the middle editor starts empty on reload. Reset layout shows all loaded drafts.',
    ],
    [
      'Persistence',
      'Drafts, 30 undo/redo steps, preferences, 200 events and 20 commit receipts persist in IndexedDB. Export workspace for a portable backup (no credentials). Clearing site data or using a different browser/origin starts a separate workspace.',
    ],
    [
      'Recovery',
      'Worker restarts do not lose drafts. A commit interrupted by a restart is never replayed; reload affected playlists. If tracking disconnects, Resume tracking reads only the worker’s memory.',
    ],
    [
      'Keyboard',
      'Ctrl/⌘ Z: Undo. Ctrl/⌘ Shift Z: Redo. Shortcuts are disabled while typing in form fields. Only one tab can edit the workspace at a time.',
    ],
    [
      'Privacy',
      'Saved cookies are powerful credentials. This local app sends them only to the local worker and YouTube. No analytics, remote fonts or cloud storage. Keep Docker bound to localhost.',
    ],
  ])
    content.append(node('h3', title), node('p', text));
  $('info-dialog').showModal();
};
$('receipts').onclick = () => {
  $('info-title').textContent = 'COMMIT HISTORY / BROWSER RECEIPTS';
  const content = $('info-content');
  content.replaceChildren();
  const receipts = state.receipts || (state.lastCommit ? [state.lastCommit] : []);
  if (!receipts.length) content.append(node('p', 'No commits recorded in this browser yet.'));
  for (const receipt of [...receipts].reverse()) {
    const details = node('details');
    details.append(
      node(
        'summary',
        `${receipt.status.toUpperCase()} · ${receipt.writes || 0} confirmed writes · ${new Date(receipt.finishedAt || receipt.startedAt).toLocaleString()}`,
      ),
    );
    details.append(
      node('p', receipt.error || 'Final order verified by the worker.'),
      node(
        'pre',
        (receipt.events || [])
          .map((event) => `${event.at} [${event.phase}] ${event.message}`)
          .join('\n') || 'No detailed events available.',
      ),
    );
    content.append(details);
  }
  $('info-dialog').showModal();
};
document.addEventListener('keydown', (event) => {
  if (
    !(event.ctrlKey || event.metaKey) ||
    event.key.toLowerCase() !== 'z' ||
    event.target.closest('input,textarea,select,[contenteditable]') ||
    document.querySelector('dialog[open]')
  )
    return;
  event.preventDefault();
  $(event.shiftKey ? 'redo' : 'undo').click();
});

for (const event of savedEvents) appendLog(event.message, event.kind, event.at);
setupChrome();
render();
if (state.active) focusPlaylist(state.active);
log(
  `${Object.keys(state.drafts).length ? 'Restored local drafts.' : 'Workspace ready.'} No YouTube requests on page load.`,
);
try {
  const session = await api('/api/session');
  if (session.protocol !== 2)
    throw new Error('Worker/UI versions do not match. Rebuild Docker and refresh this page.');
  workerInstance = session.instanceId;
  authenticated = !!credentials || session.demo;
  maxUpdates = session.maxUpdates;
  writeDelayMs = session.writeDelayMs;
  setConnection(
    session.demo
      ? 'DEMO / Demo operator'
      : authenticated
        ? `SAVED SESSION / ${sessionName() || 'VERIFY TO IDENTIFY'}`
        : 'DISCONNECTED',
    session.demo ? 'demo' : authenticated ? 'saved' : 'disconnected',
  );
  $('connection-state').title =
    'Saved sessions are checked on request, not polled. Use Session → Verify saved session to refresh the channel name.';
  if (!authenticated) openSession();
  $('version').textContent = `v${session.version} · STATELESS WORKER`;
  if (hasWorkspaceLock && state.pending?.instanceId !== workerInstance && state.pending) {
    finishInterrupted(
      'The worker changed or this is a legacy commit. Outcome may be partial; reload affected playlists before editing. No writes were replayed.',
    );
  }
} catch (error) {
  log(error.message, 'error');
}
if (startupError) {
  $('save-state').textContent = 'RESTORE FAILED';
  log(
    `Could not restore the saved workspace: ${startupError} Existing storage was not overwritten. Import a known-good backup, or fix browser storage and reload.`,
    'error',
  );
}
if (!hasWorkspaceLock) {
  $('tab-warning').hidden = false;
  $('save-state').textContent = 'READ-ONLY TAB';
} else if (!startupError) {
  if (await save()) {
    localStorage.removeItem(storageKey);
    localStorage.removeItem(logKey);
  }
}
render();
if (state.lastCommit && !state.pending) {
  $('operation-state').textContent =
    `LAST COMMIT: ${state.lastCommit.status.toUpperCase()} · ${state.lastCommit.writes} WRITES`;
}
if (state.pending) {
  log('Resuming local commit journal after page reload.', 'read');
  await watchCommit();
}
