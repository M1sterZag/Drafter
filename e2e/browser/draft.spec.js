// e2e/browser/draft.spec.js — сквозные сценарии в реальном браузере (Chrome):
// два капитана и зритель в отдельных браузерных контекстах.
const { test, expect } = require('@playwright/test');

const heroButtons = page => page.locator('button[title]');
const usedHeroes = page => page.locator('button[title]', { hasText: '🚫' });

async function openHome(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', err => { throw err; });
  return { context, page };
}

async function createLobby(page, name) {
  await page.goto('/');
  await page.getByPlaceholder('Введи свой никнейм').fill(name);
  await page.locator('select').selectOption('captain');
  await page.getByRole('button', { name: 'Создать лобби' }).click();
  await expect(page.getByRole('heading', { name: /Лобби #/ })).toBeVisible();
  const roomId = new URL(page.url()).searchParams.get('room');
  expect(roomId).toMatch(/^[A-Z0-9]{6}$/);
  return roomId;
}

async function joinByLink(page, roomId, role, name) {
  await page.goto(`/?room=${roomId}&role=${role}`);
  await expect(page.getByPlaceholder('ID КОМНАТЫ')).toHaveValue(roomId);
  await expect(page.locator('select')).toHaveValue(role);
  await page.getByPlaceholder('Введи свой никнейм').fill(name);
  await page.getByRole('button', { name: 'Вход' }).click();
  await expect(page.getByRole('heading', { name: `Лобби #${roomId}` })).toBeVisible();
}

// Делает один ход драфта на странице капитана, у которого сейчас ход
async function makeMove(actor, pages, doneBefore) {
  await expect(actor.getByText('Твой ход!')).toBeVisible();
  await actor.locator('button[title]:not([disabled])').first().click();
  const confirm = actor.getByRole('button', { name: /Забанить|Пикнуть/ });
  await expect(confirm).toBeVisible();
  await confirm.click();
  // Ждём, пока ход дойдёт до всех страниц, иначе следующий «чей ход» прочитается из устаревшего состояния
  for (const p of pages) await expect(usedHeroes(p)).toHaveCount(doneBefore + 1);
}

async function whoseTurn(pages) {
  for (let attempt = 0; attempt < 50; attempt++) {
    for (const p of pages) {
      if (await p.getByText('Твой ход!').isVisible()) return p;
    }
    await pages[0].waitForTimeout(100);
  }
  throw new Error('Ни у одного капитана не отображается «Твой ход!»');
}

test('fixed-серия: лобби → готовность → полный драфт → следующая игра', async ({ browser }) => {
  const A = await openHome(browser);
  const B = await openHome(browser);
  const S = await openHome(browser);
  const [a, b, s] = [A.page, B.page, S.page];

  // --- Создание лобби и ссылки-приглашения ---
  const roomId = await createLobby(a, 'Alpha');
  await a.getByRole('button', { name: /Ссылка для капитанов/ }).click();
  await expect(a.getByText('✓ Скопировано')).toBeVisible();
  const copied = await a.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`/?room=${roomId}&role=captain`);

  await joinByLink(b, roomId, 'captain', 'Bravo');
  await joinByLink(s, roomId, 'spectator', 'Viewer');

  await expect(a.getByText('👁️ Viewer')).toBeVisible();
  await expect(s.getByRole('button', { name: 'Занять Radiant' })).toHaveCount(0);
  await expect(s.locator('select').first()).toBeDisabled();

  // --- Выбор сторон ---
  await a.getByRole('button', { name: 'Занять Radiant' }).click();
  await b.getByRole('button', { name: 'Занять Radiant' }).click();
  await expect(b.getByText('Команда уже занята другим капитаном')).toBeVisible();
  await b.getByRole('button', { name: 'Занять Dire' }).click();
  for (const p of [a, b, s]) {
    await expect(p.getByText('Alpha', { exact: true })).toBeVisible();
    await expect(p.getByText('Bravo', { exact: true })).toBeVisible();
  }

  // --- Формат серии синхронизируется у всех ---
  await a.locator('select').nth(1).selectOption('3');
  await expect(s.locator('select').nth(1)).toHaveValue('3');
  await expect(b.locator('select').nth(1)).toHaveValue('3');

  // --- Подтверждение готовности ---
  await a.getByRole('button', { name: /Начать драфт/ }).click();
  for (const p of [a, b, s]) await expect(p.getByText('Подтверждение старта серии')).toBeVisible();
  await expect(s.getByText('Зрители ожидают подтверждения капитанов')).toBeVisible();
  await a.getByRole('button', { name: 'Подтвердить готовность' }).click();
  await expect(a.getByRole('button', { name: '✓ Ты подтвердил готовность' })).toBeDisabled();
  await expect(s.getByText('✓ Готов')).toHaveCount(1);
  await b.getByRole('button', { name: 'Подтвердить готовность' }).click();

  // --- Драфт ---
  for (const p of [a, b, s]) {
    await expect(p.getByRole('heading', { name: /ИГРА 1\s*\/3/ })).toBeVisible();
    await expect(heroButtons(p)).toHaveCount(28);
  }
  for (const label of ['СИЛА', 'ЛОВКОСТЬ', 'ИНТЕЛЛЕКТ', 'УНИВЕРСАЛ']) {
    await expect(s.getByText(new RegExp(`^${label}\\s*7$`))).toBeVisible();
  }
  await expect(s.getByRole('button', { name: /Пауза/ })).toHaveCount(0);
  await expect(s.locator('button[title]:not([disabled])')).toHaveCount(0);
  await expect(b.getByText('Ожидание хода противника...')).toBeVisible();

  for (let i = 0; i < 16; i++) {
    if (i === 2) {
      // Пауза блокирует выбор у всех и показывает, кто её поставил
      await b.getByRole('button', { name: '⏸ Пауза' }).click();
      for (const p of [a, b, s]) await expect(p.getByText('⏸ Драфт на паузе')).toBeVisible();
      await expect(s.getByText('— Bravo')).toBeVisible();
      await expect(a.locator('button[title]:not([disabled])')).toHaveCount(0);
      await a.getByRole('button', { name: '▶ Продолжить' }).click();
      for (const p of [a, b, s]) await expect(p.getByText('⏸ Драфт на паузе')).toHaveCount(0);
    }
    if (i === 7) {
      // Перезагрузка страницы капитана посреди драфта возвращает его на место
      await b.reload();
      await expect(b.getByRole('heading', { name: /ИГРА 1\s*\/3/ })).toBeVisible();
      await expect(usedHeroes(b)).toHaveCount(7);
    }
    const actor = await whoseTurn([a, b]);
    await makeMove(actor, [a, b, s], i);
  }

  for (const p of [a, b, s]) await expect(p.getByText('✅ Завершено')).toBeVisible();
  await expect(s.getByRole('button', { name: /Игра 2\/3/ })).toHaveCount(0);

  // --- Следующая игра ---
  await b.getByRole('button', { name: '▶ Игра 2/3' }).click();
  for (const p of [a, b, s]) await expect(p.getByText('Капитаны готовы к драфту?')).toBeVisible();
  await a.getByRole('button', { name: 'Подтвердить готовность' }).click();
  await b.getByRole('button', { name: 'Подтвердить готовность' }).click();
  await expect(s.getByRole('heading', { name: /ИГРА 2\s*\/3/ })).toBeVisible();
  await expect(usedHeroes(s)).toHaveCount(0);

  await Promise.all([A.context.close(), B.context.close(), S.context.close()]);
});

test('про-режим: жеребьёвка и выбор стороны/порядка через UI', async ({ browser }) => {
  const A = await openHome(browser);
  const B = await openHome(browser);
  const [a, b] = [A.page, B.page];

  const roomId = await createLobby(a, 'Alpha');
  await joinByLink(b, roomId, 'captain', 'Bravo');
  await a.getByRole('button', { name: 'Занять Radiant' }).click();
  await b.getByRole('button', { name: 'Занять Dire' }).click();
  await a.locator('select').first().selectOption('pro');
  await expect(b.getByText('Жеребьёвка на первой и решающей карте', { exact: false })).toBeVisible();

  await a.getByRole('button', { name: /Начать драфт/ }).click();
  await a.getByRole('button', { name: 'Подтвердить готовность' }).click();
  await b.getByRole('button', { name: 'Подтвердить готовность' }).click();

  for (const p of [a, b]) await expect(p.getByText('🪙 Жеребьёвка')).toBeVisible();
  const chooser = (await a.getByText('Твой выбор').isVisible()) ? a : b;
  const other = chooser === a ? b : a;
  await expect(other.getByText(/Ожидание выбора капитана/)).toBeVisible();

  // Победитель жребия берёт Radiant, второй капитан — first pick (→ он играет за Dire)
  await chooser.getByRole('button', { name: 'RADIANT' }).click();
  await expect(other.getByText('Первый выбор:')).toBeVisible();
  await expect(other.getByText('Radiant', { exact: true })).toBeVisible();
  await expect(other.getByRole('button', { name: 'RADIANT' })).toHaveCount(0);
  await other.getByRole('button', { name: 'FIRST PICK' }).click();

  for (const p of [a, b]) await expect(p.getByRole('heading', { name: /ИГРА 1\s*\/5/ })).toBeVisible();
  await expect(other.getByText('Твой ход!')).toBeVisible();
  await expect(chooser.getByText('Ожидание хода противника...')).toBeVisible();
  await expect(chooser.getByText('🔴 DIRE делает БАН')).toBeVisible();

  await Promise.all([A.context.close(), B.context.close()]);
});

test('домашний экран: валидация и ошибка входа в несуществующую комнату', async ({ browser }) => {
  const { context, page } = await openHome(browser);
  await page.goto('/');

  // alert() блокирует страницу — закрываем его из обработчика, иначе click не завершится
  const messages = [];
  page.once('dialog', d => { messages.push(d.message()); d.dismiss(); });
  await page.getByRole('button', { name: 'Создать лобби' }).click();
  await expect.poll(() => messages).toEqual(['Введи имя']);

  await page.getByPlaceholder('Введи свой никнейм').fill('Ghost');
  await page.getByPlaceholder('ID КОМНАТЫ').fill('nope00');
  await expect(page.getByPlaceholder('ID КОМНАТЫ')).toHaveValue('NOPE00');
  await page.getByRole('button', { name: 'Вход' }).click();
  await expect(page.getByText('Комната не найдена')).toBeVisible();
  // Ошибка автоматически исчезает
  await expect(page.getByText('Комната не найдена')).toHaveCount(0, { timeout: 6000 });

  await context.close();
});

test('автовход по ссылке с сохранённым именем', async ({ browser }) => {
  const A = await openHome(browser);
  const roomId = await createLobby(A.page, 'Host');

  const { context, page } = await openHome(browser);
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('playerName', 'Returning'));
  await page.goto(`/?room=${roomId}&role=spectator`);
  await expect(page.getByRole('heading', { name: `Лобби #${roomId}` })).toBeVisible();
  await expect(A.page.getByText('👁️ Returning')).toBeVisible();

  await Promise.all([A.context.close(), context.close()]);
});
