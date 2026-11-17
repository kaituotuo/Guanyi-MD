import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const files = {
  '/': ['current.html', 'text/html; charset=utf-8'],
  '/current.html': ['current.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/prototype.css': ['prototype.css', 'text/css; charset=utf-8'],
  '/prototype.js': ['prototype.js', 'text/javascript; charset=utf-8'],
  '/design-system-v1.css': ['design-system-v1.css', 'text/css; charset=utf-8'],
  '/design-system-v1.js': ['design-system-v1.js', 'text/javascript; charset=utf-8'],
  '/PRD.md': ['PRD.md', 'text/plain; charset=utf-8']
};
const port = Number(process.env.GUANYI_PROTOTYPE_PORT || 9938);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid prototype port');
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (!['GET', 'HEAD'].includes(request.method) || !files[pathname]) { response.writeHead(404).end('Not found'); return; }
  const [name, type] = files[pathname];
  try {
    const body = await readFile(new URL(name, import.meta.url));
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(500).end('Prototype file unavailable'); }
});
server.on('error', error => { console.error(`Prototype preview: ${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`PDF study prototype: http://127.0.0.1:${port}`));
