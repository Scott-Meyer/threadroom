import { resolve } from 'node:path';
import { ThreadStore } from './store.js';
import { createThreadroomServer } from './server.js';
import { createWebsiteHandler } from './site.js';

const port = Number(process.env.PORT || 4310);
const host = process.env.HOST || '127.0.0.1';
const database = resolve(process.env.THREADROOM_DB || 'data/threadroom.sqlite');
const store = new ThreadStore(database);
store.seedDemo();

const allowedOrigins = (process.env.THREADROOM_UI_ORIGINS || 'http://127.0.0.1:4311,http://localhost:4311').split(',').map((origin) => origin.trim()).filter(Boolean);
const server = createThreadroomServer(store, {
  allowedOrigins,
  websiteHandler: process.env.THREADROOM_SERVE_UI === '0' ? null : createWebsiteHandler()
});
server.listen(port, host, () => {
  console.log(`Threadroom ${process.env.THREADROOM_SERVE_UI === '0' ? 'API' : 'API + optional website'} is ready at http://${host}:${port}`);
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
