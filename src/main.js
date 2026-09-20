import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ThreadStore } from './store.js';
import { createThreadroomServer } from './server.js';
import { createWebsiteHandler } from './site.js';

const port = Number(process.env.PORT || 4310);
const host = process.env.HOST || '127.0.0.1';
const database = resolve(process.env.THREADROOM_DB || 'data/threadroom.sqlite');
const store = new ThreadStore(database);
if (process.env.THREADROOM_SEED_DEMO !== '0') store.seedDemo();

const allowedOrigins = (process.env.THREADROOM_UI_ORIGINS || 'http://127.0.0.1:4311,http://localhost:4311').split(',').map((origin) => origin.trim()).filter(Boolean);
const websiteHandler = process.env.THREADROOM_SERVE_UI === '0' ? null : createWebsiteHandler();
const server = createThreadroomServer(store, {
  allowedOrigins, websiteHandler,
  runtimeIdentity: { storageId: createHash('sha256').update(database).digest('hex').slice(0, 24) }
});
server.listen(port, host, () => {
  console.log(`Threadroom ${process.env.THREADROOM_SERVE_UI === '0' ? 'API' : 'API + optional website'} is ready at http://${host}:${server.address().port}`);
  console.log(`Durable records: ${database}`);
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // Live subscribers/waiters do not own service lifetime or the durable question.
  server.closeAllConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
