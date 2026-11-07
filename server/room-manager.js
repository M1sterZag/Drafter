// server/room-manager.js
const { generatePool } = require('./dota-api');

const rooms = new Map();
const timers = new Map();
const cleanupTimers = new Map();

// Пустая комната удаляется через это время
const ROOM_TTL_EMPTY = 10 * 60 * 1000;

const MAIN_TIME = 30;
const EXTRA_TIME = 120;

const DRAFT_ORDER = [
  { team: 0, action: 'ban' },
  { team: 1, action: 'ban' },
  { team: 0, action: 'ban' },
  { team: 1, action: 'ban' },
  { team: 0, action: 'ban' },
  { team: 1, action: 'ban' },
  { team: 0, action: 'pick' },
  { team: 1, action: 'pick' },
  { team: 1, action: 'pick' },
  { team: 0, action: 'pick' },
  { team: 0, action: 'pick' },
  { team: 1, action: 'pick' },
  { team: 1, action: 'pick' },
  { team: 0, action: 'pick' },
  { team: 0, action: 'pick' },
  { team: 1, action: 'pick' },
];

function generateRoomId() {
  let id;
  do {
    id = Math.random().toString(36).slice(2).padEnd(6, '0').slice(0, 6).toUpperCase();
  } while (rooms.has(id));
  return id;
}

function stopTimer(roomId) {
  if (timers.has(roomId)) {
    clearInterval(timers.get(roomId));
    timers.delete(roomId);
  }
}

function cancelRoomCleanup(room) {
  if (cleanupTimers.has(room.id)) {
    clearTimeout(cleanupTimers.get(room.id));
    cleanupTimers.delete(room.id);
  }
}

function scheduleRoomCleanup(room) {
  cancelRoomCleanup(room);
  const timeout = setTimeout(() => {
    cleanupTimers.delete(room.id);
    if (room.players.some(p => p.online)) return;
    stopTimer(room.id);
    rooms.delete(room.id);
    console.log(`🧹 Удалена пустая комната: ${room.id}`);
  }, ROOM_TTL_EMPTY);
  cleanupTimers.set(room.id, timeout);
}

function createRoom(allHeroes) {
  const roomId = generateRoomId();
  const room = {
    id: roomId,
    players: [],
    allHeroes,
    series: {
      currentGame: 0,
      totalGames: 5,
      pickedInSeries: [],
    },
    current: null,
    createdAt: Date.now()
  };
  rooms.set(roomId, room);
  return room;
}

function startNewGame(room) {
  const { series, allHeroes } = room;
  const pool = generatePool(allHeroes, series.pickedInSeries);

  room.current = {
    gameNumber: series.currentGame + 1,
    pool,
    bans: [[], []],
    picks: [[], []],
    draftHistory: [], // История всех действий в порядке
    draftStep: 0,
    finished: false,
    timers: {
      0: { main: MAIN_TIME, extra: EXTRA_TIME },
      1: { main: MAIN_TIME, extra: EXTRA_TIME }
    }
  };

  startTimer(room);
}

function startTimer(room) {
  stopTimer(room.id);

  const interval = setInterval(() => {
    if (!room.current || room.current.finished) {
      clearInterval(interval);
      timers.delete(room.id);
      return;
    }

    const step = DRAFT_ORDER[room.current.draftStep];
    if (!step) return;

    const teamTimer = room.current.timers[step.team];

    if (teamTimer.main > 0) {
      teamTimer.main--;
    } else if (teamTimer.extra > 0) {
      teamTimer.extra--;
    } else {
      performAutoAction(room);
      return;
    }

    if (room.broadcastState) {
      room.broadcastState();
    }
  }, 1000);

  timers.set(room.id, interval);
}

function performAutoAction(room) {
  const { current } = room;
  const step = DRAFT_ORDER[current.draftStep];
  if (!step) return;

  const usedIds = [...current.bans[0], ...current.bans[1], ...current.picks[0], ...current.picks[1]];
  const available = current.pool.filter(h => !usedIds.includes(h.id));

  if (available.length === 0) {
    // Героев не осталось — завершаем игру, чтобы таймер не крутился вечно
    finishGame(room);
    if (room.broadcastState) room.broadcastState();
    return;
  }

  const randomHero = available[Math.floor(Math.random() * available.length)];

  if (step.action === 'ban') {
    current.bans[step.team].push(randomHero.id);
  } else {
    current.picks[step.team].push(randomHero.id);
    room.series.pickedInSeries.push(randomHero.id);
  }

  // Добавляем в историю
  current.draftHistory.push({
    step: current.draftStep,
    team: step.team,
    action: step.action,
    heroId: randomHero.id
  });

  current.draftStep++;
  current.timers[step.team].main = MAIN_TIME;

  if (current.draftStep >= DRAFT_ORDER.length) finishGame(room);

  if (room.broadcastState) {
    room.broadcastState();
  }
}

function finishGame(room) {
  room.current.finished = true;
  room.series.currentGame++;
  stopTimer(room.id);
}

function handleAction(room, playerId, rawHeroId, actionType) {
  const heroId = Number(rawHeroId);
  const { current, series } = room;
  if (!current || current.finished) return { error: 'Игра не активна' };

  const step = DRAFT_ORDER[current.draftStep];
  if (!step) return { error: 'Драфт завершён' };

  const player = room.players.find(p => p.id === playerId);
  if (!player || player.role !== 'captain') return { error: 'Ты не капитан' };
  if (player.team !== step.team) return { error: 'Сейчас не твоя команда' };
  if (actionType !== step.action) return { error: 'Неверное действие' };

  const inPool = current.pool.find(h => h.id === heroId);
  const used = [...current.bans[0], ...current.bans[1], ...current.picks[0], ...current.picks[1]];
  if (!inPool || used.includes(heroId)) return { error: 'Герой недоступен' };

  if (actionType === 'ban') {
    current.bans[step.team].push(heroId);
  } else {
    current.picks[step.team].push(heroId);
    series.pickedInSeries.push(heroId);
  }

  // Добавляем в историю
  current.draftHistory.push({
    step: current.draftStep,
    team: step.team,
    action: step.action,
    heroId: heroId
  });

  current.draftStep++;
  current.timers[step.team].main = MAIN_TIME;

  if (current.draftStep >= DRAFT_ORDER.length) finishGame(room);

  return { ok: true };
}

module.exports = { rooms, createRoom, startNewGame, handleAction, scheduleRoomCleanup, cancelRoomCleanup, DRAFT_ORDER };