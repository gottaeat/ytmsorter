// Layout is browser-owned metadata, independent of playlist edits/undo history.
const clamp = (value, min, max, fallback) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export function normalizeLayout(input = {}, drafts = {}, active = null) {
  input ||= {};
  const known = (id) => typeof id === 'string' && Object.hasOwn(drafts, id);
  const open = Array.isArray(input.open) ? [...new Set(input.open.filter(known))] : [];
  return {
    open,
    minimized: Array.isArray(input.minimized)
      ? [...new Set(input.minimized.filter((id) => open.includes(id)))]
      : [],
    weights: Object.fromEntries(
      Object.keys(drafts).map((id) => [id, clamp(input.weights?.[id], 0.1, 10000, 1)]),
    ),
    libraryWidth: clamp(input.libraryWidth, 160, 500, 210),
    changesWidth: clamp(input.changesWidth, 200, 600, 250),
    consoleHeight: clamp(input.consoleHeight, 32, 500, 160),
    libraryHidden: input.libraryHidden === true,
    changesHidden: input.changesHidden === true,
    consoleHidden: input.consoleHidden === true,
    dropMode: input.dropMode === 'copy' ? 'copy' : 'move',
    toolsOpen: input.toolsOpen === true,
  };
}
