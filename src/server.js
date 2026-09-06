import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';

import { config } from './config.js';
import { AuthenticationRequiredError, connectCookies } from './auth.js';
import { YouTubeApiError } from './youtube.js';
import { mountEditorRoutes } from './editor.js';

const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

export function parsePlaylistId(value) {
  if (typeof value !== 'string' || !value.trim()) throw new InputError('Choose a playlist.');
  const trimmed = value.trim();
  if (!trimmed.includes('://')) {
    if (!/^[A-Za-z0-9_-]{2,128}$/u.test(trimmed)) throw new InputError('Invalid playlist ID.');
    return trimmed;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InputError('Invalid playlist URL.');
  }
  const hosts = new Set([
    'youtube.com',
    'www.youtube.com',
    'music.youtube.com',
    'm.youtube.com',
    'youtu.be',
  ]);
  if (!hosts.has(parsed.hostname)) throw new InputError('Expected a YouTube playlist URL.');
  const playlistId = parsed.searchParams.get('list');
  if (!playlistId || !/^[A-Za-z0-9_-]{2,128}$/u.test(playlistId)) {
    throw new InputError("The URL has no valid 'list' parameter.");
  }
  return playlistId;
}

function requireJson(request, response, next) {
  if (!request.is('application/json')) {
    response.status(415).json({ error: 'This endpoint requires application/json.' });
    return;
  }
  next();
}

export function createApp({ editorClientFactory, instanceId, demo = false } = {}) {
  const app = express();
  const base = new URL(config.baseUrl);
  const allowedHosts = new Set([
    base.host,
    `localhost:${config.port}`,
    `127.0.0.1:${config.port}`,
    `[::1]:${config.port}`,
  ]);
  const allowedOrigins = new Set([
    base.origin,
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`,
  ]);
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    if (!allowedHosts.has(request.headers.host)) {
      response.status(421).type('text/plain').send('Unexpected Host header.');
      return;
    }
    const origin = request.headers.origin;
    if (request.path.startsWith('/api/') && request.get('Sec-Fetch-Site') === 'cross-site') {
      response.status(403).json({ error: 'Cross-site request blocked.' });
      return;
    }
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      origin &&
      !allowedOrigins.has(origin)
    ) {
      response.status(403).json({ error: 'Cross-origin request blocked.' });
      return;
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (request.path.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '8mb', type: 'application/json' }));
  app.use(express.static(publicDirectory, { index: 'index.html' }));

  app.get('/health', (request, response) => response.json({ ok: true }));

  app.post('/api/connect', requireJson, async (request, response) => {
    if (app.locals.worker.busy)
      return response.status(409).json({ error: 'Wait for the current commit to finish.' });
    if (demo) return response.json({ connected: true, identity: { name: 'Demo operator' } });
    const result = await connectCookies(
      request.body?.cookies,
      request.body?.accountIndex ?? 0,
      request.body?.channelId ?? '',
    );
    response.json(result);
  });

  app.get('/api/session', (request, response) => {
    response.json({
      version: config.version,
      protocol: 2,
      instanceId: app.locals.worker.instanceId,
      stateless: true,
      demo,
      maxUpdates: config.maxUpdates,
      writeDelayMs: config.writeDelayMs,
    });
  });

  mountEditorRoutes(app, {
    requireJson,
    parsePlaylistId,
    clientFactory: editorClientFactory,
    instanceId,
  });

  app.use('/api', (request, response) => response.status(404).json({ error: 'Not found.' }));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      return response.status(400).json({ error: 'Invalid or oversized JSON request.' });
    }
    // Third-party and JSON parser errors may contain submitted credentials.
    console.error('Request failed:', error.name);
    const status =
      error instanceof AuthenticationRequiredError
        ? 401
        : error instanceof InputError
          ? 400
          : error instanceof YouTubeApiError
            ? 409
            : 500;
    const message =
      status === 500
        ? 'The app could not complete that request. Check the container logs.'
        : error.message;
    if (request.path.startsWith('/api/')) return response.status(status).json({ error: message });
    return response.status(status).type('text/plain').send(message);
  });
  return app;
}
