// e2e/mock-heroes-server.js — мок OpenDota API для браузерных e2e (порт из MOCK_PORT)
const http = require('http');
const { buildMockHeroes } = require('./helpers');

const heroes = JSON.stringify(buildMockHeroes());
const port = Number(process.env.MOCK_PORT) || 4599;
http.createServer((req, res) => {
  if (req.url === '/api/heroes') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(heroes);
  }
  res.writeHead(200);
  res.end('ok');
}).listen(port, '127.0.0.1', () => console.log(`mock heroes on ${port}`));
