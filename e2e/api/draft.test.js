// e2e/api/draft.test.js — сквозные тесты backend (REST + Socket.IO) на реальном процессе сервера
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMockHeroesApi, startBackend, createRoom, Client, sleep, HEROES_PER_ATTR } = require('../helpers');

let mock;
let backend;
const clients = [];

async function connect() {
  const c = await Client.connect(backend.url);
  clients.push(c);
  return c;
}

// Комната с двумя капитанами на Radiant/Dire и зрителем
async function setupLobby({ mode = 'fixed', totalGames = 5 } = {}) {
  const roomId = await createRoom(backend.url);
  const a = await connect();
  const b = await connect();
  const spec = await connect();
  await a.join(roomId, 'Alpha', 'captain', `cid-a-${roomId}`);
  await b.join(roomId, 'Bravo', 'captain', `cid-b-${roomId}`);
  await spec.join(roomId, 'Viewer', 'spectator', `cid-s-${roomId}`);
  a.emit('assignTeam', { team: 0 });
  await a.waitState(s => s.players.find(p => p.name === 'Alpha')?.squad === 0, 'Alpha -> Radiant');
  b.emit('assignTeam', { team: 1 });
  await a.waitState(s => s.players.find(p => p.name === 'Bravo')?.squad === 1, 'Bravo -> Dire');
  if (mode !== 'fixed' || totalGames !== 5) {
    a.emit('configureSeries', { mode, totalGames });
    await a.waitState(s => s.series.mode === mode && s.series.totalGames === totalGames, 'series configured');
  }
  return { roomId, a, b, spec };
}

async function startAndConfirm({ a, b }) {
  a.emit('startGame');
  await a.waitState(s => !!s.series.readyCheck, 'readyCheck');
  a.emit('confirmReady');
  b.emit('confirmReady');
}

// Ждёт, пока условие выполнится в состоянии обоих клиентов (broadcast доходит не одновременно)
function bothSynced(a, b, predicate, label) {
  return Promise.all([a.waitState(predicate, `${label} (a)`), b.waitState(predicate, `${label} (b)`)]);
}

function captainFor(team, ...caps) {
  return caps.find(c => c.me?.team === team);
}

function freeHero(current) {
  const used = new Set([...current.bans[0], ...current.bans[1], ...current.picks[0], ...current.picks[1]]);
  return current.pool.find(h => !used.has(h.id));
}

// Проходит драфт целиком: каждый шаг делает капитан нужной стороны
async function playFullDraft(a, b) {
  for (let i = 0; i < 16; i++) {
    const { current } = a.state;
    const step = current.draftOrder[current.draftStep];
    const actor = captainFor(step.team, a, b);
    assert.ok(actor, `нет капитана для стороны ${step.team}`);
    actor.emit('draftAction', { heroId: freeHero(current).id, actionType: step.action });
    await bothSynced(a, b, s => s.current.draftStep === i + 1, `draft step ${i + 1}`);
  }
  assert.equal(a.state.current.finished, true);
}

before(async () => {
  mock = await startMockHeroesApi();
  backend = await startBackend({ HEROES_URL: mock.url, ROOM_TTL_EMPTY_MS: '300' });
});

after(async () => {
  clients.forEach(c => c.close());
  await backend?.stop();
  await mock?.close();
});

describe('REST API', () => {
  it('создаёт комнату и отдаёт её состояние (ID регистронезависимый)', async () => {
    const roomId = await createRoom(backend.url);
    assert.match(roomId, /^[A-Z0-9]{6}$/);
    const res = await fetch(`${backend.url}/api/rooms/${roomId.toLowerCase()}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, roomId);
    assert.deepEqual(body.players, []);
    assert.equal(body.series.totalGames, 5);
    assert.equal(body.series.mode, 'fixed');
    assert.equal(body.current, null);
  });

  it('возвращает 404 для несуществующей комнаты', async () => {
    const res = await fetch(`${backend.url}/api/rooms/NOPE00`);
    assert.equal(res.status, 404);
  });

  it('ID комнат уникальны', async () => {
    const ids = await Promise.all(Array.from({ length: 30 }, () => createRoom(backend.url)));
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('Вход в комнату', () => {
  it('ошибка для несуществующей комнаты', async () => {
    const c = await connect();
    const msg = await c.expectError(() => c.emit('join', { roomId: 'ZZZZZZ', playerName: 'X', role: 'captain' }));
    assert.equal(msg, 'Комната не найдена');
  });

  it('нормализует имя, роль и ID комнаты', async () => {
    const roomId = await createRoom(backend.url);
    const c1 = await connect();
    await c1.join(roomId.toLowerCase(), '   ', 'admin');
    assert.equal(c1.me.name, 'Игрок');
    assert.equal(c1.me.role, 'spectator');

    const c2 = await connect();
    await c2.join(roomId, '  ' + 'x'.repeat(50) + '  ', 'captain');
    assert.equal(c2.me.name.length, 32);
    assert.equal(c2.me.role, 'captain');
  });

  it('не отдаёт clientId других игроков в broadcast-состоянии', async () => {
    const roomId = await createRoom(backend.url);
    const cap = await connect();
    await cap.join(roomId, 'Cap', 'captain', 'secret-client-id');
    const spy = await connect();
    await spy.join(roomId, 'Spy', 'spectator');
    assert.ok(!JSON.stringify(spy.state).includes('secret-client-id'), 'clientId утёк в state');
    const rest = await (await fetch(`${backend.url}/api/rooms/${roomId}`)).json();
    assert.ok(!JSON.stringify(rest).includes('secret-client-id'), 'clientId утёк в REST');
  });

  it('некорректные payload не роняют сервер', async () => {
    const roomId = await createRoom(backend.url);
    const c = await connect();
    for (const ev of ['join', 'assignTeam', 'configureSeries', 'setupChoice', 'draftAction']) {
      c.emit(ev, null);
      c.emit(ev, 'garbage');
      c.emit(ev, 42);
    }
    await c.join(roomId, 'Still', 'captain');
    for (const ev of ['assignTeam', 'configureSeries', 'setupChoice', 'draftAction', 'startGame', 'confirmReady', 'nextGame', 'togglePause']) {
      c.emit(ev, null);
      c.emit(ev, { team: '0', heroId: {}, mode: [], totalGames: 'abc' });
    }
    await sleep(200);
    assert.ok(backend.alive(), 'сервер упал');
    assert.equal(c.me.squad, undefined);
  });
});

describe('Лобби', () => {
  it('назначение сторон: только капитаны, сторона не может быть занята дважды', async () => {
    const roomId = await createRoom(backend.url);
    const a = await connect();
    const b = await connect();
    const s = await connect();
    await a.join(roomId, 'A', 'captain');
    await b.join(roomId, 'B', 'captain');
    await s.join(roomId, 'S', 'spectator');

    s.emit('assignTeam', { team: 0 });
    a.emit('assignTeam', { team: 5 });
    a.emit('assignTeam', { team: 0 });
    await a.waitState(st => st.players.find(p => p.name === 'A').team === 0, 'A on Radiant');
    assert.equal(a.state.players.find(p => p.name === 'S').team, null);

    const msg = await b.expectError(() => b.emit('assignTeam', { team: 0 }));
    assert.equal(msg, 'Команда уже занята другим капитаном');

    // Капитан может пересесть на свободную сторону, освобождая прежнюю
    a.emit('assignTeam', { team: 1 });
    await a.waitState(st => st.players.find(p => p.name === 'A').team === 1, 'A on Dire');
    b.emit('assignTeam', { team: 0 });
    await a.waitState(st => st.players.find(p => p.name === 'B').team === 0, 'B on Radiant');
  });

  it('настройки серии: валидация и права', async () => {
    const { a, spec } = await setupLobby();
    assert.equal(await spec.expectError(() => spec.emit('configureSeries', { mode: 'pro', totalGames: 3 })), 'Настройки доступны только капитану');
    assert.equal(await a.expectError(() => a.emit('configureSeries', { mode: 'weird', totalGames: 3 })), 'Неизвестный режим серии');
    assert.equal(await a.expectError(() => a.emit('configureSeries', { mode: 'pro', totalGames: 7 })), 'Доступны только BO3 и BO5');
    a.emit('configureSeries', { mode: 'pro', totalGames: '3' });
    await a.waitState(s => s.series.mode === 'pro' && s.series.totalGames === 3, 'pro BO3');
  });

  it('старт: нужен капитан и обе стороны', async () => {
    const roomId = await createRoom(backend.url);
    const a = await connect();
    const s = await connect();
    await a.join(roomId, 'A', 'captain');
    await s.join(roomId, 'S', 'spectator');
    assert.equal(await s.expectError(() => s.emit('startGame')), 'Только капитан может начать драфт');
    assert.equal(await a.expectError(() => a.emit('startGame')), 'Нужно 2 капитана, занявших Radiant и Dire');
    a.emit('assignTeam', { team: 0 });
    await a.waitState(st => st.players[0].team === 0, 'A on Radiant');
    assert.equal(await a.expectError(() => a.emit('startGame')), 'Нужно 2 капитана, занявших Radiant и Dire');
  });
});

describe('Подтверждение готовности', () => {
  it('нужны оба капитана; после старта лобби заблокировано', async () => {
    const { a, b, spec } = await setupLobby();
    a.emit('startGame');
    await a.waitState(s => s.series.readyCheck?.gameNumber === 1, 'readyCheck 1');

    assert.equal(await a.expectError(() => a.emit('startGame')), 'Серия уже запускается');
    assert.equal(await a.expectError(() => a.emit('assignTeam', { team: 1 })), 'Нельзя менять команду после начала серии');
    assert.equal(await a.expectError(() => a.emit('configureSeries', { mode: 'pro', totalGames: 3 })), 'Нельзя менять формат после начала серии');
    assert.equal(await spec.expectError(() => spec.emit('confirmReady')), 'Подтверждение доступно только капитану');

    a.emit('confirmReady');
    a.emit('confirmReady'); // повторное подтверждение не засчитывается дважды
    await a.waitState(s => s.series.readyCheck.confirmedSquads.length === 1, 'A confirmed');
    await sleep(100);
    assert.equal(a.state.current, null);

    b.emit('confirmReady');
    await a.waitState(s => s.current && !s.series.readyCheck, 'draft started');
    assert.equal(await a.expectError(() => a.emit('confirmReady')), 'Подтверждение сейчас не требуется');
  });

  it('отключение капитана снимает его подтверждение, возврат — восстанавливает место', async () => {
    const { roomId, a, b } = await setupLobby();
    a.emit('startGame');
    await a.waitState(s => !!s.series.readyCheck, 'readyCheck');
    b.emit('confirmReady');
    await a.waitState(s => s.series.readyCheck.confirmedSquads.includes(1), 'B confirmed');

    b.close();
    await a.waitState(s => s.series.readyCheck.confirmedSquads.length === 0, 'B confirmation dropped');
    const offline = a.state.players.find(p => p.name === 'Bravo');
    assert.equal(offline.online, false);
    assert.equal(offline.squad, 1);

    const b2 = await connect();
    await b2.join(roomId, 'Bravo-new', 'spectator', `cid-b-${roomId}`);
    assert.equal(b2.me.role, 'captain', 'роль восстановлена по clientId');
    assert.equal(b2.me.squad, 1);
    assert.equal(b2.me.name, 'Bravo-new');
    assert.equal(a.state.players.filter(p => p.squad === 1).length, 1);

    a.emit('confirmReady');
    b2.emit('confirmReady');
    await a.waitState(s => !!s.current, 'draft started after reconnect');
  });
});

describe('Драфт (fixed)', () => {
  it('пул 28 героев по 7 на атрибут, порядок 6 банов + 10 пиков, first pick у Radiant', async () => {
    const ctx = await setupLobby();
    await startAndConfirm(ctx);
    await ctx.a.waitState(s => !!s.current, 'draft');
    const { current } = ctx.a.state;

    assert.equal(current.gameNumber, 1);
    assert.equal(current.pool.length, 28);
    const byAttr = current.pool.reduce((acc, h) => ({ ...acc, [h.primaryAttr]: (acc[h.primaryAttr] || 0) + 1 }), {});
    assert.deepEqual(byAttr, { str: 7, agi: 7, int: 7, uni: 7 });
    assert.equal(new Set(current.pool.map(h => h.id)).size, 28);
    assert.ok(current.pool.every(h => h.name.startsWith('npc_dota_hero_')));
    assert.ok(current.pool.every(h => h.image.includes(h.shortName)));

    assert.equal(current.draftOrder.length, 16);
    assert.equal(current.draftOrder.filter(s => s.action === 'ban').length, 6);
    assert.equal(current.firstPickTeam, 0);
    assert.deepEqual(current.draftOrder.slice(6).map(s => s.team), [0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
    assert.deepEqual(current.timers, { 0: { main: 30, extra: 120 }, 1: { main: 30, extra: 120 } });
  });

  it('валидация действий драфта', async () => {
    const ctx = await setupLobby();
    const { a, b, spec } = ctx;
    await startAndConfirm(ctx);
    await a.waitState(s => !!s.current, 'draft');
    const { current } = a.state;
    const hero = current.pool[0];

    assert.equal(await spec.expectError(() => spec.emit('draftAction', { heroId: hero.id, actionType: 'ban' })), 'Ты не капитан');
    assert.equal(await b.expectError(() => b.emit('draftAction', { heroId: hero.id, actionType: 'ban' })), 'Сейчас не твоя команда');
    assert.equal(await a.expectError(() => a.emit('draftAction', { heroId: hero.id, actionType: 'pick' })), 'Неверное действие');
    assert.equal(await a.expectError(() => a.emit('draftAction', { heroId: 424242, actionType: 'ban' })), 'Герой недоступен');

    // heroId строкой тоже принимается
    a.emit('draftAction', { heroId: String(hero.id), actionType: 'ban' });
    await a.waitState(s => s.current.draftStep === 1, 'step 1');
    assert.deepEqual(a.state.current.bans[0], [hero.id]);
    assert.deepEqual(a.state.current.draftHistory[0], { step: 0, team: 0, action: 'ban', heroId: hero.id });

    assert.equal(await b.expectError(() => b.emit('draftAction', { heroId: hero.id, actionType: 'ban' })), 'Герой недоступен');
  });

  it('пауза: только капитаны, блокирует ходы и таймер', async () => {
    const ctx = await setupLobby();
    const { a, b, spec } = ctx;
    await startAndConfirm(ctx);
    await a.waitState(s => !!s.current && s.current.timers[0].main < 30, 'timer ticking');

    assert.equal(await spec.expectError(() => spec.emit('togglePause')), 'Пауза доступна только капитанам');
    const extra = await connect();
    await extra.join(ctx.roomId, 'Extra', 'captain');
    assert.equal(await extra.expectError(() => extra.emit('togglePause')), 'Пауза доступна только капитанам');
    b.emit('togglePause');
    await a.waitState(s => s.current.paused && s.current.pausedBySquad === 1, 'paused by Dire');

    const frozen = a.state.current.timers[0].main;
    await sleep(1300);
    assert.equal(a.state.current.timers[0].main, frozen, 'таймер идёт на паузе');
    assert.equal(await a.expectError(() => a.emit('draftAction', { heroId: a.state.current.pool[0].id, actionType: 'ban' })), 'Драфт на паузе');

    a.emit('togglePause');
    await a.waitState(s => !s.current.paused && s.current.pausedBySquad === null, 'resumed');
    await a.waitState(s => s.current.timers[0].main < frozen, 'timer resumed');
  });

  it('полная серия BO3: драфты, следующие игры, исключение пикнутых героев', async () => {
    const ctx = await setupLobby({ mode: 'fixed', totalGames: 3 });
    const { a, b, spec } = ctx;
    const picked = new Set();

    for (let game = 1; game <= 3; game++) {
      if (game === 1) {
        a.emit('startGame');
      } else {
        assert.equal(await spec.expectError(() => spec.emit('togglePause')), 'Драфт не активен');
        spec.emit('nextGame'); // зритель игнорируется
        await sleep(100);
        assert.equal(a.state.series.readyCheck, null);
        b.emit('nextGame');
      }
      await a.waitState(s => s.series.readyCheck?.gameNumber === game, `readyCheck ${game}`);
      a.emit('confirmReady');
      b.emit('confirmReady');
      await a.waitState(s => s.current?.gameNumber === game && !s.current.finished, `game ${game}`);

      const poolIds = a.state.current.pool.map(h => h.id);
      assert.ok(poolIds.every(id => !picked.has(id)), `в пуле игры ${game} есть уже пикнутые герои`);

      // nextGame до окончания драфта игнорируется
      a.emit('nextGame');
      await sleep(50);
      assert.equal(a.state.series.readyCheck, null);

      await playFullDraft(a, b);
      const { current, series } = a.state;
      assert.equal(current.picks[0].length, 5);
      assert.equal(current.picks[1].length, 5);
      assert.equal(current.bans[0].length, 3);
      assert.equal(current.bans[1].length, 3);
      assert.equal(current.draftHistory.length, 16);
      assert.equal(series.currentGame, game);
      [...current.picks[0], ...current.picks[1]].forEach(id => picked.add(id));
      assert.deepEqual(new Set(series.pickedInSeries), picked);

      // Спектатор видит то же состояние
      await spec.waitState(s => s.current?.finished && s.series.currentGame === game, 'spectator synced');
      assert.equal(await a.expectError(() => a.emit('draftAction', { heroId: 1, actionType: 'pick' })), 'Игра не активна');
    }

    assert.equal(await a.expectError(() => a.emit('nextGame')), 'Серия завершена!');
  });
});

describe('Про-режим (жеребьёвка и выбор)', () => {
  async function chooseSetup(a, b, primary, secondary) {
    const sel = a.state.series.selection;
    const chooser = [a, b].find(c => c.me.squad === sel.chooserSquad);
    const other = [a, b].find(c => c !== chooser);
    chooser.emit('setupChoice', primary);
    await a.waitState(s => s.series.selection?.stage === 'secondary', 'secondary stage');
    other.emit('setupChoice', secondary);
    await bothSynced(a, b, s => !!s.current && !s.series.selection, 'draft after setup');
    return { chooser, other };
  }

  it('BO3: жеребьёвка → чередование → жеребьёвка; стороны и first pick применяются', async () => {
    const ctx = await setupLobby({ mode: 'pro', totalGames: 3 });
    const { a, b, spec } = ctx;
    await startAndConfirm(ctx);
    await a.waitState(s => !!s.series.selection, 'selection 1');

    const sel1 = a.state.series.selection;
    assert.equal(sel1.gameNumber, 1);
    assert.equal(sel1.isCoinToss, true);
    assert.equal(sel1.stage, 'primary');
    const coinWinner = sel1.chooserSquad;
    const chooser = [a, b].find(c => c.me.squad === coinWinner);
    const other = [a, b].find(c => c !== chooser);

    assert.equal(await other.expectError(() => other.emit('setupChoice', { category: 'side', value: 0 })), 'Сейчас выбирает другой капитан');
    assert.equal(await spec.expectError(() => spec.emit('setupChoice', { category: 'side', value: 0 })), 'Выбор доступен только капитану');
    assert.equal(await chooser.expectError(() => chooser.emit('setupChoice', { category: 'hero', value: 0 })), 'Неверная категория выбора');
    assert.equal(await chooser.expectError(() => chooser.emit('setupChoice', { category: 'side', value: 2 })), 'Неверная сторона');
    assert.equal(await chooser.expectError(() => chooser.emit('setupChoice', { category: 'pickOrder', value: 'mid' })), 'Неверный порядок пика');

    // Победитель жребия берёт Dire, второй капитан — first pick
    chooser.emit('setupChoice', { category: 'side', value: 1 });
    await a.waitState(s => s.series.selection.stage === 'secondary', 'secondary');
    assert.equal(await chooser.expectError(() => chooser.emit('setupChoice', { category: 'pickOrder', value: 'first' })), 'Сейчас выбирает другой капитан');
    assert.equal(await other.expectError(() => other.emit('setupChoice', { category: 'side', value: 0 })), 'Нужно выбрать оставшийся параметр');
    other.emit('setupChoice', { category: 'pickOrder', value: 'first' });
    await bothSynced(a, b, s => !!s.current, 'game 1 draft');

    const g1 = a.state.current;
    assert.equal(chooser.me.team, 1);
    assert.equal(other.me.team, 0);
    assert.equal(g1.firstPickTeam, 0, 'first pick у второго капитана (Radiant)');
    assert.deepEqual(g1.setup.sideBySquad[coinWinner], 1);
    assert.equal(g1.setup.firstPickSquad, 1 - coinWinner);
    await playFullDraft(a, b);

    // Игра 2: выбирает проигравший жребий; берёт last pick, соперник выбирает Radiant
    b.emit('nextGame');
    await a.waitState(s => s.series.readyCheck?.gameNumber === 2, 'ready 2');
    a.emit('confirmReady');
    b.emit('confirmReady');
    await a.waitState(s => s.series.selection?.gameNumber === 2, 'selection 2');
    const sel2 = a.state.series.selection;
    assert.equal(sel2.isCoinToss, false);
    assert.equal(sel2.chooserSquad, 1 - coinWinner);

    const r2 = await chooseSetup(a, b, { category: 'pickOrder', value: 'last' }, { category: 'side', value: 0 });
    const g2 = a.state.current;
    assert.equal(r2.other.me.team, 0);
    assert.equal(r2.chooser.me.team, 1);
    assert.equal(g2.setup.firstPickSquad, r2.other.me.squad);
    assert.equal(g2.firstPickTeam, 0);
    assert.equal(g2.draftOrder[0].team, 0);
    await playFullDraft(a, b);

    // Игра 3 (решающая): снова жеребьёвка
    a.emit('nextGame');
    await a.waitState(s => s.series.readyCheck?.gameNumber === 3, 'ready 3');
    a.emit('confirmReady');
    b.emit('confirmReady');
    await a.waitState(s => s.series.selection?.gameNumber === 3, 'selection 3');
    assert.equal(a.state.series.selection.isCoinToss, true);
    await chooseSetup(a, b, { category: 'pickOrder', value: 'first' }, { category: 'side', value: 1 });
    const g3 = a.state.current;
    const chooser3 = [a, b].find(c => c.me.squad === g3.setup.chooserSquad);
    assert.equal(g3.firstPickTeam, chooser3.me.team);
    assert.equal(chooser3.me.team, 0, 'соперник взял Dire');
    await playFullDraft(a, b);
    assert.equal(a.state.series.currentGame, 3);
  });

  it('BO5: право выбора чередуется проигравший/победитель/проигравший, 5-я — жеребьёвка', async () => {
    const ctx = await setupLobby({ mode: 'pro', totalGames: 5 });
    const { a, b } = ctx;
    await startAndConfirm(ctx);
    let coinWinner = null;
    for (let game = 1; game <= 5; game++) {
      if (game > 1) {
        a.emit('nextGame');
        await a.waitState(s => s.series.readyCheck?.gameNumber === game, `ready ${game}`);
        a.emit('confirmReady');
        b.emit('confirmReady');
      }
      await a.waitState(s => s.series.selection?.gameNumber === game, `selection ${game}`);
      const sel = a.state.series.selection;
      if (game === 1) coinWinner = sel.chooserSquad;
      const expected = { 1: 'coin', 2: 1 - coinWinner, 3: coinWinner, 4: 1 - coinWinner, 5: 'coin' }[game];
      if (expected === 'coin') assert.equal(sel.isCoinToss, true, `game ${game} coin toss`);
      else {
        assert.equal(sel.isCoinToss, false);
        assert.equal(sel.chooserSquad, expected, `chooser game ${game}`);
      }
      await chooseSetup(a, b, { category: 'side', value: game % 2 }, { category: 'pickOrder', value: 'last' });
      await playFullDraft(a, b);
    }
    assert.equal(a.state.series.currentGame, 5);
    assert.equal(a.state.series.pickedInSeries.length, 50);
  });
});

describe('Переподключение и жизненный цикл комнаты', () => {
  it('капитан без стороны и зритель удаляются при уходе, капитан со стороной остаётся оффлайн', async () => {
    const roomId = await createRoom(backend.url);
    const host = await connect();
    const loose = await connect();
    const seated = await connect();
    const viewer = await connect();
    await host.join(roomId, 'Host', 'captain', 'cid-host');
    await loose.join(roomId, 'Loose', 'captain', 'cid-loose');
    await seated.join(roomId, 'Seated', 'captain', 'cid-seated');
    await viewer.join(roomId, 'Viewer', 'spectator', 'cid-viewer');
    seated.emit('assignTeam', { team: 1 });
    await host.waitState(s => s.players.find(p => p.name === 'Seated').team === 1, 'seated');

    loose.close();
    viewer.close();
    seated.close();
    await host.waitState(s => s.players.length === 2 && s.players.find(p => p.name === 'Seated')?.online === false, 'cleanup');

    const back = await connect();
    await back.join(roomId, 'Seated', 'captain', 'cid-seated');
    assert.equal(back.me.team, 1);
    assert.equal(back.me.online, true);
    assert.equal(host.state.players.length, 2);
  });

  it('переподключение капитана посреди драфта сохраняет право хода', async () => {
    const ctx = await setupLobby();
    const { roomId, a } = ctx;
    await startAndConfirm(ctx);
    await a.waitState(s => !!s.current, 'draft');
    a.close();
    const a2 = await connect();
    await a2.join(roomId, 'Alpha', 'captain', `cid-a-${roomId}`);
    assert.equal(a2.me.team, 0);
    a2.emit('draftAction', { heroId: a2.state.current.pool[0].id, actionType: 'ban' });
    await a2.waitState(s => s.current.draftStep === 1, 'step after reconnect');
  });

  it('смена комнаты одним сокетом выводит игрока из предыдущей', async () => {
    const r1 = await createRoom(backend.url);
    const r2 = await createRoom(backend.url);
    const watcher = await connect();
    await watcher.join(r1, 'Watcher', 'spectator');
    const hopper = await connect();
    await hopper.join(r1, 'Hopper', 'spectator');
    await watcher.waitState(s => s.players.length === 2, 'two in r1');
    await hopper.join(r2, 'Hopper', 'spectator');
    await watcher.waitState(s => s.players.length === 1, 'hopper left r1');
  });

  it('пустая комната удаляется по TTL', async () => {
    const roomId = await createRoom(backend.url);
    const c = await connect();
    await c.join(roomId, 'Temp', 'spectator');
    c.close();
    await sleep(800);
    const res = await fetch(`${backend.url}/api/rooms/${roomId}`);
    assert.equal(res.status, 404);
  });
});

describe('Таймеры и авто-ход', () => {
  let fast;
  before(async () => {
    fast = await startBackend({ HEROES_URL: mock.url, DRAFT_MAIN_TIME: '2', DRAFT_EXTRA_TIME: '2', DRAFT_TICK_MS: '40' });
  });
  after(async () => { await fast?.stop(); });

  it('основное время сбрасывается после хода, доп. время тратится, по истечении — случайный ход', async () => {
    const roomId = await createRoom(fast.url);
    const a = await Client.connect(fast.url);
    const b = await Client.connect(fast.url);
    clients.push(a, b);
    await a.join(roomId, 'A', 'captain');
    await b.join(roomId, 'B', 'captain');
    a.emit('assignTeam', { team: 0 });
    b.emit('assignTeam', { team: 1 });
    await a.waitState(s => s.players.filter(p => p.team !== null).length === 2, 'teams');
    await startAndConfirm({ a, b });

    await a.waitState(s => s.current?.timers[0].main === 0 && s.current.timers[0].extra < 2, 'radiant extra time used');
    await a.waitState(s => s.current.draftStep >= 1, 'auto ban');
    const hist = a.state.current.draftHistory[0];
    assert.equal(hist.team, 0);
    assert.equal(hist.action, 'ban');
    assert.ok(a.state.current.pool.some(h => h.id === hist.heroId));

    // После истощения доп. времени ходы делаются авто-ходом сразу по истечении основного
    await a.waitFor(() => a.state.current.finished, 'auto-finished draft', 15000);
    const { current, series } = a.state;
    assert.equal(current.draftHistory.length, 16);
    assert.equal(current.picks[0].length + current.picks[1].length, 10);
    const used = [...current.bans[0], ...current.bans[1], ...current.picks[0], ...current.picks[1]];
    assert.equal(new Set(used).size, 16, 'дубликаты среди авто-ходов');
    assert.equal(series.currentGame, 1);
    assert.equal(series.pickedInSeries.length, 10);
  });
});

describe('Недоступность OpenDota', () => {
  it('POST /api/rooms отвечает 502, сервер продолжает работать', async () => {
    const broken = await startBackend({ HEROES_URL: 'http://127.0.0.1:1/api/heroes' });
    try {
      const res = await fetch(`${broken.url}/api/rooms`, { method: 'POST' });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).error, 'Не удалось загрузить список героев');
      assert.ok(broken.alive());
    } finally {
      await broken.stop();
    }
  });

  it('фильтрует не-героев и нормализует атрибуты', async () => {
    const ctx = await setupLobby();
    await startAndConfirm(ctx);
    await ctx.a.waitState(s => !!s.current, 'draft');
    assert.ok(ctx.a.state.current.pool.every(h => h.id !== 9999));
    assert.ok(ctx.a.state.current.pool.every(h => ['str', 'agi', 'int', 'uni'].includes(h.primaryAttr)));
    assert.equal(HEROES_PER_ATTR, 25);
  });
});
