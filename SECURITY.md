# Security

ytmsorter is a personal, localhost-only tool. It is not a hosted service, an authentication gateway,
or a multi-user application. Do not expose port 3000 to the internet or a shared LAN. A workspace
token scopes receipts; it is not a replacement for server authentication.

## Session credentials

YouTube cookies are bearer credentials. Anyone with them may be able to act as your account. Never
put cookies, Authorization headers, browser exports, HAR files, private playlist backups, or OAuth
credentials in issues or pull requests.

The browser stores remembered cookies in IndexedDB. Tab-only credentials use sessionStorage. Neither
is encrypted by this application: browser extensions, malicious same-origin code, and anyone with
access to the browser profile are part of the threat model. Clearing site data removes browser
records; normal browser eviction/private-mode policies can also remove them. Workspace exports omit
credentials but still contain private playlist metadata.

The worker receives cookies with explicit read/commit requests and keeps them only in memory. It
does not persist cookies, request bodies, or account data. Do not enable request-body logging in a
proxy. Disconnect forgets this app's credentials; it does not revoke the upstream Google session. If
cookies leak, use Google's account security controls to review and revoke affected sessions.

## Local edits and explicit saves

Sorting, searching, selection, dragging, duplicate removal, and Undo/Redo edit browser-local drafts.
These actions do not submit YouTube writes. **Remove duplicates** matches exact video IDs and stages
removal of extra playlist entries; it does not delete videos or change liked-song status. Read-only
playlists remain copy sources rather than editable destinations.

**Review & save** displays the proposed changes. The user must check the confirmation box and choose
**Save changes to YouTube** before the app submits a commit. Browser autosave preserves a draft; it
is separate from saving changes to YouTube. All committed edits still pass live permission and
snapshot checks.

## Defensive boundaries

- Localhost port binding; non-root, read-only Docker runtime; no data volume.
- Host/Origin and cross-site request checks; JSON-only mutation endpoints.
- Self-hosted assets, restrictive CSP, no analytics or third-party fonts.
- Credentials excluded from receipts, workspace backups, and application logs.
- Browser intents saved before submission; no automatic write retries or replay.
- Live permission, ownership, item-ID and order checks before edits.

YouTube's internal API is unofficial. Pacing does not guarantee account safety. Commits are not
atomic, and a failed request can still have changed YouTube. Avoid concurrent edits from another
browser, device, or running app instance.

## Reporting a vulnerability

If this repository has GitHub private vulnerability reporting enabled, use its Security → Report a
vulnerability form. Otherwise, open an issue asking for a private reporting channel without
disclosing exploit details or credentials. Use only synthetic accounts/data in reproductions. The
current release line is 1.x; fixes target the latest release. There is no guaranteed response SLA.
