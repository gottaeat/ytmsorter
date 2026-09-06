import { normalizeLayout } from './layout.js';

const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

// Pointer capture keeps the sash usable even when the pointer leaves its narrow hitbox.
export function bindSash(
  handle,
  { axis = 'x', read, apply, end, min, max, reverse = false, reset },
) {
  let start;
  const coordinate = (event) => (axis === 'x' ? event.clientX : event.clientY);
  const update = (value) => {
    const result = clamp(value, min(), max());
    apply(result);
    handle.setAttribute('aria-valuenow', Math.round(result));
  };
  handle.onpointerdown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    start = { point: coordinate(event), value: read() };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('resizing');
  };
  handle.onpointermove = (event) => {
    if (start) update(start.value + (coordinate(event) - start.point) * (reverse ? -1 : 1));
  };
  const finish = () => {
    if (!start) return;
    start = null;
    handle.classList.remove('resizing');
    end();
  };
  handle.onpointerup = finish;
  handle.onpointercancel = finish;
  handle.onlostpointercapture = finish;
  handle.onkeydown = (event) => {
    const negative = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const positive = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (![negative, positive, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    update(
      event.key === 'Home'
        ? min()
        : event.key === 'End'
          ? max()
          : read() + (event.key === negative ? -20 : 20) * (reverse ? -1 : 1),
    );
    end();
  };
  handle.ondblclick = () => {
    reset();
    end();
  };
  handle.setAttribute('aria-valuemin', min());
  handle.setAttribute('aria-valuemax', max());
  handle.setAttribute('aria-valuenow', Math.round(read()));
  handle.title = 'Drag or use arrow keys to resize. Double-click to reset.';
}

export function createPaneWorkspace({
  getState,
  isLocked,
  artist,
  videoLink,
  focus,
  onDrop,
  changed,
  controls,
}) {
  const host = document.getElementById('playlist-panes');
  const status = document.getElementById('drag-status');
  const selections = new Map();
  const filters = new Map();
  const scrolls = new Map();
  let drag = null;
  let scrolling = null;
  let frame = null;
  const selection = (id) => {
    if (!selections.has(id)) selections.set(id, new Set());
    return selections.get(id);
  };
  const layout = () => getState().layout;
  const visibleItems = (id) => {
    const draft = getState().drafts[id];
    const query = (filters.get(id) || '').toLocaleLowerCase();
    return (draft?.items || []).filter((item) =>
      `${item.title} ${item.channel} ${artist(item, draft)} ${item.videoId}`
        .toLocaleLowerCase()
        .includes(query),
    );
  };
  const clearMarker = () =>
    host
      .querySelectorAll('.drop-before,.drop-after,.drop-end')
      .forEach((node) => node.classList.remove('drop-before', 'drop-after', 'drop-end'));
  const stopScroll = () => {
    scrolling = null;
    if (frame) cancelAnimationFrame(frame);
    frame = null;
  };
  const scrollTick = () => {
    if (!scrolling || !drag) {
      frame = null;
      return;
    }
    scrolling.box.scrollTop += scrolling.speed;
    frame = requestAnimationFrame(scrollTick);
  };
  const autoScroll = (box, y) => {
    const rect = box.getBoundingClientRect();
    const speed = y < rect.top + 35 ? -8 : y > rect.bottom - 35 ? 8 : 0;
    if (!speed) {
      stopScroll();
      return;
    }
    scrolling = { box, speed };
    if (!frame) frame = requestAnimationFrame(scrollTick);
  };
  const dropMode = (event, destination) => {
    const source = getState().drafts[drag?.sourceId];
    return (
      source !== destination &&
      (!source?.info.editable ||
        layout().dropMode === 'copy' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey)
    );
  };
  const mayDrop = (destination, copy) => {
    const source = getState().drafts[drag?.sourceId];
    return (
      drag &&
      !isLocked() &&
      source &&
      !source.stale &&
      !destination.stale &&
      destination.info.editable &&
      (source.info.editable || (copy && source !== destination))
    );
  };
  const endDrag = () => {
    drag = null;
    clearMarker();
    stopScroll();
    host.querySelectorAll('.dragging').forEach((row) => row.classList.remove('dragging'));
    status.textContent =
      'Drag the grip to reorder or transfer. Alt/Ctrl/⌘ = copy. Changes stay local.';
  };
  document.addEventListener('dragend', endDrag);
  document.addEventListener('drop', () => {
    if (drag) endDrag();
  });

  function renderRows(pane, draft) {
    const tbody = pane.querySelector('tbody');
    tbody.replaceChildren();
    const selected = selection(draft.info.id);
    const positions = new Map(draft.items.map((item, i) => [item.itemId, i]));
    const original = new Map(draft.original.map((item, i) => [item.itemId, i]));
    for (const id of selected) if (!positions.has(id)) selected.delete(id);
    for (const item of visibleItems(draft.info.id)) {
      const position = positions.get(item.itemId);
      const before = original.get(item.itemId);
      const row = element(
        'tr',
        undefined,
        `${selected.has(item.itemId) ? 'selected ' : ''}${before === undefined ? 'added' : before !== position ? 'moved' : ''}`,
      );
      row.dataset.itemId = item.itemId;
      row.draggable = !isLocked() && !draft.stale;
      const grip = element('td', '⠿', 'drag-grip');
      grip.title = 'Drag this track or the selected tracks';
      const cell = element('td');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(item.itemId);
      checkbox.setAttribute('aria-label', `Select ${item.title}`);
      checkbox.onchange = () => {
        focus(draft.info.id);
        if (checkbox.checked) selected.add(item.itemId);
        else selected.delete(item.itemId);
        row.classList.toggle('selected', checkbox.checked);
        controls();
      };
      cell.append(checkbox);
      const title = element('td');
      const link = videoLink(item);
      link.draggable = false;
      title.append(link);
      title.append(element('small', artist(item, draft), 'track-artist'));
      const badge = before === undefined ? '+ NEW' : before !== position ? `WAS ${before + 1}` : '';
      row.append(
        grip,
        cell,
        element('td', position + 1),
        title,
        element('td', badge, 'track-state'),
      );
      row.ondragstart = (event) => {
        if (isLocked() || draft.stale || event.target.closest('a,input,button')) {
          event.preventDefault();
          return;
        }
        focus(draft.info.id);
        if (!selected.has(item.itemId)) {
          selected.clear();
          selected.add(item.itemId);
        }
        // Do not replace DOM nodes during dragstart: that cancels native dragging.
        for (const child of tbody.rows) {
          const chosen = selected.has(child.dataset.itemId);
          child.classList.toggle('selected', chosen);
          child.classList.toggle('dragging', chosen);
          const input = child.querySelector('input');
          if (input) input.checked = chosen;
        }
        drag = { sourceId: draft.info.id, ids: [...selected] };
        event.dataTransfer.effectAllowed = draft.info.editable ? 'copyMove' : 'copy';
        event.dataTransfer.setData('application/x-ytmsorter-tracks', 'internal-workspace-drag');
        status.textContent = `${selected.size} tracks · drop at the insertion line · ${draft.info.editable ? 'move (Alt/Ctrl/⌘ to copy)' : 'read-only source: copy only'}`;
        controls();
      };
      tbody.append(row);
    }
    if (!tbody.children.length) {
      const row = element('tr');
      const cell = element(
        'td',
        draft.items.length
          ? 'No matching tracks. Clear the filter to see all entries.'
          : 'Empty playlist — drop tracks here or stage additions.',
        'empty-drop',
      );
      cell.colSpan = 5;
      row.append(cell);
      tbody.append(row);
    }
  }

  function render() {
    for (const pane of host.querySelectorAll('.playlist-pane'))
      scrolls.set(pane.dataset.playlistId, pane.querySelector('.table-wrap')?.scrollTop || 0);
    host.replaceChildren();
    const state = getState();
    state.layout = normalizeLayout(state.layout, state.drafts, state.active);
    const open = layout().open;
    if (!open.length)
      host.append(
        element(
          'div',
          'Open playlists from the library to arrange them side by side. Closed panes keep their drafts.',
          'editor-empty',
        ),
      );
    for (const [index, id] of open.entries()) {
      const draft = state.drafts[id];
      if (
        index > 0 &&
        !layout().minimized.includes(id) &&
        !layout().minimized.includes(open[index - 1])
      ) {
        const previous = open[index - 1];
        const sash = element('div', undefined, 'sash playlist-sash');
        sash.tabIndex = 0;
        sash.setAttribute('role', 'separator');
        sash.setAttribute('aria-orientation', 'vertical');
        sash.setAttribute(
          'aria-label',
          `Resize between ${state.drafts[previous].info.title} and ${draft.info.title}`,
        );
        host.append(sash);
        const pair = () =>
          [...host.querySelectorAll('.playlist-pane')].filter((p) =>
            [previous, id].includes(p.dataset.playlistId),
          );
        bindSash(sash, {
          read: () => pair()[0]?.getBoundingClientRect().width || 280,
          min: () => 240,
          max: () =>
            Math.max(
              240,
              pair().reduce((sum, p) => sum + p.getBoundingClientRect().width, 0) - 240,
            ),
          apply: (value) => {
            const panes = [...host.querySelectorAll('.playlist-pane')];
            const widths = Object.fromEntries(
              panes.map((p) => [p.dataset.playlistId, p.getBoundingClientRect().width]),
            );
            const total = widths[previous] + widths[id];
            widths[previous] = value;
            widths[id] = total - value;
            for (const pane of panes) {
              layout().weights[pane.dataset.playlistId] = widths[pane.dataset.playlistId];
              pane.style.flexGrow = widths[pane.dataset.playlistId];
            }
          },
          end: changed,
          reset: () => {
            for (const pane of host.querySelectorAll('.playlist-pane')) {
              layout().weights[pane.dataset.playlistId] = 1;
              pane.style.flexGrow = 1;
            }
          },
        });
      }
      if (layout().minimized.includes(id)) {
        const restore = element('button', draft.info.title, 'minimized-playlist');
        restore.setAttribute('aria-label', `Restore ${draft.info.title}`);
        restore.title = `Restore ${draft.info.title}`;
        restore.onclick = () => {
          layout().minimized = layout().minimized.filter((x) => x !== id);
          focus(id);
          render();
          changed();
        };
        host.append(restore);
        continue;
      }
      const pane = element('section', undefined, 'playlist-pane');
      pane.dataset.playlistId = id;
      pane.classList.toggle('active', state.active === id);
      pane.style.flexGrow = layout().weights[id] || 1;
      pane.setAttribute('aria-label', `${draft.info.title} playlist editor`);
      pane.onpointerdown = () => focus(id);
      pane.onfocusin = () => {
        if (getState().active !== id) focus(id);
      };
      const header = element('div', undefined, 'playlist-title');
      const name = element('button', draft.info.title, 'playlist-name');
      name.title = `Activate ${draft.info.title}`;
      name.onclick = () => focus(id);
      const minimize = element('button', '−', 'icon-button');
      minimize.setAttribute('aria-label', `Minimize ${draft.info.title}`);
      const close = element('button', '×', 'icon-button');
      close.setAttribute('aria-label', `Close pane ${draft.info.title}`);
      close.title = 'Close pane only; staged changes are kept';
      const hide = (remove) => {
        if (remove) layout().open = layout().open.filter((x) => x !== id);
        else layout().minimized.push(id);
        if (getState().active === id)
          focus(layout().open.find((x) => x !== id && !layout().minimized.includes(x)) || null);
        render();
        changed();
      };
      minimize.onclick = () => hide(false);
      close.onclick = () => hide(true);
      header.append(name, minimize, close);
      const meta = element(
        'div',
        `${draft.items.length} tracks · ${draft.info.id} · ${draft.stale ? 'RELOAD REQUIRED' : draft.info.editable ? 'editable' : 'copy source'}`,
        'playlist-meta',
      );
      const filter = element('input');
      filter.placeholder = 'Filter this playlist…';
      filter.value = filters.get(id) || '';
      filter.setAttribute('aria-label', `Filter ${draft.info.title}`);
      filter.className = 'pane-filter';
      filter.oninput = () => {
        filters.set(id, filter.value);
        focus(id);
        renderRows(pane, draft);
        controls();
      };
      const box = element('div', undefined, 'table-wrap');
      const table = element('table');
      const head = element('thead');
      const columns = element('tr');
      for (const text of ['', 'SEL', '#', 'TRACK / ARTIST', ''])
        columns.append(element('th', text));
      head.append(columns);
      table.append(head, element('tbody'));
      box.append(table);
      const point = (event) => {
        const row = event.target.closest('tr[data-item-id]');
        if (!row) return { beforeId: null, row: null, after: false };
        const after =
          event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
        const index = draft.items.findIndex((item) => item.itemId === row.dataset.itemId);
        return {
          beforeId: after ? draft.items[index + 1]?.itemId || null : row.dataset.itemId,
          row,
          after,
        };
      };
      box.ondragover = (event) => {
        const copy = dropMode(event, draft);
        if (!mayDrop(draft, copy)) {
          if (drag) event.dataTransfer.dropEffect = 'none';
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = copy ? 'copy' : 'move';
        clearMarker();
        const target = point(event);
        if (target.row) target.row.classList.add(target.after ? 'drop-after' : 'drop-before');
        else box.classList.add('drop-end');
        status.textContent = `${drag.ids.length} tracks → ${draft.info.title} · ${drag.sourceId === id ? 'REORDER' : copy ? 'COPY' : 'MOVE'} · ${target.beforeId ? 'insert at line' : 'append to end'} · LOCAL ONLY`;
        autoScroll(box, event.clientY);
      };
      box.ondragleave = (event) => {
        if (!box.contains(event.relatedTarget)) {
          clearMarker();
          stopScroll();
        }
      };
      box.ondrop = (event) => {
        const copy = dropMode(event, draft);
        if (!mayDrop(draft, copy)) return;
        event.preventDefault();
        event.stopPropagation();
        const payload = drag;
        const { beforeId } = point(event);
        endDrag();
        onDrop(payload.sourceId, id, new Set(payload.ids), { beforeId, copy });
      };
      pane.append(header, meta, filter, box);
      host.append(pane);
      renderRows(pane, draft);
      box.scrollTop = scrolls.get(id) || 0;
    }
  }
  return {
    render,
    selection,
    visibleItems,
    filter: (id) => filters.get(id) || '',
    setFilter: (id, value) => filters.set(id, value),
    focus: (id) => {
      for (const pane of host.querySelectorAll('.playlist-pane'))
        pane.classList.toggle('active', pane.dataset.playlistId === id);
    },
    clear: () => {
      selections.clear();
      filters.clear();
      scrolls.clear();
    },
  };
}
