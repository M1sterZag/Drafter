// server/index.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { fetchHeroes } = require('./dota-api');
const {
  rooms,
  createRoom,
  beginNextGame,
  confirmReady,
  configureSeries,
  handleSetupChoice,
  togglePause,
  handleAction,
  scheduleRoomCleanup,
  cancelRoomCleanup
} = require('./room-manager');

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

// clientId — секрет клиента: по нему сервер возвращает капитана на его место,
// поэтому наружу его отдавать нельзя (иначе любой зритель перехватит место капитана)
const publicPlayers = (room) => room.players.map(({ clientId, ...rest }) => rest);

function publicState(room) {
  return {
    players: publicPlayers(room),
    series: room.series,
    current: room.current
  };
}

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(String(req.params.id).toUpperCase());
  if (!room) return res.status(404).json({ error: 'Не найдена' });
  res.json({ id: room.id, ...publicState(room) });
});

function broadcastState(room) {
  io.to(room.id).emit('state', publicState(room));
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

    // Готовность действует только пока капитан остаётся подключённым.
    if (room.series.readyCheck && (player.squad === 0 || player.squad === 1)) {
      room.series.readyCheck.confirmedSquads = room.series.readyCheck.confirmedSquads
        .filter(squad => squad !== player.squad);
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
    if (currentRoom.current || currentRoom.series.readyCheck || currentRoom.series.selection || currentRoom.series.currentGame > 0) {
      return socket.emit('error', { msg: 'Нельзя менять команду после начала серии' });
    }
    const taken = currentRoom.players.some(p => isCaptain(p) && p.squad === team && p.id !== socket.id);
    if (taken) return socket.emit('error', { msg: 'Команда уже занята другим капитаном' });
    player.squad = team;
    player.team = team;
    currentRoom.broadcastState();
  });

  on('configureSeries', (payload) => {
    const { mode, totalGames } = asObject(payload);
    if (!currentRoom) return;
    const player = currentRoom.players.find(p => p.id === socket.id);
    if (!isCaptain(player)) return socket.emit('error', { msg: 'Настройки доступны только капитану' });
    const result = configureSeries(currentRoom, mode, Number(totalGames));
    if (result.error) return socket.emit('error', { msg: result.error });
    currentRoom.broadcastState();
  });

  on('startGame', () => {
    if (!currentRoom) return;
    const player = currentRoom.players.find(p => p.id === socket.id);
    if (!isCaptain(player)) return socket.emit('error', { msg: 'Только капитан может начать драфт' });
    if (currentRoom.current || currentRoom.series.readyCheck || currentRoom.series.selection) {
      return socket.emit('error', { msg: 'Серия уже запускается' });
    }
    const hasRadiant = currentRoom.players.some(p => isCaptain(p) && p.squad === 0);
    const hasDire = currentRoom.players.some(p => isCaptain(p) && p.squad === 1);
    if (!hasRadiant || !hasDire) return socket.emit('error', { msg: 'Нужно 2 капитана, занявших Radiant и Dire' });
    beginNextGame(currentRoom);
    currentRoom.broadcastState();
  });

  on('confirmReady', () => {
    if (!currentRoom) return;
    const result = confirmReady(currentRoom, socket.id);
    if (result.error) return socket.emit('error', { msg: result.error });
    currentRoom.broadcastState();
  });

  on('setupChoice', (payload) => {
    const { category, value } = asObject(payload);
    if (!currentRoom) return;
    const result = handleSetupChoice(currentRoom, socket.id, category, value);
    if (result.error) return socket.emit('error', { msg: result.error });
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
    beginNextGame(currentRoom);
    currentRoom.broadcastState();
  });

  on('draftAction', (payload) => {
    const { heroId, actionType } = asObject(payload);
    if (!currentRoom) return;
    const result = handleAction(currentRoom, socket.id, heroId, actionType);
    if (result.error) return socket.emit('error', { msg: result.error });
    currentRoom.broadcastState();
  });

  on('togglePause', () => {
    if (!currentRoom) return;
    const result = togglePause(currentRoom, socket.id);
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
