// Static file server for /site, using only Node's built-in modules.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const SITE_DIR = path.join(__dirname, 'site');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/login.html';

  // Resolve inside SITE_DIR only, so ".." cannot escape the folder.
  const filePath = path.join(SITE_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(SITE_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const type = CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
    // No caching, so hand edits to the HTML take effect immediately.
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Site server running at http://localhost:${PORT}`);
});
