#!/usr/bin/env node
// Stand-in for a Chromium binary in BrowserHost tests: parses
// --remote-debugging-port, serves /json/version on it, exits on SIGTERM.
import http from 'node:http';

const portArg = process.argv.find((arg) => arg.startsWith('--remote-debugging-port='));
const port = portArg ? parseInt(portArg.split('=')[1], 10) : 0;

const server = http.createServer((req, res) => {
  if (req.url === '/json/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'FakeChrome/1.0' }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, '127.0.0.1');

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 200).unref();
});