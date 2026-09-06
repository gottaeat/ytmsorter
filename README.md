# ytmsorter

A local-first YouTube playlist workbench. Sort by artist, move tracks around,
copy or transfer between playlists, and review every change before committing.
A compact, industrial console—not a wall of oversized cards.

Open several playlists side by side, drag tracks within or between them, and
resize or minimize the surrounding panels like an editor workbench.

Your browser owns the workspace. Docker is a disposable worker. No Google Cloud
project, OAuth setup, database, data volume, analytics, or remote UI assets.

> This uses YouTube's unofficial internal API through
> [YouTube.js](https://github.com/LuanRT/YouTube.js). It can break, and no tool can
> promise that cookie-based automation will never trigger account restrictions.
> Use your own editable playlists, small commits, and keep it on localhost.

## Quick start

Requires Docker with Compose.

```bash
docker compose up --build -d
```

Open [localhost:3000](http://localhost:3000). Use the same browser profile and
address each time: `localhost` and `127.0.0.1` have separate browser storage.

```bash
docker compose logs --tail=50
docker compose down
```

Stopping/rebuilding Docker does not erase browser drafts. There is no data
volume in this version. Do not restart during a commit unless necessary.

### Connect your YouTube session

1. Sign in to YouTube in your normal browser and select the intended channel.
2. Open Developer Tools → **Network**, reload YouTube, then select a request to
   `www.youtube.com` (for example `/youtubei/v1/browse`).
3. Expand **Request Headers** and copy the **Cookie** header value. If it is not
   visible, choose another authenticated YouTube request—not a Google Accounts
   request or a static image. It is not under Response Headers.
4. Paste it into ytmsorter and click **Connect cookies**.

The Application → Cookies table lists individual values, but the request header
is the simplest way to copy the set actually sent by your browser. Do not use
`document.cookie`: it excludes HttpOnly values. A Netscape `cookies.txt` export
also works; paste its contents. Only unexpired YouTube-domain entries are used.
No browser extension is required by the request-header method.

For multiple accounts, the advanced **Account index** corresponds to the
YouTube request's `X-Goog-AuthUser` value. A delegated/Brand Account can require
the `X-Goog-PageId` value in **Delegated channel ID**. Leave these at their defaults
unless your selected account needs them.

Cookies are powerful credentials. Paste them only into your local app, never
chat, issues, or a public website. **Remember in this browser** stores them in
IndexedDB; unchecked uses tab-session storage. Neither is encrypted by this app.
**Disconnect** forgets the app's credentials, not your Google session.

## Workbench workflow

1. **Fetch** your library or paste a playlist URL and **Load tracks**. Load both
   source and destination before copying/transferring.
2. **Sort preview** groups artists. Adjust with Up/Down, Top/Bottom, or an exact
   position. Filter/select tracks, paste video URLs to add, or stage removals.
3. Inspect the **commit buffer**. Each added track has its own **Revert**; each
   removal has **Restore**. **Revert order** preserves membership edits. A
   playlist-level revert leaves other playlists alone.
4. **Undo / Redo** reverses whole workspace edits, including both sides of a
   transfer. `Ctrl/⌘ Z` and `Ctrl/⌘ Shift Z` work outside form fields.
5. **Review commit** shows all removals and final track orders. Confirm to send
   the change set. Watch the timestamped check/write/confirmed/verify events.
6. After any commit attempt, reload affected playlists before editing again.

The buffer shows the net difference from the loaded snapshot, not one entry per
mouse gesture. Additions show their **final position**; the expanded **Order
changes** section lists existing tracks whose relative order changed, with
loaded → final positions. Shifts caused only by inserting/removing other tracks
are not mislabeled as reorders. **Revert order** keeps membership edits staged;
workspace Undo reverses the last edit. Review still shows the complete final order.

### Split panes and drag/drop

Loading a playlist opens another editor pane; clicking an already loaded playlist
focuses or reopens its pane without fetching again. Each pane has its own filter,
selection and scroll position. The highlighted pane is active: the shared Sort,
Remove selected, and **Tools** controls apply to that playlist. Tools contains
artist options, explicit positions, additions, and copy/transfer controls.

- Drag the `⠿` grip to reorder a track. Select several tracks first to drag them
  together in their existing order. The insertion line shows the exact position;
  dropping into empty space appends to the end, even in a filtered view.
- Cross-playlist drags **move** by default. Hold **Alt, Ctrl or ⌘** to copy, or
  choose **Tools → Drag between → Copy**. Read-only sources always copy; stale
  or read-only destinations reject drops. External browser/file drags are ignored.
- Drags only stage changes. Undo reverses both sides of a move; the commit buffer
  still allows individual additions/removals to be reverted. Duplicate videos
  remain separate entries. There are no per-track Remove buttons: use the shared
  **Remove selected** action instead.
- Drag dividers between playlists, the library, the commit buffer, or the activity
  log. Focus a divider and use arrow keys for keyboard resizing; double-click to
  reset its size. **Reset layout** restores default panels and opens loaded drafts.
- **−** minimizes a playlist to a vertical tab; click it to restore. **×** closes
  only the view, never the draft. Library/Commit buffer/Activity buttons restore
  minimized utility panels. Pane sizes, open/minimized state and drag mode persist
  through reloads and workspace exports. Selections, filters and scroll positions
  are kept while the page is open, not across reloads.

On narrow screens, utility panels stack and playlist editors scroll horizontally.
Use selection and the explicit position/copy/move controls when native dragging
is unavailable, such as on touch-only devices.

Filtering, sorting, selecting, staging, individual reverts, undo/redo, exporting,
and review make **no YouTube calls**. Opening the page checks only the local
worker. Cookie validation, Fetch, Load and Reload explicitly contact YouTube;
large playlists may need several continuation requests. Commit tracking polls
only the worker's in-memory receipt. Nothing auto-commits or runs on a schedule.

Track names link directly to videos. Newly pasted URLs display video IDs until
a post-commit reload retrieves metadata. Copies keep known display metadata.
Duplicate videos are distinct playlist entries and can be edited independently.
Removing an entry does not delete the video itself.

**Liked Music (`LM`)** is always shown as a system shortcut because it can be
omitted by the regular library listing. It loads on demand as a read-only copy
source. Copy its songs into an editable playlist to sort them; this application
does not turn removals into unlike actions. Playlist creation/deletion is not
implemented.

Artist inference uses channel names (cleaning Topic/VEVO suffixes), title prefixes
such as `Artist - Song`, or video-ID overrides. It is a heuristic, not an official
music-credit database. Check compilations and user uploads in the preview.

## Persistence and backups

| Data                                                                       | Where it lives         | Survives Docker restart?           |
| -------------------------------------------------------------------------- | ---------------------- | ---------------------------------- |
| Loaded library, original snapshots, staged drafts, artist options, density | Browser IndexedDB      | Yes                                |
| Up to 30 undo/redo steps, 200 activity events, 20 commit receipts          | Browser IndexedDB      | Yes                                |
| Pending commit intent and last observed progress                           | Browser IndexedDB      | Yes; never automatically replayed  |
| Remembered cookies                                                         | Browser IndexedDB      | Yes                                |
| Tab-only cookies                                                           | Browser sessionStorage | Yes while that tab session remains |
| Active jobs and submission deduplication                                   | Worker memory          | No                                 |

The save indicator confirms completed browser transactions. Failed saves are
visible, with **Retry save**; a commit cannot be submitted without saving its
intent first. Only one tab can edit the same origin at a time. A second tab is
read-only; close the editing tab and reload the other to take over. This does not
coordinate separate browsers, origins, or devices—avoid concurrent upstream edits.

**Export workspace** produces a versioned JSON backup of library metadata,
snapshots, drafts and display/artist preferences. It deliberately excludes
cookies, workspace tokens, undo history, receipts and pending execution intents.
**Import workspace** validates and replaces local drafts after confirmation;
it does not contact YouTube. Commits still recheck live state. Keep backups
private: they contain playlist names and video IDs.

Browser storage is not an archival backup. Clearing site data, private browsing,
profile removal, or browser storage eviction can erase it. Export important work.
Undo/redo survives page reloads, but resets when loading a fresh snapshot or
finishing a commit. Current row selection/filter text is transient.

### Upgrading from the disk-backed version

Old `ytm-workspace-v1` localStorage drafts migrate to IndexedDB on the same origin.
The legacy keys are removed only after a successful save. Reconnect cookies once:
the worker no longer reads the old Docker volume. Existing volumes and the unused
`client_secret.json` are not deleted automatically. Old unfinished commits become
uncertain and require a reload of affected playlists. Export before upgrading.

## Commit safety and recovery

The worker checks every playlist's live edit access, owner, unique entry IDs,
video IDs and exact order against the browser snapshot before its first write.
Any mismatch stops preflight. Additions are performed and verified before source
removals; retained entries are then reordered with a minimum-length move plan,
and the final order is verified. Requests are sequential with at least one second
between writes. Rejected/failed writes are not automatically retried.

YouTube has no atomic transaction for this workflow: a commit can partly succeed.
Receipts distinguish submitted operations from confirmed responses; the last
unconfirmed write may also have succeeded. There is no automatic rollback.

- **Page reload:** resumes tracking the same worker job; does not resubmit it.
- **Connection loss:** keeps drafts locked. Use **Resume tracking** to query the
  local receipt, not repeat edits.
- **Worker restart:** a new boot ID rejects old submissions. The browser keeps
  its last receipt, marks the outcome uncertain, and requires affected playlists
  to be reloaded. An observed receipt is only a lower bound on completed writes.
- **Unknown job:** explicitly recover by reloading; never assume no edits occurred.

Same-ID submissions are deduplicated within one worker lifetime. This is not an
exactly-once guarantee across crashes. The worker retains up to `MAX_JOBS` receipts
and then asks for a restart instead of evicting deduplication records. Run a
single worker, not replicas behind a load balancer.

## Configuration

| Variable         | Default                         | Purpose                                                    |
| ---------------- | ------------------------------- | ---------------------------------------------------------- |
| `PORT`           | `3000`                          | Worker HTTP port                                           |
| `HOST`           | `127.0.0.1` (Docker: `0.0.0.0`) | Listen address; Compose publishes loopback only            |
| `BASE_URL`       | `http://localhost:3000`         | Allowed app origin; no path, query or credentials          |
| `MAX_UPDATES`    | `180`                           | Conservative write budget per commit; `0` disables the cap |
| `WRITE_DELAY_MS` | `1000`                          | Minimum delay between writes; cannot be lower than 1000    |
| `MAX_JOBS`       | `500`                           | In-memory receipts retained per worker lifetime            |

Edit Compose environment values, then `docker compose up --build -d`. When changing
ports, update the published port and `BASE_URL` consistently. Changing the browser
origin starts a separate workspace; export/import first. Modern Chromium/Firefox/
Safari with IndexedDB and Web Locks on a secure context (localhost qualifies) is
required. This is a desktop-oriented UI with a stacked narrow-screen layout.

At most 20 playlists and 10,000 target entries per playlist are accepted in one
commit; JSON requests are capped at 8 MB. Addition budgets are conservative because
YouTube chooses insertion positions. Reorder-only budgets are exact. These are
local limits, not official Google API quotas.

The runtime is non-root and read-only, with dropped capabilities, a small temporary
filesystem, a health check and a 45-second graceful shutdown window. No secrets
or persistent data mounts are needed. Keep localhost binding: this is not a
public or multi-user service. See [SECURITY.md](SECURITY.md).

## Development and tests

```bash
npm ci
npm run check
npm run format:check
npm start
```

Node.js 24 is required. Docker builds run the syntax checks and automated tests.
CI also checks formatting. Tests use fake YouTube adapters: no accounts, cookies
or live playlist writes. For an isolated UI demo:

```bash
PORT=3001 BASE_URL=http://localhost:3001 npm run demo
```

Open [localhost:3001](http://localhost:3001). The demo has two synthetic playlists;
all commits modify only its memory. Use a separate origin from real drafts.
See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture and release checks.

## Troubleshooting

- **Session rejected / signed out:** reconnect a fresh, complete Cookie request
  header. Saved cookies are not proof that YouTube still accepts them.
- **No edit permissions:** verify the exact playlist URL, selected Google account
  and channel, and whether YouTube itself lets you manually edit that playlist.
  Unknown permissions are never bypassed.
- **Changed since loading:** another client or an earlier partial commit changed
  YouTube. Reload, inspect and stage a new draft.
- **Read-only tab:** close the existing editing tab and reload. If no tab owns the
  workspace, check that Web Locks are available on localhost.
- **Not saved / restore failed:** free browser storage or fix its permissions.
  Do not clear site data without a backup. Failed restoration never overwrites
  the existing saved workspace automatically.
- **Worker/UI mismatch:** rebuild and refresh. The UI is not service-worker cached.

## License

Copyright (c) 2026 ytmsorter contributors. Licensed under the
[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
Third-party dependencies retain their own licenses. Not affiliated with Google or YouTube.
