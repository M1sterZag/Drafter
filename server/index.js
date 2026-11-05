// server/index.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { fetchHeroes } = require('./dota-api');
const { rooms, createRoom, startNewGame, handleAction } = require('./room-manager');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

let ALL_HEROES = [];

app.post('/api/rooms', async (req, res) => {
  if (!ALL_HEROES.length) ALL_HEROES = await fetchHeroes();
  const room = createRoom(ALL_HEROES);
  console.log(`🏠 Создана комната: ${room.id}`);
  res.json({ roomId: room.id });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
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

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join', ({ roomId, playerName, role }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', { msg: 'Комната не найдена' });

    let player = room.players.find(p => p.id === socket.id);
    if (!player) {
      player = { id: socket.id, name: playerName, role: role || 'spectator', team: null };
      room.players.push(player);
    }
    currentRoom = room;
    socket.join(roomId);
    
    // Добавляем функцию broadcastState в комнату
    room.broadcastState = () => {
      io.to(room.id).emit('state', {
        players: room.players,
        series: room.series,
        current: room.current
      });
    };
    
    room.broadcastState();
  });

  socket.on('assignTeam', ({ team }) => {
    if (!currentRoom) return;
    const player = currentRoom.players.find(p => p.id === socket.id);
    if (!player || player.role !== 'captain') return;
    const taken = currentRoom.players.some(p => p.role === 'captain' && p.team === team && p.id !== socket.id);
    if (taken) return socket.emit('error', { msg: 'Команда уже занята другим капитаном' });
    player.team = team;
    currentRoom.broadcastState();
  });

  socket.on('startGame', () => {
    if (!currentRoom) return;
    const captains = currentRoom.players.filter(p => p.role === 'captain');
    if (captains.length < 2) return socket.emit('error', { msg: 'Нужно 2 капитана' });
    if (captains.some(c => c.team === null)) return socket.emit('error', { msg: 'Капитаны не выбрали команды' });
    startNewGame(currentRoom);
    currentRoom.broadcastState();
  });

  socket.on('nextGame', () => {
    if (!currentRoom) return;
    if (!currentRoom.current?.finished) return;
    if (currentRoom.series.currentGame >= currentRoom.series.totalGames) {
      return socket.emit('error', { msg: 'Серия завершена!' });
    }
    startNewGame(currentRoom);
    currentRoom.broadcastState();
  });

  socket.on('draftAction', ({ heroId, actionType }) => {
    if (!currentRoom) return;
    const result = handleAction(currentRoom, socket.id, heroId, actionType);
    if (result.error) return socket.emit('error', { msg: result.error });
    currentRoom.broadcastState();
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    currentRoom.players = currentRoom.players.filter(p => p.id !== socket.id);
    currentRoom.broadcastState();
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на http://0.0.0.0:${PORT}`);
  fetchHeroes().catch(err => console.error('Ошибка загрузки героев:', err));
});