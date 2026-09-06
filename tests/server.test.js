import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { createApp, parsePlaylistId } from '../src/server.js';

test('playlist IDs are accepted from YouTube Music and normal YouTube URLs', () => {
  assert.equal(parsePlaylistId('PL123'), 'PL123');
  assert.equal(parsePlaylistId('https://music.youtube.com/playlist?list=PL123&si=x'), 'PL123');
  assert.equal(parsePlaylistId('https://www.youtube.com/watch?v=abc&list=PL123'), 'PL123');
  assert.throws(() => parsePlaylistId('https://example.com/?list=PL123'), /YouTube/u);
});

function request(server, hostHeader) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http
      .get(
        { hostname: '127.0.0.1', port, path: '/health', headers: { Host: hostHeader } },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      )
      .on('error', reject);
  });
}

test('HTTP server allows configured localhost hosts and blocks DNS rebinding hosts', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    assert.equal(await request(server, 'localhost:3000'), 200);
    assert.equal(await request(server, 'attacker.example'), 421);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('cookie submission rejects cross-origin requests and never echoes malformed cookie JSON', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const post = (body, extraHeaders = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path: '/api/connect',
          method: 'POST',
          headers: { Host: 'localhost:3000', 'Content-Type': 'application/json', ...extraHeaders },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, text }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  try {
    const blocked = await post('{}', { Origin: 'https://other.example' });
    assert.equal(blocked.status, 403);
    const malformed = await post('{"cookies":"SECRET_COOKIE_VALUE" broken}');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.text.includes('SECRET_COOKIE_VALUE'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
