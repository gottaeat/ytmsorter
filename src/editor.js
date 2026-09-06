import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { computeMoves } from './sorting.js';
import { youtubeClient, YouTubeApiError } from './youtube.js';
import { AuthenticationRequiredError } from './auth.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = (message) => {
  throw new YouTubeApiError(message);
};
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const ids = (items) => items.map((x) => x.itemId);

export function validateSnapshot(snapshot) {
  if (
    !snapshot ||
    !/^[\w-]{2,128}$/u.test(snapshot.info?.id || '') ||
    typeof snapshot.info.title !== 'string' ||
    snapshot.info.title.length > 1000 ||
    typeof snapshot.info.channelId !== 'string' ||
    snapshot.info.channelId.length > 512 ||
    typeof snapshot.info.editable !== 'boolean' ||
    !Array.isArray(snapshot.items) ||
    snapshot.items.length > 10000
  )
    fail('Invalid playlist snapshot. Reload this playlist.');
  const seen = new Set();
  for (const item of snapshot.items) {
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
      fail('Invalid snapshot entries. Reload this playlist.');
    seen.add(item.itemId);
  }
  return snapshot;
}

export function prepareChanges(snapshots, drafts) {
  if (
    !Array.isArray(drafts) ||
    !drafts.length ||
    drafts.length > 20 ||
    drafts.length !== snapshots.length
  )
    fail('Commit between 1 and 20 loaded playlists.');
  const seen = new Set();
  return drafts.map((draft, index) => {
    const snapshot = snapshots[index];
    if (!snapshot || snapshot.claimedBy)
      fail('This snapshot was already committed or attempted. Reload the affected playlists.');
    if (seen.has(snapshot.info.id)) fail('A playlist appears twice in this commit.');
    seen.add(snapshot.info.id);
    if (!snapshot.info.editable) fail('This playlist is read-only.');
    if (!Array.isArray(draft.items) || draft.items.length > 10000)
      fail('Invalid target playlist size.');
    const original = new Map(snapshot.items.map((x) => [x.itemId, x]));
    const targetIds = new Set();
    const target = draft.items.map((item) => {
      if (!item || typeof item.itemId !== 'string' || targetIds.has(item.itemId))
        fail('Invalid or duplicate draft item IDs.');
      targetIds.add(item.itemId);
      const existing = original.get(item.itemId);
      if (existing) return { ...existing };
      if (
        !item.itemId.startsWith('new:') ||
        !uuid.test(item.itemId.slice(4)) ||
        !/^[\w-]{11}$/u.test(item.videoId || '')
      )
        fail('Unknown track or invalid added video ID.');
      return { itemId: item.itemId, videoId: item.videoId, title: item.videoId, channel: '' };
    });
    const additions = target.filter((x) => !original.has(x.itemId));
    const removals = snapshot.items.filter((x) => !targetIds.has(x.itemId));
    const retained = snapshot.items.filter((x) => targetIds.has(x.itemId));
    // New-item insertion positions are chosen by YouTube; budget for any order.
    const moves = additions.length
      ? Math.max(0, target.length - 1)
      : computeMoves(ids(retained), ids(target)).length;
    return {
      snapshot,
      target,
      additions,
      removals,
      maxWrites: additions.length + removals.length + moves,
    };
  });
}

export async function executeCommit(
  client,
  changes,
  {
    report = async () => {},
    delayMs = config.writeDelayMs,
    maxUpdates = config.maxUpdates,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    shouldStop = () => false,
  } = {},
) {
  let writes = 0;
  const write = async (message, operation) => {
    if (maxUpdates && writes >= maxUpdates)
      fail('Write limit reached. Reload affected playlists before continuing.');
    if (writes) await pause(Math.max(1000, delayMs));
    if (shouldStop())
      fail(
        'Worker is shutting down. No further writes will be submitted. Reload affected playlists.',
      );
    await report('write', message, writes);
    await operation();
    writes += 1;
    await report('confirmed', message, writes);
  };
  // Preflight every destination/source before making the first change.
  for (const change of changes) {
    await report(
      'check',
      `Checking access and current order: ${change.snapshot.info.title}`,
      writes,
    );
    const current = await client.playlistSnapshot(change.snapshot.info.id);
    if (!current.info.editable || current.info.channelId !== change.snapshot.info.channelId)
      fail('Edit access or ownership changed. No further edits will be made.');
    if (
      !equal(ids(current.items), ids(change.snapshot.items)) ||
      current.items.some((x, i) => x.videoId !== change.snapshot.items[i].videoId)
    )
      fail(
        `Playlist changed since loading: ${change.snapshot.info.title}. Reload it and review again.`,
      );
    change.working = current.items;
  }
  for (const change of changes) {
    for (const item of change.additions) {
      await write(`Add ${item.videoId} → ${change.snapshot.info.title}`, () =>
        client.addItem(change.snapshot.info.id, item.videoId),
      );
    }
  }
  // Verify every addition before removing anything (including transfer sources).
  for (const change of changes) {
    if (!change.additions.length) continue;
    await report('verify', `Verifying added tracks: ${change.snapshot.info.title}`, writes);
    const current = await client.playlistItems(change.snapshot.info.id);
    const oldIds = new Set(ids(change.working));
    if (!equal(ids(current.filter((x) => oldIds.has(x.itemId))), ids(change.working)))
      fail('Existing tracks changed while adding. Stopped before removals.');
    const added = current.filter((x) => !oldIds.has(x.itemId));
    if (added.length !== change.additions.length)
      fail('YouTube did not return the expected added tracks. Stopped before removals.');
    for (const pending of change.additions) {
      const index = added.findIndex((x) => x.videoId === pending.videoId);
      if (index < 0) fail('An added video could not be verified. Stopped before removals.');
      const [actual] = added.splice(index, 1);
      pending.itemId = actual.itemId; // target contains the same objects.
    }
    change.working = current;
  }
  for (const change of changes) {
    for (const item of change.removals) {
      await write(`Remove ${item.title} ← ${change.snapshot.info.title}`, () =>
        client.removeItem(change.snapshot.info.id, item.itemId),
      );
      change.working = change.working.filter((x) => x.itemId !== item.itemId);
    }
    const moves = computeMoves(ids(change.working), ids(change.target));
    for (const move of moves) {
      const next = [...change.working];
      const [item] = next.splice(move.fromPosition, 1);
      const successor = next[move.toPosition]?.itemId;
      await write(
        `Position ${move.fromPosition + 1} → ${move.toPosition + 1}: ${change.snapshot.info.title}`,
        () => client.moveItem(change.snapshot.info.id, item.itemId, successor),
      );
      next.splice(move.toPosition, 0, item);
      change.working = next;
    }
  }
  for (const change of changes) {
    await report(
      'verify',
      `Verifying final membership and order: ${change.snapshot.info.title}`,
      writes,
    );
    const actual = await client.playlistItems(change.snapshot.info.id);
    if (!equal(ids(actual), ids(change.target)))
      fail(
        `Final verification failed for ${change.snapshot.info.title}. Reload before continuing.`,
      );
  }
  await report(
    'done',
    `Commit verified. ${writes} writes across ${changes.length} playlists.`,
    writes,
  );
  return writes;
}

export function mountEditorRoutes(
  app,
  {
    requireJson,
    parsePlaylistId,
    clientFactory = youtubeClient,
    instanceId = randomUUID(),
    maxJobs = config.maxJobs,
  },
) {
  const jobs = new Map();
  const claimed = new Set();
  let active = null;
  let stopping = false;
  const owner = (req) => {
    const token = req.get('X-Workspace-Token');
    if (!uuid.test(token || '')) fail('Invalid browser workspace token. Reload the app.');
    return token;
  };
  const instanceMatches = (value, res) => {
    if (value === instanceId) return true;
    res.status(410).json({
      error:
        'Worker restarted. The previous commit outcome is uncertain. Reload affected playlists; never replay it.',
      code: 'WORKER_RESTARTED',
      instanceId,
    });
    return false;
  };
  app.locals.worker = {
    instanceId,
    get busy() {
      return !!active;
    },
    async stop() {
      stopping = true;
      await active?.completion;
    },
  };
  app.post('/api/library', requireJson, async (req, res) => {
    if (stopping || active)
      return res.status(409).json({ error: 'Worker is busy. Wait for the commit to finish.' });
    const client = await clientFactory(req.body?.auth);
    res.json({ playlists: await client.listPlaylists() });
  });
  app.post('/api/snapshots', requireJson, async (req, res) => {
    if (stopping || active)
      return res.status(409).json({ error: 'Worker is busy. Wait for the commit to finish.' });
    const client = await clientFactory(req.body?.auth);
    const snapshot = await client.playlistSnapshot(parsePlaylistId(req.body?.playlist));
    res.json({ snapshotId: randomUUID(), ...snapshot, loadedAt: new Date().toISOString() });
  });
  app.get('/api/jobs/:id', (req, res) => {
    const workspace = owner(req);
    if (!instanceMatches(req.get('X-Worker-Instance'), res)) return;
    const entry = jobs.get(req.params.id);
    if (!entry || entry.owner !== workspace)
      return res
        .status(404)
        .json({ error: 'Commit not found in this worker instance.', code: 'JOB_NOT_FOUND' });
    res.json(entry.job);
  });
  app.post('/api/commits', requireJson, async (req, res) => {
    const workspace = owner(req);
    if (!instanceMatches(req.body?.instanceId, res)) return;
    const id = req.body?.commitId;
    if (!uuid.test(id || '')) fail('Invalid commit ID.');
    const previous = jobs.get(id);
    if (previous) {
      if (previous.owner !== workspace)
        return res.status(409).json({ error: 'Commit ID is already in use.' });
      return res.json({ jobId: id, instanceId });
    }
    if (stopping || active)
      return res
        .status(409)
        .json({ error: 'Another commit is running or the worker is stopping.' });
    if (jobs.size >= maxJobs)
      fail(
        'Worker receipt capacity reached. Export your browser workspace, then restart the worker. Existing receipts stay in your browser.',
      );
    const drafts = req.body?.drafts;
    if (!Array.isArray(drafts) || !drafts.length || drafts.length > 20)
      fail('Commit between 1 and 20 playlists.');
    const snapshots = drafts.map((draft) => {
      if (!uuid.test(draft?.snapshotId || ''))
        fail('Invalid snapshot ID. Reload affected playlists.');
      if (claimed.has(workspace + ':' + draft.snapshotId))
        fail('Snapshot already used in a commit attempt. Reload affected playlists.');
      return validateSnapshot(draft.snapshot);
    });
    const changes = prepareChanges(snapshots, drafts);
    const maximum = changes.reduce((sum, change) => sum + change.maxWrites, 0);
    if (config.maxUpdates && maximum > config.maxUpdates)
      fail(
        `Commit budget is up to ${maximum} writes, above MAX_UPDATES=${config.maxUpdates}. Reduce the draft or change the limit.`,
      );
    const job = {
      id,
      instanceId,
      status: 'running',
      startedAt: new Date().toISOString(),
      writes: 0,
      maximum,
      playlists: changes.map((change) => ({
        id: change.snapshot.info.id,
        title: change.snapshot.info.title,
      })),
      events: [],
    };
    const entry = { job, owner: workspace, completion: null };
    jobs.set(id, entry);
    for (const draft of drafts) claimed.add(workspace + ':' + draft.snapshotId);
    active = entry;
    const report = async (phase, message, writes) => {
      job.writes = writes;
      job.events.push({ at: new Date().toISOString(), phase, message });
    };
    // Credentials live only in this request/worker closure, never in a receipt.
    entry.completion = (async () => {
      try {
        await report(
          'start',
          'Preflight: checking browser snapshots against YouTube before any writes.',
          0,
        );
        await executeCommit(await clientFactory(req.body?.auth), changes, {
          report,
          shouldStop: () => stopping,
        });
        job.status = 'succeeded';
      } catch (error) {
        job.status = 'failed';
        job.error =
          error instanceof YouTubeApiError || error instanceof AuthenticationRequiredError
            ? error.message
            : 'Commit stopped unexpectedly. Reload affected playlists to check their actual state.';
        job.events.push({ at: new Date().toISOString(), phase: 'error', message: job.error });
      } finally {
        job.finishedAt = new Date().toISOString();
        active = null;
      }
    })();
    res.status(202).json({ jobId: id, instanceId });
  });
}
