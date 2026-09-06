function integerFromEnvironment(name, fallback, minimum = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be at least ${minimum}`);
  }
  return value;
}

const port = integerFromEnvironment('PORT', 3000, 1);
if (port > 65535) throw new Error('PORT must be between 1 and 65535');
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const parsedBaseUrl = new URL(baseUrl);
if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
  throw new Error('BASE_URL must use http or https');
}
if (
  parsedBaseUrl.pathname !== '/' ||
  parsedBaseUrl.search ||
  parsedBaseUrl.hash ||
  parsedBaseUrl.username ||
  parsedBaseUrl.password
) {
  throw new Error('BASE_URL must not contain a path, query, or fragment');
}

export const config = Object.freeze({
  host: process.env.HOST || '127.0.0.1',
  port,
  baseUrl,
  version: '1.0.0',
  maxJobs: integerFromEnvironment('MAX_JOBS', 500, 1),
  maxUpdates: integerFromEnvironment('MAX_UPDATES', 180),
  writeDelayMs: integerFromEnvironment('WRITE_DELAY_MS', 1000, 1000),
});
