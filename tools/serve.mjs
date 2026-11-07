/**
 * Tiny dependency-free static file server for the built game.
 * Browsers block textures loaded from file:// pages, so the game must be served over http.
 *
 *   node tools/serve.mjs [--dir dist] [--port 8080] [--open]
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.exr': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/** Starts a server; resolves with {server, url}. Tries the next port if one is taken. */
export function serve(dir = 'dist', port = 8080) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(root, urlPath);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      server.once('error', (e) => (e.code === 'EADDRINUSE' && p < port + 20 ? tryPort(p + 1) : reject(e)));
      server.listen(p, '127.0.0.1', () => resolve({ server, url: `http://localhost:${p}/` }));
    };
    tryPort(port);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const dir = opt('--dir', 'dist');
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    console.error(`${dir}/index.html not found — run "npm run build" first.`);
    process.exit(1);
  }
  const { url } = await serve(dir, Number(opt('--port', 8080)));
  console.log(`Frankfurt: Open Roads is running at ${url}  (Ctrl+C to stop)`);
  if (a.includes('--open')) exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`);
}
