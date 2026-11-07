// server/index.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { fetchHeroes } = require('./dota-api');
const { rooms, createRoom, startNewGame, handleAction, scheduleRoomCleanup, cancelRoomCleanup } = require('./room-manager');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const VALID_ROLES = ['captain', 'spectator'];
const MAX_NAME_LENGTH = 32;

app.post('/api/rooms', async (req, res) => {
  try {
    const heroes = await fetchHeroes();
    const room = createRoom(heroes);
    room.broadcastState = () => broadcastState(room);
    scheduleRoomCleanup(room); // если в комнату так никто и не зайдёт
    console.log(`🏠 Создана комната: ${room.id}`);
    res.json({ roomId: room.id });
  } catch (err) {
    console.error('Ошибка создания комнаты:', err.message);
    res.status(502).json({ error: 'Не удалось загрузить список героев' });
  }
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(String(req.params.id).toUpperCase());
  if (!room) return res.status(404).json({ error: 'Не найдена' });
  res.json({
    id: room.id,
    players: room.players,
    series: room.series,
    current: room.current
  });
});

function broadcastState(room) {
  io.to(room.id).emit('state', {
    players: room.players,
    series: room.series,
    current: room.current
  });
}

function isCaptain(player) {
  return player && player.role === 'captain';
}

// Payload от клиента может быть чем угодно (null, строка, число) — приводим к объекту
const asObject = (payload) => (payload && typeof payload === 'object' ? payload : {});

io.on('connection', (socket) => {
  let currentRoom = null;

  // Исключение в обработчике не должно ронять весь сервер
  const on = (event, handler) => {
    socket.on(event, (...args) => {
      try {
        handler(...args);
      } catch (err) {
        console.error(`Ошибка в обработчике "${event}":`, err);
        socket.emit('error', { msg: 'Внутренняя ошибка сервера' });
      }
    });
  };

  const leaveCurrentRoom = () => {
    if (!currentRoom) return;
    const room = currentRoom;
    currentRoom = null;
    socket.leave(room.id);

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    // Капитан, уже занявший сторону, остаётся в комнате "оффлайн",
    // чтобы после перезагрузки страницы вернуться на своё место.
    if (isCaptain(player) && player.team !== null && player.clientId) {
      player.online = false;
    } else {
      room.players = room.players.filter(p => p !== player);
    }

    if (!room.players.some(p => p.online)) scheduleRoomCleanup(room);
    room.broadcastState();
  };

  on('join', (payload) => {
    const { roomId, playerName, role, clientId } = asObject(payload);
    const room = rooms.get(String(roomId || '').toUpperCase());
    if (!room) return socket.emit('error', { msg: 'Комната не найдена' });

    if (currentRoom && currentRoom !== room) leaveCurrentRoom();

    const name = String(playerName || '').trim().slice(0, MAX_NAME_LENGTH) || 'Игрок';
    const safeRole = VALID_ROLES.includes(role) ? role : 'spectator';
    const safeClientId = typeof clientId === 'string' && clientId ? clientId : null;

    let player = room.players.find(p => p.id === socket.id);
    if (!player && safeClientId) {
      // Переподключение того же клиента (перезагрузка страницы / обрыв связи)
      player = room.players.find(p => p.clientId === safeClientId);
      if (player) {
        player.id = socket.id;
        player.name = name;
        player.online = true;
      }
    }
    if (!player) {
      player = { id: socket.id, clientId: safeClientId, name, role: safeRole, team: null, online: true };
      room.players.push(player);
    }

    currentRoom = room;
    socket.join(room.id);
    cancelRoomCleanup(room);
    room.broadcastState();
  });

  on('assignTeam', (payload) => {
    const { team } = asObject(payload);
    if (!currentRoom) return;
    if (team !== 0 && team !== 1) return;
    const player = currentRoom.players.find(p => p.id === socket.id);
    if (!isCaptain(player)) return;
    if (currentRoom.current && !currentRoom.current.finished) {
      return socket.emit('error', { msg: 'Нельзя менять команду во время драфта' });
    }
    const taken = currentRoom.players.some(p => isCaptain(p) && p.team === team && p.id !== socket.id);
    if (taken) return socket.emit('error', { msg: 'Команда уже занята другим капитаном' });
    player.team = team;
    currentRoom.broadcastState();
  });

  on('startGame', () => {
    if (!currentRoom) return;
    const player = currentRoom.players.find(p => p.id === socket.id);
    if (!isCaptain(player)) return socket.emit('error', { msg: 'Только капитан может начать драфт' });
    if (currentRoom.current) return socket.emit('error', { msg: 'Драфт уже начат' });
    const hasRadiant = currentRoom.players.some(p => isCaptain(p) && p.team === 0);
    const hasDire = currentRoom.players.some(p => isCaptain(p) && p.team === 1);
    if (!hasRadiant || !hasDire) return socket.emit('error', { msg: 'Нужно 2 капитана, занявших Radiant и Dire' });
    startNewGame(currentRoom);
    currentRoom.broadcastState();
  });

  on('nextGame', () => {
    if (!currentRoom) return;
    const player = currentRoom.players.find(p => p.id === socket.id);
    if (!isCaptain(player)) return;
    if (!currentRoom.current?.finished) return;
    if (currentRoom.series.currentGame >= currentRoom.series.totalGames) {
      return socket.emit('error', { msg: 'Серия завершена!' });
    }
    startNewGame(currentRoom);
    currentRoom.broadcastState();
  });

  on('draftAction', (payload) => {
    const { heroId, actionType } = asObject(payload);
    if (!currentRoom) return;
    const result = handleAction(currentRoom, socket.id, heroId, actionType);
    if (result.error) return socket.emit('error', { msg: result.error });
    currentRoom.broadcastState();
  });

  on('disconnect', leaveCurrentRoom);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на http://0.0.0.0:${PORT}`);
  fetchHeroes().catch(err => console.error('Ошибка загрузки героев:', err.message));
});
