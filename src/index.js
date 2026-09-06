import { config } from './config.js';
import { createApp } from './server.js';

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  console.log(`ytmsorter is listening at ${config.baseUrl}`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received; closing the HTTP server`);
  const deadline = setTimeout(() => process.exit(1), 40000);
  deadline.unref();
  await app.locals.worker.stop();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
