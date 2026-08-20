#!/usr/bin/env node
// Stand-in for a Chromium binary in BrowserHost tests: parses
// --remote-debugging-port, serves /json/version on it, exits on SIGTERM.
import { appendFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const portArg = process.argv.find((arg) => arg.startsWith('--remote-debugging-port='));
const port = portArg ? parseInt(portArg.split('=')[1], 10) : 0;
const profileArg = process.argv.find((arg) => arg.startsWith('--user-data-dir='));
const profileDir = profileArg?.slice('--user-data-dir='.length);
if (profileDir) {
  mkdirSync(profileDir, { recursive: true });
  appendFileSync(path.join(profileDir, 'fake-chrome-launches.jsonl'), `${JSON.stringify(process.argv.slice(2))}\n`);
}

// Real Chrome forwards this request to the profile's running process and the
// short-lived launcher exits. Mirror that instead of leaking a fake server.
if (!portArg) process.exit(0);

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
