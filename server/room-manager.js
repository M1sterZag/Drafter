// server/room-manager.js
const { generatePool } = require('./dota-api');

const rooms = new Map();
const timers = new Map();
const cleanupTimers = new Map();

// Числовые настройки можно переопределить через env (используется в e2e-тестах)
const envNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

// Пустая комната удаляется через это время
const ROOM_TTL_EMPTY = envNumber('ROOM_TTL_EMPTY_MS', 10 * 60 * 1000);

// Основное время на ход и запас дополнительного времени команды (секунды)
const MAIN_TIME = envNumber('DRAFT_MAIN_TIME', 30);
const EXTRA_TIME = envNumber('DRAFT_EXTRA_TIME', 120);
// Длина «секунды» таймера драфта в мс (в тестах ускоряется)
const TICK_MS = envNumber('DRAFT_TICK_MS', 1000);

// В шаблоне 0 — команда с first pick, 1 — команда с last pick.
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
      mode: 'fixed',
      pickedInSeries: [],
      openingCoinWinnerSquad: null,
      readyCheck: null,
      selection: null,
    },
    current: null,
    createdAt: Date.now()
  };
  rooms.set(roomId, room);
  return room;
}

function buildDraftOrder(firstPickTeam) {
  return DRAFT_ORDER.map(step => ({
    ...step,
    team: step.team === 0 ? firstPickTeam : 1 - firstPickTeam
  }));
}

function startNewGame(room, firstPickTeam = 0, setup = null) {
  const { series, allHeroes } = room;
  const pool = generatePool(allHeroes, series.pickedInSeries);

  room.current = {
    gameNumber: series.currentGame + 1,
    pool,
    bans: [[], []],
    picks: [[], []],
    draftHistory: [], // История всех действий в порядке
    draftOrder: buildDraftOrder(firstPickTeam),
    firstPickTeam,
    setup,
    draftStep: 0,
    finished: false,
    paused: false,
    pausedBySquad: null,
    timers: {
      0: { main: MAIN_TIME, extra: EXTRA_TIME },
      1: { main: MAIN_TIME, extra: EXTRA_TIME }
    }
  };

  startTimer(room);
}

function configureSeries(room, mode, totalGames) {
  if (room.current || room.series.readyCheck || room.series.selection || room.series.currentGame > 0) {
    return { error: 'Нельзя менять формат после начала серии' };
  }
  if (mode !== 'fixed' && mode !== 'pro') return { error: 'Неизвестный режим серии' };
  if (totalGames !== 3 && totalGames !== 5) return { error: 'Доступны только BO3 и BO5' };

  room.series.mode = mode;
  room.series.totalGames = totalGames;
  return { ok: true };
}

function prepareProSelection(room) {
  const { series } = room;
  const gameIndex = series.currentGame;
  const isCoinToss = gameIndex === 0 || gameIndex === series.totalGames - 1;
  let chooserSquad;

  if (isCoinToss) {
    chooserSquad = Math.random() < 0.5 ? 0 : 1;
    if (gameIndex === 0) series.openingCoinWinnerSquad = chooserSquad;
  } else {
    // После первой жеребьёвки право выбора чередуется: проигравший, победитель, проигравший.
    const winner = series.openingCoinWinnerSquad;
    chooserSquad = gameIndex % 2 === 1 ? 1 - winner : winner;
  }

  room.current = null;
  series.selection = {
    gameNumber: gameIndex + 1,
    chooserSquad,
    isCoinToss,
    stage: 'primary',
    primaryCategory: null,
    primaryValue: null
  };
}

function beginNextGame(room) {
  room.current = null;
  room.series.selection = null;
  room.series.readyCheck = {
    gameNumber: room.series.currentGame + 1,
    confirmedSquads: []
  };
}

function confirmReady(room, playerId) {
  const readyCheck = room.series.readyCheck;
  if (!readyCheck) return { error: 'Подтверждение сейчас не требуется' };

  const player = room.players.find(p => p.id === playerId);
  if (!player || player.role !== 'captain' || (player.squad !== 0 && player.squad !== 1)) {
    return { error: 'Подтверждение доступно только капитану' };
  }

  if (!readyCheck.confirmedSquads.includes(player.squad)) {
    readyCheck.confirmedSquads.push(player.squad);
  }

  if (readyCheck.confirmedSquads.length < 2) return { ok: true };

  room.series.readyCheck = null;
  if (room.series.mode === 'fixed') {
    startNewGame(room, 0, { mode: 'fixed' });
  } else {
    prepareProSelection(room);
  }
  return { ok: true };
}

function handleSetupChoice(room, playerId, category, value) {
  const selection = room.series.selection;
  if (!selection) return { error: 'Выбор перед игрой не активен' };

  const player = room.players.find(p => p.id === playerId);
  if (!player || player.role !== 'captain' || (player.squad !== 0 && player.squad !== 1)) {
    return { error: 'Выбор доступен только капитану' };
  }

  const expectedSquad = selection.stage === 'primary'
    ? selection.chooserSquad
    : 1 - selection.chooserSquad;
  if (player.squad !== expectedSquad) return { error: 'Сейчас выбирает другой капитан' };

  if (selection.stage === 'primary') {
    if (category !== 'side' && category !== 'pickOrder') return { error: 'Неверная категория выбора' };
    if (category === 'side' && value !== 0 && value !== 1) return { error: 'Неверная сторона' };
    if (category === 'pickOrder' && value !== 'first' && value !== 'last') return { error: 'Неверный порядок пика' };
    selection.primaryCategory = category;
    selection.primaryValue = value;
    selection.stage = 'secondary';
    return { ok: true };
  }

  const secondaryCategory = selection.primaryCategory === 'side' ? 'pickOrder' : 'side';
  if (category !== secondaryCategory) return { error: 'Нужно выбрать оставшийся параметр' };
  if (category === 'side' && value !== 0 && value !== 1) return { error: 'Неверная сторона' };
  if (category === 'pickOrder' && value !== 'first' && value !== 'last') return { error: 'Неверный порядок пика' };

  const primarySquad = selection.chooserSquad;
  const secondarySquad = 1 - primarySquad;
  let sideBySquad;
  let firstPickSquad;

  if (selection.primaryCategory === 'side') {
    sideBySquad = [];
    sideBySquad[primarySquad] = selection.primaryValue;
    sideBySquad[secondarySquad] = 1 - selection.primaryValue;
    firstPickSquad = value === 'first' ? secondarySquad : primarySquad;
  } else {
    firstPickSquad = selection.primaryValue === 'first' ? primarySquad : secondarySquad;
    sideBySquad = [];
    sideBySquad[secondarySquad] = value;
    sideBySquad[primarySquad] = 1 - value;
  }

  room.players.forEach(p => {
    if (p.role === 'captain' && (p.squad === 0 || p.squad === 1)) p.team = sideBySquad[p.squad];
  });

  const setup = {
    mode: 'pro',
    isCoinToss: selection.isCoinToss,
    chooserSquad: selection.chooserSquad,
    sideBySquad,
    firstPickSquad
  };
  room.series.selection = null;
  startNewGame(room, sideBySquad[firstPickSquad], setup);
  return { ok: true };
}

function startTimer(room) {
  stopTimer(room.id);

  const interval = setInterval(() => {
    if (!room.current || room.current.finished) {
      clearInterval(interval);
      timers.delete(room.id);
      return;
    }

    if (room.current.paused) return;

    const step = room.current.draftOrder[room.current.draftStep];
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
  }, TICK_MS);

  timers.set(room.id, interval);
}

function performAutoAction(room) {
  const { current } = room;
  const step = current.draftOrder[current.draftStep];
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

  if (current.draftStep >= current.draftOrder.length) finishGame(room);

  if (room.broadcastState) {
    room.broadcastState();
  }
}

function finishGame(room) {
  room.current.finished = true;
  room.series.currentGame++;
  stopTimer(room.id);
}

function togglePause(room, playerId) {
  const { current } = room;
  if (!current || current.finished) return { error: 'Драфт не активен' };

  const player = room.players.find(p => p.id === playerId);
  // Пауза — только у капитанов, занявших сторону (третий «лишний» капитан не в счёт)
  if (!player || player.role !== 'captain' || (player.squad !== 0 && player.squad !== 1)) {
    return { error: 'Пауза доступна только капитанам' };
  }

  current.paused = !current.paused;
  current.pausedBySquad = current.paused ? player.squad : null;
  return { ok: true };
}

function handleAction(room, playerId, rawHeroId, actionType) {
  const heroId = Number(rawHeroId);
  const { current, series } = room;
  if (!current || current.finished) return { error: 'Игра не активна' };
  if (current.paused) return { error: 'Драфт на паузе' };

  const step = current.draftOrder[current.draftStep];
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

  if (current.draftStep >= current.draftOrder.length) finishGame(room);

  return { ok: true };
}

module.exports = {
  rooms,
  createRoom,
  beginNextGame,
  confirmReady,
  configureSeries,
  handleSetupChoice,
  togglePause,
  handleAction,
  scheduleRoomCleanup,
  cancelRoomCleanup,
  DRAFT_ORDER
};
