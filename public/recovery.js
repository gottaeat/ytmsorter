// Reconcile reads without replacing the user's desired order. Ambiguous changes
// fail closed, leaving the entire workspace untouched for export/manual recovery.
export function recoverDraft(draft, fresh) {
  if (
    fresh.info.id !== draft.info.id ||
    !fresh.info.editable ||
    fresh.info.channelId !== draft.info.channelId
  ) {
    throw new Error(
      'This session cannot edit the same playlist owner. Select the correct channel; your draft is unchanged.',
    );
  }
  const available = new Map(fresh.items.map((item) => [item.itemId, item]));
  const matches = new Map();
  const desired = new Set(draft.items.map((item) => item.itemId));
  for (const item of draft.original) {
    const exact = available.get(item.itemId);
    if (exact && exact.videoId === item.videoId) {
      matches.set(item.itemId, exact);
      available.delete(exact.itemId);
    }
  }
  for (const item of draft.original) {
    if (matches.has(item.itemId)) continue;
    const candidates = [...available.values()].filter((x) => x.videoId === item.videoId);
    const sameOriginal = draft.original.filter((x) => x.videoId === item.videoId);
    if (candidates.length === 1 && sameOriginal.length === 1) {
      matches.set(item.itemId, candidates[0]);
      available.delete(candidates[0].itemId);
    } else if (desired.has(item.itemId) || candidates.length) {
      throw new Error(
        `Cannot safely match “${item.title}” to YouTube (missing or ambiguous duplicate). Your edits are kept. Export the workspace before resolving the conflict.`,
      );
    }
  }
  const originalIds = new Set(draft.original.map((item) => item.itemId));
  const additions = draft.items.filter((item) => !originalIds.has(item.itemId));
  for (const item of additions) {
    const candidates = [...available.values()].filter((x) => x.videoId === item.videoId);
    const pendingCopies = additions.filter((x) => x.videoId === item.videoId);
    if (candidates.length === 1 && pendingCopies.length === 1) {
      matches.set(item.itemId, candidates[0]);
      available.delete(candidates[0].itemId);
    }
  }
  if (available.size) {
    throw new Error(
      'YouTube has additional entries not in the loaded snapshot, possibly from a partial commit. Your edits are kept; export the workspace before resolving this membership conflict.',
    );
  }
  const items = draft.items.map((item) =>
    matches.has(item.itemId) ? { ...item, itemId: matches.get(item.itemId).itemId } : { ...item },
  );
  return {
    ...draft,
    info: fresh.info,
    original: fresh.items,
    items,
    snapshotId: fresh.snapshotId,
    loadedAt: fresh.loadedAt,
    stale: false,
  };
}
