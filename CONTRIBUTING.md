# Contributing

Use Node.js 24 and npm, or Docker. The application is plain browser ES modules plus Express; there
is no frontend bundler or cloud service.

```bash
npm ci
npm run check
npm run format:check
PORT=3001 BASE_URL=http://localhost:3001 npm run demo
```

Open http://localhost:3001 for two synthetic playlists. The demo never contacts YouTube. Do not
paste real credentials into it. Restarting the demo resets its fake upstream playlists, not the
browser's drafts. Use a separate port/origin from your real workspace.

## Layout

- `public/app.js`: UI, local staging, commit orchestration and recovery.
- `public/persistence.js`: IndexedDB and sanitized portable backups.
- `public/panes.js`, `public/layout.js`: split editors, pointer drag/drop, resizable dividers and
  sanitized browser-owned layout preferences.
- `public/model.js`, `public/sorting.js`: pure playlist operations, including duplicate
  detection/removal by video ID while retaining unique entry IDs.
- `src/editor.js`: snapshot validation, in-memory jobs, preflight/write/verify.
- `src/auth.js`, `src/youtube.js`: cookie parsing and YouTube adapter.
- `src/server.js`: HTTP routes and security boundaries.
- `tests/`: Node test runner; fake clients and HTTP servers only.
- `scripts/ui-fixture.mjs`: isolated, in-memory UI demo.

## UI conventions

Keep all surfaces dark, including native form controls, dialogs, warnings, and empty states. The
theme is permanent and must also work when the system prefers light mode. Use the shared colour
tokens and preserve readable contrast.

Keep everyday actions visible and advanced settings under **More options** or **Workspace**.
Selection controls should appear only when relevant. Opening them must not move a drop target during
a drag or a checkbox before its click finishes. Restore the user's open playlists and active view
without contacting YouTube.

**Remove duplicates** applies to the entire active draft, even with a search filter. Keep the first
occurrence in its current order, compare exact video IDs, and preserve the unique entry IDs and
order of retained songs. Include staged additions; never infer duplicates from titles or silently
deduplicate copies. Removals must use the existing Undo, diff, review, and commit path.

## Changes and tests

1. Keep local interactions local. Never fetch metadata on every selection/edit.
2. Use unique playlist entry IDs, not video IDs, to distinguish duplicates.
3. Preserve add-and-verify-before-remove for transfers; never auto-retry writes.
4. Save intent before HTTP submission. Treat unknown outcomes as uncertain, never as rollback. A
   worker restart must not replay an old intent.
5. Never log request bodies, raw upstream errors or credentials. Render user and upstream strings as
   text, not HTML. Backups must whitelist safe fields.
6. Add a regression test. Run `npm run format`, `npm run check`, and `npm run format:check`; also
   build the Docker image for runtime changes.
7. In the demo, check drag/drop within/across panes (including duplicate tracks, filtered insertion
   and read-only sources), resizing/minimizing, individual reverts, undo/redo after reload, a second
   tab, narrow-screen layout, and interrupted-commit recovery. The browser smoke test also covers
   the welcome screen, restored editors, contextual selection controls, destination validation,
   review confirmation, second-tab locking, permanent dark mode under a light browser preference,
   and deduplication with Undo/Redo. Do not test writes on a real account unless the account owner
   has specifically authorized them.

## Documentation screenshots

The README uses `docs/playlist-editor.png`. Refresh it from the isolated demo with synthetic
playlists only. Open both playlists, sort the source, and copy a song already present in the
destination. Activate the destination so the **Remove duplicates (1)** action and duplicate count
are visible alongside **Your changes**. Capture the fully loaded dark editor with normal browser
sizing. Never use a real account, personal playlists, or a connection dialog containing credentials
in repository screenshots.

`UI_SCREENSHOT=/absolute/path.png node scripts/ui-smoke.mjs` can also capture the smoke test's final
demo state. Playwright and Chromium are optional local test dependencies; they are not part of the
application runtime.

## Before publishing this repository

Review `git status --short` and the exact staged diff. The ignore files exclude known credential
exports and workspace backups, but cannot detect every secret. Do not add a whole browser profile or
Docker volume. Scan repository history if it has previously contained credentials; deleting a
working-tree file does not erase history. Enable private vulnerability reporting on GitHub. Run the
checks and Docker build locally; GitHub Actions and release publishing are not automated.
