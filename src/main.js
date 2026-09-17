import { resolve } from 'node:path';
import { ThreadStore } from './store.js';
import { createThreadroomServer } from './server.js';

const port = Number(process.env.PORT || 4310);
const host = process.env.HOST || '127.0.0.1';
const database = resolve(process.env.THREADROOM_DB || 'data/threadroom.sqlite');
const store = new ThreadStore(database);
store.seedDemo();

const server = createThreadroomServer(store);
server.listen(port, host, () => {
  console.log(`Threadroom is ready at http://${host}:${port}`);
  console.log(`Durable records: ${database}`);
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
