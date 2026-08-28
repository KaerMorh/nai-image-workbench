import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const host = '127.0.0.1';
const port = 8765;
const root = new URL('../', import.meta.url);
const routes = new Map([
  ['/nai-image-workbench.dev.user.js', new URL('nai-image-workbench.dev.user.js', root)],
  ['/nai-image-workbench.user.js', new URL('nai-image-workbench.user.js', root)],
  ['/version.json', new URL('version.json', root)],
]);

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', `http://${host}:${port}`).pathname;
  const file = routes.get(pathname);
  if (!file) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  try {
    const source = await readFile(file);
    response.writeHead(200, {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Type': pathname.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8',
    });
    response.end(source);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(String(error?.message || error));
  }
});

server.listen(port, host, () => {
  console.log(`NAI Image Workbench dev server: http://${host}:${port}/nai-image-workbench.dev.user.js`);
});
