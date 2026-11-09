# CLAUDE.md

Drafter — многопользовательский симулятор **Captains Draft для Dota 2** в реальном времени. Два капитана (Radiant/Dire) по очереди банят и пикают героев из случайного пула, зрители смотрят онлайн. Поддерживаются серии BO3/BO5 в двух режимах сторон. Весь UI и сообщения об ошибках — на русском.

## Стек

- **Backend** (`server/`, CommonJS, Node 20): Express 4 + Socket.IO 4. Состояние хранится только **в памяти** (`Map` комнат) — БД нет, перезапуск сервера теряет все комнаты.
- **Frontend** (`client/`, ESM): React 19 + Vite 8 + Tailwind 3, `socket.io-client`, `axios`. Весь UI — один компонент `client/src/App.jsx`.
- **Герои**: OpenDota API (`https://api.opendota.com/api/heroes`), без ключа; картинки — Steam CDN по `shortName`.
- **Деплой**: `docker compose` — `backend` (node:20-alpine) → `frontend` (nginx отдаёт статику и проксирует `/api` и `/socket.io` на backend) → `caddy` (HTTPS по IP с `tls internal`, внешний порт `HTTPS_PORT`, по умолчанию 4443, т.к. 80/443 на сервере заняты Nextcloud).

Зависимости разнесены: корневой `package.json` — сервер (+ devDeps для e2e), `client/package.json` — фронтенд. `server/Dockerfile` собирается из корня репозитория и ставит корневые deps с `--omit=dev`.

## Команды

```bash
npm install && (cd client && npm install)
npm run server                 # backend на :3001 (nodemon)
cd client && npm run dev       # Vite на :5173, проксирует /api и /socket.io на BACKEND_URL (по умолч. http://localhost:3001)
cd client && npm run lint      # ESLint
cd client && npm run build     # прод-сборка в client/dist (в git не коммитится)

npm run test:e2e:api           # e2e backend: REST + Socket.IO на реальном процессе сервера (~10 с)
npm run test:e2e:browser       # e2e в браузере: Playwright + системный Google Chrome (~1.5 мин)
npm run test:e2e               # оба набора

PUBLIC_IP=<ip> HTTPS_PORT=4443 docker compose up -d --build   # прод
```

Варианты браузерных e2e:
- `E2E_REAL_HEROES=1` — герои из настоящего OpenDota вместо мока;
- `E2E_BASE_URL=https://127.0.0.1:14443` — против уже поднятого стека (например, `PUBLIC_IP=127.0.0.1 HTTPS_PORT=14443 docker compose up -d`), без запуска своих серверов;
- `HEADED=1` — видимое окно браузера; `E2E_BROWSER_CHANNEL` — другой канал Chrome.

Отчёты Playwright: `e2e/report`, артефакты падений (скриншоты, trace): `e2e/test-results` — оба в `.gitignore`.

## Переменные окружения сервера

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | 3001 | порт backend |
| `HEROES_URL` | OpenDota `/api/heroes` | источник героев (в тестах — мок) |
| `DRAFT_MAIN_TIME` | 30 | основное время на ход, «секунд» |
| `DRAFT_EXTRA_TIME` | 120 | запас доп. времени на команду за игру |
| `DRAFT_TICK_MS` | 1000 | длина «секунды» таймера (тесты ускоряют) |
| `ROOM_TTL_EMPTY_MS` | 600000 | через сколько удаляется комната без онлайн-игроков |

## Архитектура backend

- `server/dota-api.js` — `fetchHeroes()`: кэш 12 ч, дедупликация параллельных запросов (`inFlight`), при ошибке API отдаёт устаревший кэш; нормализует `primary_attr` в `str|agi|int|uni` (`all`/`universal`/прочее → `uni`). `generatePool(heroes, excludedIds)` — 28 героев: по 7 случайных на атрибут, исключая уже пикнутых в серии.
- `server/room-manager.js` — вся игровая логика (чистые функции над объектом комнаты, возвращают `{ ok }` или `{ error }`): серия, ready-check, про-выбор, таймеры, ходы, авто-ход, TTL-очистка.
- `server/index.js` — HTTP-эндпоинты и Socket.IO-обработчики; проверка прав, обёртка `on()` ловит исключения обработчиков, `asObject()` защищает от мусорных payload. Наружу состояние отдаётся только через `publicState()`, который **вырезает `clientId`**.

### Модель комнаты

```
room = { id, players[], allHeroes, createdAt, broadcastState(),
  series: { currentGame, totalGames: 3|5, mode: 'fixed'|'pro', pickedInSeries[],
            openingCoinWinnerSquad, readyCheck, selection },
  current: { gameNumber, pool[28], bans:[[],[]], picks:[[],[]], draftHistory[], draftOrder[16],
             firstPickTeam, setup, draftStep, finished, paused, pausedBySquad,
             timers: { 0:{main,extra}, 1:{main,extra} } } }
player = { id: socket.id, clientId, name, role: 'captain'|'spectator', squad, team, online }
```

**`squad` vs `team` — ключевое различие:** `squad` (0/1) — постоянный слот капитана, выбранный в лобби («Занять Radiant/Dire»); `team` (0 = Radiant, 1 = Dire) — сторона в текущей игре. В режиме `fixed` они совпадают всю серию; в режиме `pro` `team` переназначается перед каждой игрой. Ходы драфта (`draftOrder[].team`, `bans/picks/timers[team]`) индексируются по **team (стороне)**; ready-check, право выбора и пауза — по **squad**.

### Жизненный цикл серии

1. **Лобби**: `join` → капитаны `assignTeam` (ставит `squad` и `team`), любой капитан `configureSeries` (mode, BO3/BO5). После старта менять нельзя.
2. `startGame` (нужны капитаны с squad 0 и 1) → `beginNextGame` создаёт `series.readyCheck`.
3. Оба капитана `confirmReady` (отключение капитана снимает его подтверждение).
4. `fixed` → сразу `startNewGame(room, 0)` — first pick всегда у Radiant. `pro` → `series.selection`: на 1-й и последней игре жеребьёвка (случайный `chooserSquad`), между ними выбор чередуется: проигравший жребий, победитель, проигравший… Выбирающий берёт одно из `side`/`pickOrder` (`setupChoice`, stage `primary`), второй капитан — оставшееся (stage `secondary`); затем выставляются `team` капитанов и стартует драфт.
5. **Драфт** — 16 шагов `DRAFT_ORDER` (0 = команда с first pick): 6 банов поочерёдно, затем пики `0,1,1,0,0,1,1,0,0,1`. Таймер: тикает `main`, затем `extra`; после хода `main` сбрасывается, `extra` расходуется на всю игру. По истечении обоих — `performAutoAction` (случайный свободный герой из пула). Пауза (`togglePause`) замораживает таймер и ходы.
6. После 16 шагов `finished = true`, `currentGame++`; капитан жмёт `nextGame` → снова ready-check. Пикнутые за серию герои не попадают в будущие пулы. После последней игры `nextGame` → «Серия завершена!».

### Socket.IO протокол

Клиент → сервер: `join {roomId, playerName, role, clientId}`, `assignTeam {team}`, `configureSeries {mode, totalGames}`, `startGame`, `confirmReady`, `setupChoice {category: 'side'|'pickOrder', value: 0|1|'first'|'last'}`, `draftAction {heroId, actionType: 'ban'|'pick'}`, `togglePause`, `nextGame`.
Сервер → клиент: `state {players, series, current}` (broadcast в комнату после каждого изменения и каждый тик таймера), `error {msg}` (только отправителю).

REST: `POST /api/rooms` → `{roomId}` (502, если герои не загрузились); `GET /api/rooms/:id` → публичное состояние (ID регистронезависимый).

### Переподключение

Клиент хранит `clientId` в `sessionStorage` (на вкладку). Капитан, занявший сторону, при отключении остаётся в комнате с `online: false`; повторный `join` с тем же `clientId` возвращает его на место (роль из ссылки игнорируется). Капитаны без стороны и зрители при отключении удаляются. Комната без онлайн-игроков удаляется через `ROOM_TTL_EMPTY_MS`.
**`clientId` — секрет**, наличие которого даёт место капитана: никогда не отдавать его в `state`/REST (есть e2e-тест на это).

## Frontend (`client/src/App.jsx`)

Экран выбирается из пришедшего `state`: `series.readyCheck` → `ready`, `series.selection` → `setup`, `current` → `draft`, иначе `lobby`; до входа — `home`. Ссылки-приглашения `/?room=ID&role=captain|spectator`; имя и роль кэшируются в `localStorage`, при наличии имени вход по ссылке автоматический. При reconnect сокета клиент повторяет последний `join`. Выбор героя — двухшаговый (клик по герою → «Забанить/Пикнуть»), выделение сбрасывается при смене шага. `navigator.clipboard` работает только в secure context — есть fallback через `execCommand`.

## E2E-тесты (`e2e/`)

- `helpers.js` — мок OpenDota (100 героев: по 25 на `str/agi/int/all` + мусорная запись), запуск `server/index.js` дочерним процессом на свободном порту, класс `Client` (socket.io-клиент с `waitState`/`expectError`).
- `api/draft.test.js` — `node:test`: REST, вход/нормализация, утечка `clientId`, мусорные payload, лобби, ready-check, полный драфт, BO3 fixed, про-режим BO3/BO5 (чередование права выбора), пауза, таймер и авто-ход (ускоренный сервер), переподключение, TTL, недоступность OpenDota.
- `browser/draft.spec.js` — Playwright: 2 капитана + зритель в отдельных контекстах; создание лобби и копирование ссылки, стороны, формат, ready-check, полный драфт через UI с паузой и перезагрузкой страницы капитана, следующая игра, про-режим, валидация домашнего экрана, автовход.
- `mock-heroes-server.js` — мок OpenDota для Playwright `webServer`. Порты браузерного стека: мок 4599, backend 3199, Vite 5199.

Подводные камни тестов: broadcast доходит до разных сокетов не одновременно — перед чтением состояния другого клиента дожидайтесь его синхронизации (`bothSynced`, проверка на всех страницах после каждого хода), иначе тесты флакают. `alert()` в UI блокирует клик — обработчик `dialog` нужно вешать до клика.

## Соглашения

- Комментарии, сообщения об ошибках и UI-тексты — на русском; e2e-тесты сверяют точные тексты ошибок, при их изменении обновляйте тесты.
- Логика игры — в `room-manager.js` (функции возвращают `{error}`), проверка ролей и broadcast — в `index.js`.
- Любое изменение состояния завершается `room.broadcastState()`.

## Известные ограничения

- Состояние только в памяти, один инстанс (горизонтально не масштабируется).
- `firstPickTeam` в режиме `fixed` всегда Radiant.
- Нет отдельного экрана «серия завершена» — остаётся экран последнего драфта.
- Захват места по `clientId` не проверяет, онлайн ли владелец (безопасно, пока `clientId` не утекает).
- `cors({ origin: '*' })` для REST и Socket.IO.
