# Contributing

Use Node.js 24 and npm, or Docker. The application is plain browser ES modules
plus Express; there is no frontend bundler or cloud service.

```bash
npm ci
npm run check
npm run format:check
PORT=3001 BASE_URL=http://localhost:3001 npm run demo
```

Open http://localhost:3001 for two synthetic playlists. The demo never contacts
YouTube. Do not paste real credentials into it. Restarting the demo resets its
fake upstream playlists, not the browser's drafts. Use a separate port/origin
from your real workspace.

## Layout

- `public/app.js`: UI, local staging, commit orchestration and recovery.
- `public/persistence.js`: IndexedDB and sanitized portable backups.
- `public/panes.js`, `public/layout.js`: split editors, native drag/drop, resizable
  dividers and sanitized browser-owned layout preferences.
- `public/model.js`, `public/sorting.js`: pure playlist operations.
- `src/editor.js`: snapshot validation, in-memory jobs, preflight/write/verify.
- `src/auth.js`, `src/youtube.js`: cookie parsing and YouTube adapter.
- `src/server.js`: HTTP routes and security boundaries.
- `tests/`: Node test runner; fake clients and HTTP servers only.
- `scripts/ui-fixture.mjs`: isolated, in-memory UI demo.

## Changes and tests

1. Keep local interactions local. Never fetch metadata on every selection/edit.
2. Use unique playlist entry IDs, not video IDs, to distinguish duplicates.
3. Preserve add-and-verify-before-remove for transfers; never auto-retry writes.
4. Save intent before HTTP submission. Treat unknown outcomes as uncertain,
   never as rollback. A worker restart must not replay an old intent.
5. Never log request bodies, raw upstream errors or credentials. Render user/
   upstream strings as text, not HTML. Backups must whitelist safe fields.
6. Add a regression test. Run `npm run format`, `npm run check`, and
   `npm run format:check`; also build the Docker image for runtime changes.
7. In the demo, check drag/drop within/across panes (including duplicate tracks,
   filtered insertion and read-only sources), resizing/minimizing, individual reverts,
   undo/redo after reload, a second tab,
   narrow-screen layout, and interrupted-commit recovery. Do not test writes on
   a real account unless the account owner has specifically authorized them.

## Before publishing this repository

Review `git status --short` and the exact staged diff. The ignore files exclude
known credential exports and workspace backups, but cannot detect every secret.
Do not add a whole browser profile or Docker volume. Scan repository history if
it has previously contained credentials; deleting a working-tree file does not
erase history. Enable private vulnerability reporting on GitHub. Run the checks
and Docker build locally; GitHub Actions and release publishing are not automated.
