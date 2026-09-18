import { createServer } from 'node:http';
import { createWebsiteHandler } from './site.js';

const port = Number(process.env.UI_PORT || 4311);
const apiBaseUrl = process.env.THREADROOM_API_URL || 'http://127.0.0.1:4310';
const website = createWebsiteHandler({ apiBaseUrl });
const server = createServer((request, response) => {
  website(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end('Website error');
  });
});
server.listen(port, '127.0.0.1', () => console.log(`Independent Threadroom UI: http://127.0.0.1:${server.address().port} · API: ${apiBaseUrl}`));
