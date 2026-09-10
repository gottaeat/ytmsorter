import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { AuthenticationRequiredError } from '../src/auth.js';

async function fixture(t, failure = {}) {
  let reads = 0;
  let writes = 0;
  let items = [{ itemId: 'a', videoId: 'abcdefghijk', title: 'A' }];
  const info = { id: 'PLtest', title: 'Test', channelId: 'owner', editable: true };
  const client = {
    async playlistSnapshot() {
      reads++;
      if (failure.expired) throw new AuthenticationRequiredError('Session expired');
      return structuredClone({ info, items });
    },
    async playlistItems() {
      reads++;
      return structuredClone(items);
    },
    async removeItem() {
      if (failure.write) throw new AuthenticationRequiredError('Session expired during write');
      writes++;
      items = [];
    },
  };
  const app = createApp({ editorClientFactory: async () => client });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await app.locals.worker.stop();
    await new Promise((resolve) => server.close(resolve));
  });
  const owner = randomUUID();
  const instanceId = app.locals.worker.instanceId;
  const request = (url, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path: url,
          method: body ? 'POST' : 'GET',
          headers: {
            Host: 'localhost:3000',
            'Content-Type': 'application/json',
            'X-Workspace-Token': owner,
            'X-Worker-Instance': instanceId,
            ...headers,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (data) => {
            text += data;
          });
          res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
        },
      );
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  const loaded = (await request('/api/snapshots', { playlist: 'PLtest' })).data;
  const body = {
    commitId: randomUUID(),
    instanceId,
    drafts: [{ snapshotId: loaded.snapshotId, snapshot: loaded, items: [] }],
  };
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      const job = (await request(`/api/jobs/${body.commitId}`)).data;
      if (job.status !== 'running') return job;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Job timed out');
  };
  return {
    request,
    body,
    wait,
    app,
    get reads() {
      return reads;
    },
    get writes() {
      return writes;
    },
  };
}

test('expired preflight preserves the snapshot for an explicit new commit; old job IDs never replay', async (t) => {
  const failure = {};
  const f = await fixture(t, failure);
  failure.expired = true;
  await f.request('/api/commits', f.body);
  const job = await f.wait();
  assert.equal(job.safeToRetry, true);
  assert.equal(job.authRequired, true);
  assert.equal(job.submittedWrites, 0);
  assert.equal(f.writes, 0);
  failure.expired = false;
  await f.request('/api/commits', f.body);
  assert.equal(f.writes, 0, 'same job ID stays a receipt, never a retry');
  f.body.commitId = randomUUID();
  assert.equal((await f.request('/api/commits', f.body)).status, 202);
  assert.equal((await f.wait()).status, 'succeeded');
  assert.equal(f.writes, 1);
});

test('zero confirmed writes is not safe to retry when a write was submitted', async (t) => {
  const f = await fixture(t, { write: true });
  await f.request('/api/commits', f.body);
  const job = await f.wait();
  assert.equal(job.writes, 0);
  assert.equal(job.submittedWrites, 1);
  assert.equal(job.safeToRetry, false);
  assert.equal(
    (await f.request('/api/commits', { ...f.body, commitId: randomUUID() })).status,
    409,
  );
});

test('stateless snapshot → commit; same-instance retries never replay writes', async (t) => {
  const f = await fixture(t);
  assert.equal(f.reads, 1);
  assert.equal(f.writes, 0);
  assert.equal((await f.request('/api/commits', f.body)).status, 202);
  assert.equal((await f.wait()).status, 'succeeded');
  assert.equal(f.writes, 1);
  const readCount = f.reads;
  await f.request(`/api/jobs/${f.body.commitId}`);
  assert.equal(f.reads, readCount, 'progress does not call YouTube');
  assert.equal((await f.request('/api/commits', f.body)).status, 200);
  assert.equal(
    (await f.request('/api/commits', { ...f.body, commitId: randomUUID() })).status,
    409,
  );
  assert.equal(f.writes, 1);
});

test('worker identity survives only in memory; restart never accepts an old commit', async (t) => {
  const old = await fixture(t);
  const fresh = await fixture(t);
  assert.notEqual(old.body.instanceId, fresh.body.instanceId);
  const response = await fresh.request('/api/commits', old.body);
  assert.equal(response.status, 410);
  assert.equal(response.data.code, 'WORKER_RESTARTED');
  const tracked = await fresh.request(`/api/jobs/${old.body.commitId}`, undefined, {
    'X-Worker-Instance': old.body.instanceId,
  });
  assert.equal(tracked.status, 410);
  assert.equal(fresh.writes, 0);
});

test('jobs are scoped to the browser workspace token', async (t) => {
  const f = await fixture(t);
  await f.request('/api/commits', f.body);
  await f.wait();
  const other = { 'X-Workspace-Token': randomUUID() };
  assert.equal((await f.request(`/api/jobs/${f.body.commitId}`, undefined, other)).status, 404);
  assert.equal((await f.request('/api/commits', f.body, other)).status, 409);
  assert.equal((await f.request('/api/commits', f.body, { 'X-Workspace-Token': '' })).status, 409);
});

test('browser-supplied snapshots are revalidated against live data before writes', async (t) => {
  const f = await fixture(t);
  f.body.drafts[0].snapshot.items[0].videoId = '12345678901';
  assert.equal((await f.request('/api/commits', f.body)).status, 202);
  const job = await f.wait();
  assert.equal(job.status, 'failed');
  assert.match(job.error, /changed since loading/u);
  assert.equal(f.writes, 0);
});

test('invalid snapshots and cross-site API requests fail without writes', async (t) => {
  const f = await fixture(t);
  f.body.drafts[0].snapshot.items.push(f.body.drafts[0].snapshot.items[0]);
  assert.equal((await f.request('/api/commits', f.body)).status, 409);
  assert.equal(
    (await f.request('/api/library', {}, { 'Sec-Fetch-Site': 'cross-site' })).status,
    403,
  );
  assert.equal(f.writes, 0);
});

test('session endpoint contains worker metadata, not account or cookie state', async (t) => {
  const f = await fixture(t);
  const { data } = await f.request('/api/session');
  assert.equal(data.stateless, true);
  assert.equal(data.protocol, 2);
  assert.equal(data.instanceId, f.body.instanceId);
  assert.equal('connected' in data, false);
  assert.equal('cookies' in data, false);
});
