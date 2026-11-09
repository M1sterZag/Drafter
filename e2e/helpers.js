// e2e/helpers.js — общая инфраструктура e2e-тестов:
// мок OpenDota API, запуск backend в отдельном процессе, socket.io-клиенты.
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const ATTRS = ['str', 'agi', 'int', 'all'];
const HEROES_PER_ATTR = 25;

// 100 героев (25 на атрибут; 'all' — старое обозначение универсалов в OpenDota)
// + мусорная запись, которую сервер обязан отфильтровать.
function buildMockHeroes() {
  const heroes = [];
  let id = 1;
  for (const attr of ATTRS) {
    for (let i = 1; i <= HEROES_PER_ATTR; i++) {
      heroes.push({
        id: id++,
        name: `npc_dota_hero_${attr}_${i}`,
        localized_name: `${attr.toUpperCase()} Hero ${i}`,
        primary_attr: attr,
        attack_type: i % 2 ? 'Melee' : 'Ranged'
      });
    }
  }
  heroes.push({ id: 9999, name: 'not_a_hero', localized_name: 'Junk', primary_attr: 'str' });
  return heroes;
}

function startMockHeroesApi() {
  const heroes = buildMockHeroes();
  const server = http.createServer((req, res) => {
    if (req.url === '/api/heroes') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(heroes));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/api/heroes`, close: () => new Promise(r => server.close(r)) });
    });
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Запускает server/index.js с заданными env и ждёт, пока он начнёт слушать порт
async function startBackend(env = {}, { port } = {}) {
  port = port || await getFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', d => { logs += d; });
  child.stderr.on('data', d => { logs += d; });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Backend не стартовал:\n${logs}`)), 10000);
    const check = () => {
      if (logs.includes('Сервер запущен')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', check);
    child.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Backend завершился с кодом ${code}:\n${logs}`));
    });
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    logs: () => logs,
    alive: () => child.exitCode === null,
    stop: () => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGTERM');
    })
  };
}

async function createRoom(baseUrl) {
  const res = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(`POST /api/rooms -> ${res.status}: ${JSON.stringify(body)}`);
  return body.roomId;
}

// Тестовый клиент: хранит последнее состояние и ошибки, умеет ждать условие
class Client {
  constructor(baseUrl) {
    this.socket = io(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
    this.state = null;
    this.errors = [];
    this.waiters = [];
    this.socket.on('state', s => { this.state = s; this._flush(); });
    this.socket.on('error', e => { this.errors.push(e?.msg); this._flush(); });
  }

  static async connect(baseUrl) {
    const c = new Client(baseUrl);
    await new Promise((resolve, reject) => {
      c.socket.once('connect', resolve);
      c.socket.once('connect_error', reject);
    });
    return c;
  }

  get id() { return this.socket.id; }
  get me() { return this.state?.players.find(p => p.id === this.socket.id); }

  emit(event, payload) { this.socket.emit(event, payload); }

  _flush() {
    this.waiters = this.waiters.filter(w => {
      if (w.predicate()) { clearTimeout(w.timer); w.resolve(); return false; }
      return true;
    });
  }

  waitFor(predicate, label = 'condition', timeout = 3000) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(x => x !== w);
        reject(new Error(`Timeout waiting for: ${label}. Last errors: ${JSON.stringify(this.errors.slice(-3))}`));
      }, timeout);
      this.waiters.push(w);
    });
  }

  waitState(predicate, label) {
    return this.waitFor(() => this.state && predicate(this.state), label);
  }

  // Ждёт новую ошибку после вызова fn и возвращает её текст
  async expectError(fn, timeout = 2000) {
    const before = this.errors.length;
    fn();
    await this.waitFor(() => this.errors.length > before, 'error event', timeout);
    return this.errors[this.errors.length - 1];
  }

  async join(roomId, playerName, role, clientId) {
    this.emit('join', { roomId, playerName, role, clientId });
    await this.waitState(s => s.players.some(p => p.id === this.socket.id), `join ${playerName}`);
  }

  close() { this.socket.disconnect(); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { buildMockHeroes, startMockHeroesApi, startBackend, createRoom, Client, sleep, HEROES_PER_ATTR, getFreePort };
