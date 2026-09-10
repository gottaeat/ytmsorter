// Optional browser regression: fake playlists only, isolated profile, no real cookies.
// PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE can point to existing local installs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://localhost:3005';
const server = spawn(process.execPath, ['scripts/ui-fixture.mjs'], {
  env: { ...process.env, PORT: '3005', BASE_URL: base },
  stdio: 'pipe',
});
let browser;
try {
  let ready = false;
  server.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('Disposable fixture UI ready')) ready = true;
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('Demo server failed to start; check port 3005.');
    try {
      if (ready && (await fetch(base + '/health')).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!ready) throw new Error('The isolated demo server did not become ready.');
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByRole('button', { name: 'Fetch', exact: true }).click();
  await page.locator('#library-list button').filter({ hasText: 'Workshop rotation' }).click();
  await page.locator('#library-list button').filter({ hasText: 'Night shift archive' }).click();
  const source = page.locator('[data-playlist-id="PLworkshop"]');
  const dest = page.locator('[data-playlist-id="PLarchive"]');
  const ids = (pane) =>
    pane.locator('tbody tr').evaluateAll((rows) => rows.map((row) => row.dataset.itemId));
  const drag = async (from, to, bottom = false) => {
    const a = await from.boundingBox(),
      b = await to.boundingBox();
    assert.ok(a && b);
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + (bottom ? b.height - 2 : 2), { steps: 20 });
    await page.mouse.up();
  };
  const original = await ids(source);
  await drag(
    source.locator('tbody tr').first().locator('.drag-grip'),
    dest.locator('tbody tr').nth(1),
  );
  assert.equal((await ids(source)).length, 11);
  assert.equal((await ids(dest)).length, 4);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.deepEqual(await ids(source), original);
  assert.equal((await ids(dest)).length, 3);
  // Drag by the track title, not only the grip; it must not navigate.
  await drag(source.locator('tbody tr').nth(2).locator('a'), source.locator('tbody tr').first());
  assert.equal((await ids(source))[0], original[2]);
  await page.locator('#drop-mode').selectOption('copy');
  await drag(
    source.locator('tbody tr').first().locator('.drag-grip'),
    dest.locator('.pane-drop-hint'),
  );
  assert.equal((await ids(source)).length, 12);
  assert.equal((await ids(dest)).length, 4);
  assert.equal(await page.locator('#request-count').textContent(), '4 local requests');
  assert.equal(page.context().pages().length, 1, 'dragging a linked title must not open the video');
  await source.locator('tbody tr').first().locator('input').check();
  await source.locator('tbody tr').nth(1).locator('input').check();
  await drag(
    source.locator('tbody tr').first().locator('.drag-grip'),
    dest.locator('.pane-drop-hint'),
  );
  assert.equal((await ids(dest)).length, 6, 'selected songs drag together');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal((await ids(dest)).length, 4);
  const desired = await ids(source);
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export workspace', exact: true }).click();
  const backup = JSON.parse(await readFile(await (await saved).path(), 'utf8'));
  for (const draft of Object.values(backup.workspace.drafts)) draft.stale = true;
  const importLegacy = async () => {
    page.once('dialog', (dialog) => dialog.accept());
    await page
      .locator('#import-file')
      .setInputFiles({
        name: 'legacy.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(backup)),
      });
    await page.waitForFunction(() => document.getElementById('review').disabled);
  };
  await importLegacy();
  await page.getByRole('button', { name: 'Session', exact: true }).click();
  await page.locator('#cookies').fill('DEMO-ONLY-NOT-REAL-COOKIES');
  await page.getByRole('button', { name: 'Connect / replace cookies', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('review').disabled);
  await page.locator('#loaded-list button').filter({ hasText: 'Workshop rotation' }).click();
  assert.deepEqual(
    await ids(source),
    desired,
    'replacing cookies automatically recovers blocked edits',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#import-file').setInputFiles({
    name: 'legacy.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await page.getByRole('button', { name: 'Reconnect & keep edits', exact: true }).click();
  await page.waitForFunction(() =>
    document.getElementById('status').textContent.includes('Recovered 2 drafts'),
  );
  await page.locator('#loaded-list button').filter({ hasText: 'Workshop rotation' }).click();
  assert.deepEqual(await ids(source), desired);
  assert.equal(await page.locator('#review').isEnabled(), true);
  await page.reload();
  await page.waitForFunction(
    () => document.getElementById('save-state').textContent === 'SAVED IN BROWSER',
  );
  assert.equal(await page.locator('.playlist-pane').count(), 0);
  await page.locator('#loaded-list button').filter({ hasText: 'Workshop rotation' }).click();
  assert.deepEqual(await ids(source), desired);
  await page.locator('#loaded-list button').filter({ hasText: 'Night shift archive' }).click();
  await page.waitForFunction(
    () => document.getElementById('save-state').textContent === 'SAVED IN BROWSER',
  );
  if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT });
  assert.deepEqual(errors, []);
  console.log(
    'Browser smoke passed: cross-pane move/copy, title reorder, undo, legacy draft recovery, persistence; no YouTube calls.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  if (server.exitCode === null) await once(server, 'exit');
}
