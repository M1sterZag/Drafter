import { useState, useEffect, useRef } from 'react';
import { socket } from './socket';
import axios from 'axios';

const ATTR_CONFIG = {
  str: { label: 'СИЛА', color: 'text-red-500', bg: 'bg-red-500/10', border: 'border-red-500/30' },
  agi: { label: 'ЛОВКОСТЬ', color: 'text-green-500', bg: 'bg-green-500/10', border: 'border-green-500/30' },
  int: { label: 'ИНТЕЛЛЕКТ', color: 'text-blue-500', bg: 'bg-blue-500/10', border: 'border-blue-500/30' },
  uni: { label: 'УНИВЕРСАЛ', color: 'text-purple-500', bg: 'bg-purple-500/10', border: 'border-purple-500/30' }
};

// Постоянный (на время жизни вкладки) идентификатор клиента —
// по нему сервер возвращает капитана на его место после перезагрузки страницы
function getClientId() {
  try {
    let id = sessionStorage.getItem('clientId');
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('clientId', id);
    }
    return id;
  } catch {
    return null;
  }
}

function copyToClipboard(text) {
  // navigator.clipboard доступен только в secure context (https / localhost)
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
  return Promise.resolve();
}

// Начальные данные из URL и localStorage (читаются один раз при загрузке)
function readInitialParams() {
  const params = new URLSearchParams(window.location.search);
  const urlRoom = params.get('room')?.trim().toUpperCase() || '';
  const urlRole = params.get('role');
  let savedName = '';
  let savedRole = null;
  try {
    savedName = localStorage.getItem('playerName') || '';
    savedRole = localStorage.getItem('playerRole');
  } catch { /* localStorage недоступен */ }

  // Роль из ссылки важнее сохранённой: ссылка зрителя не должна делать тебя капитаном
  const isRole = (r) => r === 'spectator' || r === 'captain';
  const role = isRole(urlRole) ? urlRole : isRole(savedRole) ? savedRole : null;

  return { urlRoom, savedName, role };
}

export default function App() {
  const [initial] = useState(readInitialParams);
  const [screen, setScreen] = useState('home');
  const [roomId, setRoomId] = useState(initial.urlRoom);
  const [playerName, setPlayerName] = useState(initial.savedName);
  const [role, setRole] = useState(initial.role || 'captain');
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [selectedHero, setSelectedHero] = useState(null);
  // Параметры последнего входа в комнату — для повторного входа после переподключения сокета
  const joinParamsRef = useRef(null);

  const joinSocketRoom = (params) => {
    joinParamsRef.current = { ...params, clientId: getClientId() };
    socket.emit('join', joinParamsRef.current);
  };

  // Шаг драфта из последнего состояния — чтобы сбрасывать выбор героя при смене хода
  const lastStepKeyRef = useRef(null);

  useEffect(() => {
    const onState = (s) => {
      // Ход перешёл дальше (в т.ч. по таймеру) — сбрасываем выбранного героя
      const stepKey = s.current ? `${s.current.gameNumber}:${s.current.draftStep}` : null;
      if (stepKey !== lastStepKeyRef.current) {
        lastStepKeyRef.current = stepKey;
        setSelectedHero(null);
      }
      setState(s);
      if (s.series?.readyCheck) setScreen('ready');
      else if (s.series?.selection) setScreen('setup');
      else if (s.current) setScreen('draft');
      else if (s.players?.length) setScreen('lobby');
    };
    const onError = (e) => {
      console.error('Socket error:', e);
      setError(e?.msg || 'Ошибка');
    };
    const onConnect = () => {
      // После переподключения сервер видит новый socket.id — входим в комнату заново
      if (joinParamsRef.current) socket.emit('join', joinParamsRef.current);
    };

    socket.on('state', onState);
    socket.on('error', onError);
    socket.on('connect', onConnect);
    return () => {
      socket.off('state', onState);
      socket.off('error', onError);
      socket.off('connect', onConnect);
    };
  }, []);

  // Автовход по ссылке, если имя уже сохранено
  useEffect(() => {
    const { urlRoom, savedName, role: initialRole } = initial;
    if (urlRoom && savedName && !joinParamsRef.current) {
      joinParamsRef.current = { roomId: urlRoom, playerName: savedName, role: initialRole || 'spectator', clientId: getClientId() };
      socket.emit('join', joinParamsRef.current);
    }
  }, [initial]);

  // Ошибка исчезает через несколько секунд, а не висит навсегда
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(''), 4000);
    return () => clearTimeout(t);
  }, [error]);

  const createRoom = async () => {
    if (!playerName.trim()) return alert('Введи имя');
    try {
      const { data } = await axios.post('/api/rooms');
      const newRoomId = data.roomId;
      setRoomId(newRoomId);

      localStorage.setItem('playerName', playerName);
      localStorage.setItem('playerRole', role);

      const newUrl = `${window.location.origin}/?room=${newRoomId}&role=${role}`;
      window.history.replaceState({}, '', newUrl);

      joinSocketRoom({ roomId: newRoomId, playerName, role });
    } catch (e) {
      console.error(e);
      alert('Ошибка создания комнаты.');
    }
  };

  const joinRoom = () => {
    if (!playerName.trim() || !roomId.trim()) return alert('Заполни имя и ID комнаты');
    const normalizedRoomId = roomId.trim().toUpperCase();
    localStorage.setItem('playerName', playerName);
    localStorage.setItem('playerRole', role);

    const newUrl = `${window.location.origin}/?room=${normalizedRoomId}&role=${role}`;
    window.history.replaceState({}, '', newUrl);

    joinSocketRoom({ roomId: normalizedRoomId, playerName, role });
  };

  const selectHero = (heroId) => {
    setSelectedHero(heroId);
  };

  const confirmAction = () => {
    if (!selectedHero || !state?.current) return;
    const step = state.current.draftOrder[state.current.draftStep];
    if (!step) return;
    socket.emit('draftAction', { heroId: selectedHero, actionType: step.action });
    setSelectedHero(null);
  };

  const copyLink = (linkRole) => {
    const link = `${window.location.origin}/?room=${roomId}&role=${linkRole}`;
    copyToClipboard(link)
      .then(() => {
        setCopied(linkRole);
        setTimeout(() => setCopied(''), 2000);
      })
      .catch(() => setError('Не удалось скопировать ссылку'));
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // --- HOME SCREEN ---
  if (screen === 'home') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass-panel p-8 rounded-2xl w-full max-w-md space-y-6 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-yellow-500 to-transparent opacity-50" />
          
          <div className="text-center space-y-2">
            <h1 className="text-4xl esports-title font-bold text-white tracking-widest">Captains Draft</h1>
            <p className="text-zinc-400 text-sm uppercase tracking-wider">Профессиональный симулятор драфта</p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="text-xs text-zinc-500 uppercase font-bold ml-1">Имя игрока</label>
              <input
                placeholder="Введи свой никнейм"
                value={playerName}
                onChange={e => setPlayerName(e.target.value)}
                className="w-full mt-1 p-3 rounded-lg bg-zinc-900/80 border border-zinc-700 text-white outline-none focus:border-yellow-500/50 transition-all"
              />
            </div>
            
            <div>
              <label className="text-xs text-zinc-500 uppercase font-bold ml-1">Роль</label>
              <select
                value={role}
                onChange={e => setRole(e.target.value)}
                className="w-full mt-1 p-3 rounded-lg bg-zinc-900/80 border border-zinc-700 text-white outline-none focus:border-yellow-500/50 transition-all appearance-none"
              >
                <option value="captain">👑 Капитан команды</option>
                <option value="spectator">👁️ Зритель / Аналитик</option>
              </select>
            </div>

            <button
              onClick={createRoom}
              className="w-full bg-gradient-to-r from-yellow-600 to-yellow-500 hover:from-yellow-500 hover:to-yellow-400 text-black font-bold p-3 rounded-lg transition-all uppercase tracking-wider esports-title"
            >
              Создать лобби
            </button>

            <div className="relative flex py-2 items-center">
              <div className="flex-grow border-t border-zinc-700"></div>
              <span className="flex-shrink-0 mx-4 text-zinc-500 text-xs uppercase">или присоединиться</span>
              <div className="flex-grow border-t border-zinc-700"></div>
            </div>

            <div className="flex gap-2">
              <input
                placeholder="ID КОМНАТЫ"
                value={roomId}
                onChange={e => setRoomId(e.target.value.toUpperCase())}
                className="flex-1 p-3 rounded-lg bg-zinc-900/80 border border-zinc-700 text-white outline-none focus:border-blue-500/50 transition-all uppercase font-mono tracking-widest"
              />
              <button
                onClick={joinRoom}
                className="bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 px-5 rounded-lg font-bold transition-all uppercase text-sm"
              >
                Вход
              </button>
            </div>
          </div>
          {error && <p className="text-red-400 text-sm text-center bg-red-900/20 p-2 rounded border border-red-500/30">{error}</p>}
        </div>
      </div>
    );
  }

  // --- CAPTAINS READY CHECK ---
  if (screen === 'ready' && state?.series?.readyCheck) {
    const readyCheck = state.series.readyCheck;
    const captains = state.players
      .filter(p => p.role === 'captain' && (p.squad === 0 || p.squad === 1))
      .sort((a, b) => a.squad - b.squad);
    const currentPlayer = state.players.find(p => p.id === socket.id);
    const isCaptain = currentPlayer?.role === 'captain';
    const isReady = isCaptain && readyCheck.confirmedSquads.includes(currentPlayer.squad);

    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass-panel p-8 rounded-2xl w-full max-w-2xl space-y-6">
          <div className="text-center">
            <div className="text-sm uppercase tracking-widest text-yellow-500 font-bold">
              Игра {readyCheck.gameNumber}/{state.series.totalGames}
            </div>
            <h1 className="text-3xl esports-title font-bold text-white mt-2">
              {readyCheck.gameNumber === 1 ? 'Подтверждение старта серии' : 'Капитаны готовы к драфту?'}
            </h1>
            <p className="text-zinc-400 mt-2">Продолжим после подтверждения обоих капитанов</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {captains.map(captain => {
              const confirmed = readyCheck.confirmedSquads.includes(captain.squad);
              return (
                <div key={captain.squad} className={`p-5 rounded-xl border text-center ${
                  confirmed
                    ? 'border-emerald-500 bg-emerald-900/20'
                    : 'border-zinc-700 bg-zinc-900/60'
                }`}>
                  <div className="font-bold text-white">{captain.name}</div>
                  <div className={`mt-2 text-sm uppercase font-bold ${confirmed ? 'text-emerald-400' : 'text-zinc-500'}`}>
                    {confirmed ? '✓ Готов' : 'Ожидание'}
                  </div>
                </div>
              );
            })}
          </div>

          {isCaptain ? (
            <button
              onClick={() => socket.emit('confirmReady')}
              disabled={isReady}
              className="w-full py-4 rounded-xl bg-gradient-to-r from-yellow-600 to-yellow-500 disabled:from-zinc-700 disabled:to-zinc-700 disabled:text-zinc-400 text-black font-bold uppercase tracking-wider esports-title transition-all"
            >
              {isReady ? '✓ Ты подтвердил готовность' : 'Подтвердить готовность'}
            </button>
          ) : (
            <p className="text-center text-zinc-500">Зрители ожидают подтверждения капитанов</p>
          )}
        </div>
      </div>
    );
  }

  // --- PRO SERIES SETUP ---
  if (screen === 'setup' && state?.series?.selection) {
    const selection = state.series.selection;
    const captains = state.players.filter(p => p.role === 'captain');
    const currentPlayer = state.players.find(p => p.id === socket.id);
    const expectedSquad = selection.stage === 'primary'
      ? selection.chooserSquad
      : 1 - selection.chooserSquad;
    const chooser = captains.find(p => p.squad === selection.chooserSquad);
    const expectedCaptain = captains.find(p => p.squad === expectedSquad);
    const myTurn = currentPlayer?.role === 'captain' && currentPlayer.squad === expectedSquad;
    const remainingCategory = selection.primaryCategory === 'side' ? 'pickOrder' : 'side';
    const sendChoice = (category, value) => socket.emit('setupChoice', { category, value });
    const describeChoice = () => {
      if (selection.primaryCategory === 'side') return selection.primaryValue === 0 ? 'Radiant' : 'Dire';
      return selection.primaryValue === 'first' ? 'First Pick' : 'Last Pick';
    };

    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass-panel p-8 rounded-2xl w-full max-w-3xl space-y-6">
          <div className="text-center">
            <div className="text-sm uppercase tracking-widest text-yellow-500 font-bold">
              Игра {selection.gameNumber}/{state.series.totalGames}
            </div>
            <h1 className="text-3xl esports-title font-bold text-white mt-2">
              {selection.isCoinToss ? '🪙 Жеребьёвка' : 'Право выбора переходит другой команде'}
            </h1>
            <p className="text-zinc-400 mt-2">
              Первым выбирает <span className="text-white font-bold">{chooser?.name || 'капитан'}</span>
            </p>
          </div>

          {selection.stage === 'secondary' && (
            <div className="bg-zinc-900/70 border border-zinc-700 rounded-xl p-4 text-center">
              <span className="text-zinc-400">Первый выбор: </span>
              <span className="text-yellow-400 font-bold">{describeChoice()}</span>
            </div>
          )}

          {myTurn ? (
            <div className="space-y-5">
              <p className="text-center text-white font-bold uppercase tracking-wider">Твой выбор</p>

              {(selection.stage === 'primary' || remainingCategory === 'side') && (
                <div>
                  <div className="text-xs text-zinc-500 uppercase font-bold mb-2">Выбрать сторону</div>
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={() => sendChoice('side', 0)} className="p-4 rounded-xl border border-emerald-500/50 bg-emerald-900/20 text-emerald-400 font-bold hover:bg-emerald-500 hover:text-black transition-all">RADIANT</button>
                    <button onClick={() => sendChoice('side', 1)} className="p-4 rounded-xl border border-red-500/50 bg-red-900/20 text-red-400 font-bold hover:bg-red-500 hover:text-black transition-all">DIRE</button>
                  </div>
                </div>
              )}

              {(selection.stage === 'primary' || remainingCategory === 'pickOrder') && (
                <div>
                  <div className="text-xs text-zinc-500 uppercase font-bold mb-2">Выбрать порядок драфта</div>
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={() => sendChoice('pickOrder', 'first')} className="p-4 rounded-xl border border-yellow-500/50 bg-yellow-900/20 text-yellow-400 font-bold hover:bg-yellow-500 hover:text-black transition-all">FIRST PICK</button>
                    <button onClick={() => sendChoice('pickOrder', 'last')} className="p-4 rounded-xl border border-blue-500/50 bg-blue-900/20 text-blue-400 font-bold hover:bg-blue-500 hover:text-white transition-all">LAST PICK</button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-8">
              <div className="w-10 h-10 mx-auto border-4 border-yellow-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-zinc-400 mt-4">Ожидание выбора капитана <span className="text-white font-bold">{expectedCaptain?.name || ''}</span></p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- LOBBY ---
  if (screen === 'lobby' && state) {
    const captains = state.players.filter(p => p.role === 'captain');
    const spectators = state.players.filter(p => p.role === 'spectator');
    const myPlayer = state.players.find(p => p.id === socket.id);

    return (
      <div className="min-h-screen p-6 max-w-5xl mx-auto">
        <div className="glass-panel p-6 rounded-2xl mb-6">
          <div className="flex justify-between items-start flex-wrap gap-4">
            <div>
              <h1 className="text-3xl esports-title font-bold text-white">Лобби <span className="text-yellow-500">#{roomId}</span></h1>
              <p className="text-zinc-400 text-sm mt-1">Пригласи друзей по ссылкам ниже</p>
            </div>
            <div className="text-right">
              <div className="text-xs text-zinc-500 uppercase font-bold">Игроков в лобби</div>
              <div className="text-2xl font-bold text-white">{state.players.length}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-6">
            <button
              onClick={() => copyLink('captain')}
              className="flex items-center justify-between bg-gradient-to-r from-yellow-600/20 to-yellow-500/10 border border-yellow-500/40 hover:border-yellow-500 px-4 py-3 rounded-lg transition-all"
            >
              <div className="flex items-center gap-3">
                <span className="text-2xl">👑</span>
                <div className="text-left">
                  <div className="font-bold text-yellow-400 uppercase text-sm tracking-wider">Ссылка для капитанов</div>
                  <div className="text-xs text-zinc-400">Могут выбирать команду и делать пики/баны</div>
                </div>
              </div>
              <span className={`px-3 py-1 rounded text-xs font-bold uppercase ${copied === 'captain' ? 'bg-green-500 text-white' : 'bg-yellow-500/20 text-yellow-400'}`}>
                {copied === 'captain' ? '✓ Скопировано' : 'Копировать'}
              </span>
            </button>

            <button
              onClick={() => copyLink('spectator')}
              className="flex items-center justify-between bg-gradient-to-r from-blue-600/20 to-blue-500/10 border border-blue-500/40 hover:border-blue-500 px-4 py-3 rounded-lg transition-all"
            >
              <div className="flex items-center gap-3">
                <span className="text-2xl">👁️</span>
                <div className="text-left">
                  <div className="font-bold text-blue-400 uppercase text-sm tracking-wider">Ссылка для зрителей</div>
                  <div className="text-xs text-zinc-400">Только просмотр драфта в реальном времени</div>
                </div>
              </div>
              <span className={`px-3 py-1 rounded text-xs font-bold uppercase ${copied === 'spectator' ? 'bg-green-500 text-white' : 'bg-blue-500/20 text-blue-400'}`}>
                {copied === 'spectator' ? '✓ Скопировано' : 'Копировать'}
              </span>
            </button>
          </div>
        </div>

        <div className="glass-panel p-6 rounded-2xl mb-6">
          <h2 className="text-lg esports-title font-bold text-white mb-4">Формат серии</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-zinc-500 uppercase font-bold">Режим сторон и пиков</label>
              <select
                value={state.series.mode}
                disabled={myPlayer?.role !== 'captain'}
                onChange={e => socket.emit('configureSeries', { mode: e.target.value, totalGames: state.series.totalGames })}
                className="w-full mt-1 p-3 rounded-lg bg-zinc-900/80 border border-zinc-700 text-white disabled:opacity-60"
              >
                <option value="fixed">Оставить на всю серию</option>
                <option value="pro">Про-сцена: жеребьёвка и выбор</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-zinc-500 uppercase font-bold">Количество игр</label>
              <select
                value={state.series.totalGames}
                disabled={myPlayer?.role !== 'captain'}
                onChange={e => socket.emit('configureSeries', { mode: state.series.mode, totalGames: Number(e.target.value) })}
                className="w-full mt-1 p-3 rounded-lg bg-zinc-900/80 border border-zinc-700 text-white disabled:opacity-60"
              >
                <option value={3}>BO3</option>
                <option value={5}>BO5</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-zinc-500 mt-3">
            {state.series.mode === 'fixed'
              ? 'Текущие стороны и порядок пиков сохранятся на всю серию.'
              : 'Жеребьёвка на первой и решающей карте. Между ними право первого выбора чередуется.'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-6 mb-8">
          <div className="glass-panel p-6 rounded-2xl border-l-4 border-l-emerald-500 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-3xl -mr-10 -mt-10" />
            <h2 className="text-2xl esports-title font-bold text-emerald-400 mb-4 flex items-center gap-2">
              <span className="w-3 h-3 bg-emerald-500 rounded-full animate-pulse" /> RADIANT
            </h2>
            {captains.filter(c => c.team === 0).length === 0
              ? <p className="text-zinc-600 italic">Ожидание капитана...</p>
              : captains.filter(c => c.team === 0).map(c => (
                  <div key={c.id} className="flex items-center gap-3 bg-zinc-900/50 p-3 rounded-lg border border-zinc-800">
                    <span className="text-xl">👑</span>
                    <span className="font-bold text-white">{c.name}</span>
                    {c.id === myPlayer?.id && <span className="ml-auto text-xs bg-emerald-500/20 text-emerald-400 px-2 py-1 rounded">ТЫ</span>}
                  </div>
                ))}
          </div>

          <div className="glass-panel p-6 rounded-2xl border-l-4 border-l-red-500 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-red-500/10 rounded-full blur-3xl -mr-10 -mt-10" />
            <h2 className="text-2xl esports-title font-bold text-red-400 mb-4 flex items-center gap-2">
              <span className="w-3 h-3 bg-red-500 rounded-full animate-pulse" /> DIRE
            </h2>
            {captains.filter(c => c.team === 1).length === 0
              ? <p className="text-zinc-600 italic">Ожидание капитана...</p>
              : captains.filter(c => c.team === 1).map(c => (
                  <div key={c.id} className="flex items-center gap-3 bg-zinc-900/50 p-3 rounded-lg border border-zinc-800">
                    <span className="text-xl">👑</span>
                    <span className="font-bold text-white">{c.name}</span>
                    {c.id === myPlayer?.id && <span className="ml-auto text-xs bg-red-500/20 text-red-400 px-2 py-1 rounded">ТЫ</span>}
                  </div>
                ))}
          </div>
        </div>

        {myPlayer?.role === 'captain' && (
          <div className="glass-panel p-6 rounded-2xl flex flex-wrap gap-4 justify-center">
            <button
              onClick={() => socket.emit('assignTeam', { team: 0 })}
              className="px-8 py-3 rounded-lg bg-emerald-900/30 border border-emerald-500/50 text-emerald-400 font-bold hover:bg-emerald-500 hover:text-black transition-all uppercase tracking-wider"
            >
              Занять Radiant
            </button>
            <button
              onClick={() => socket.emit('assignTeam', { team: 1 })}
              className="px-8 py-3 rounded-lg bg-red-900/30 border border-red-500/50 text-red-400 font-bold hover:bg-red-500 hover:text-black transition-all uppercase tracking-wider"
            >
              Занять Dire
            </button>
            <button
              onClick={() => socket.emit('startGame')}
              className="px-8 py-3 rounded-lg bg-gradient-to-r from-yellow-600 to-yellow-500 text-black font-bold hover:from-yellow-500 hover:to-yellow-400 transition-all shadow-[0_0_20px_rgba(234,179,8,0.3)] uppercase tracking-wider esports-title text-lg"
            >
              ▶ Начать драфт
            </button>
          </div>
        )}

        {spectators.length > 0 && (
          <div className="mt-6 text-center">
            <p className="text-zinc-500 text-sm uppercase tracking-wider mb-2">Зрители в лобби</p>
            <div className="flex flex-wrap justify-center gap-2">
              {spectators.map(s => (
                <span key={s.id} className="bg-zinc-800/50 text-zinc-300 px-3 py-1 rounded-full text-sm border border-zinc-700">
                  👁️ {s.name}
                </span>
              ))}
            </div>
          </div>
        )}
        {error && <p className="text-red-400 mt-4 text-center bg-red-900/20 p-2 rounded">{error}</p>}
      </div>
    );
  }

  // --- DRAFT SCREEN ---
  if (screen === 'draft' && state?.current) {
    const { pool, bans, picks, draftStep, gameNumber, finished, paused, pausedBySquad, timers, draftHistory, draftOrder } = state.current;
    const currentPlayer = state.players.find(p => p.id === socket.id);
    const isCaptain = currentPlayer?.role === 'captain';
    const myTeam = currentPlayer?.team;
    const step = draftOrder[draftStep];
    const canAct = isCaptain && step && myTeam === step.team && !finished && !paused;
    const pausedBy = state.players.find(p => p.role === 'captain' && p.squad === pausedBySquad);

    const byAttr = { str: [], agi: [], int: [], uni: [] };
    pool.forEach(h => {
      const attr = h.primaryAttr?.toLowerCase();
      if (byAttr[attr]) byAttr[attr].push(h);
    });

    const usedIds = [...bans[0], ...bans[1], ...picks[0], ...picks[1]];

    const selectedHeroData = selectedHero ? pool.find(h => h.id === selectedHero) : null;

    return (
      <div className="h-screen flex flex-col p-2 overflow-hidden bg-zinc-950">
        {/* Header */}
        <div className="glass-panel p-2 rounded-xl mb-2 flex justify-between items-center flex-shrink-0">
          <div>
            <h1 className="text-lg esports-title font-bold text-white">ИГРА <span className="text-yellow-500">{gameNumber}</span>/{state.series.totalGames}</h1>
          </div>

          {isCaptain && !finished && (
            <button
              onClick={() => socket.emit('togglePause')}
              className={`px-4 py-2 rounded-lg border font-bold uppercase tracking-wider text-xs transition-all ${
                paused
                  ? 'border-emerald-500 bg-emerald-900/30 text-emerald-400 hover:bg-emerald-500 hover:text-black'
                  : 'border-yellow-500/50 bg-yellow-900/20 text-yellow-400 hover:bg-yellow-500 hover:text-black'
              }`}
            >
              {paused ? '▶ Продолжить' : '⏸ Пауза'}
            </button>
          )}
          
          {!finished && step && (
            <div className={`px-4 py-1.5 rounded-lg font-bold esports-title flex items-center gap-2 ${
              step.team === 0 ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-500/50' : 'bg-red-900/40 text-red-400 border border-red-500/50'
            }`}>
              <span className="text-2xl font-mono">
                {formatTime(timers[step.team].main > 0 ? timers[step.team].main : timers[step.team].extra)}
              </span>
              <div className="text-xs">
                <div>{step.team === 0 ? 'RADIANT' : 'DIRE'}</div>
                <div className="opacity-70">{step.action === 'ban' ? 'БАН' : 'ВЫБОР'}</div>
              </div>
            </div>
          )}

          {finished && (
            <div className="px-4 py-1.5 rounded-lg bg-zinc-700 text-zinc-300 font-bold uppercase tracking-wider esports-title text-sm">
              ✅ Завершено
            </div>
          )}
        </div>

        {paused && (
          <div className="mb-2 rounded-xl border border-yellow-500/60 bg-yellow-950/80 px-4 py-2 text-center flex-shrink-0">
            <span className="text-yellow-400 font-bold uppercase tracking-widest">⏸ Драфт на паузе</span>
            {pausedBy && <span className="text-zinc-400 text-sm ml-2">— {pausedBy.name}</span>}
          </div>
        )}

        {/* Основной контент */}
        <div className="flex-1 flex gap-2 overflow-hidden">
          {/* Левая часть: пул героев */}
          <div className="flex-1 overflow-y-auto space-y-2">
            {Object.entries(byAttr).map(([attr, heroes]) => {
              const cfg = ATTR_CONFIG[attr];
              return (
                <div key={attr} className="glass-panel p-2 rounded-lg">
                  <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full ${cfg.bg} ${cfg.border} ${cfg.color} text-xs font-black uppercase tracking-wider mb-2`}>
                    {cfg.label} 
                    <span className="bg-black/40 text-white px-2 py-0.5 rounded-full text-[10px] font-bold">
                      {heroes.length}
                    </span>
                  </div>
                  
                  <div className="grid grid-cols-10 gap-1.5">
                    {heroes.map(hero => {
                      const isUsed = usedIds.includes(hero.id);
                      const isSelected = selectedHero === hero.id;
                      const isBanStep = step?.action === 'ban';
                      
                      return (
                        <button
                          key={hero.id}
                          disabled={isUsed || !canAct}
                          onClick={() => selectHero(hero.id)}
                          className={`relative aspect-square rounded overflow-hidden border-2 bg-zinc-900 group transition-all ${
                            isSelected 
                              ? 'border-yellow-500 ring-2 ring-yellow-500/50 scale-105 z-10' 
                              : isUsed 
                                ? 'border-zinc-800 opacity-30 grayscale cursor-not-allowed'
                                : canAct
                                  ? (isBanStep ? 'border-zinc-700 hover:border-red-500 hover:scale-105 cursor-pointer' : 'border-zinc-700 hover:border-emerald-500 hover:scale-105 cursor-pointer')
                                  : 'border-zinc-800 cursor-not-allowed'
                          }`}
                          title={hero.localizedName}
                        >
                          <img
                            src={hero.image}
                            alt={hero.localizedName}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              e.target.style.display = 'none';
                              e.target.nextSibling.style.display = 'flex';
                            }}
                          />
                          <div className="hidden w-full h-full bg-zinc-800 items-center justify-center text-[8px] text-center p-0.5 text-zinc-400">
                            {hero.localizedName}
                          </div>

                          {isUsed && (
                            <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
                              <span className="text-sm">🚫</span>
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Правая часть (ШИРИНА УВЕЛИЧЕНА: w-80 -> w-96) */}
          <div className="w-[500px] flex flex-col gap-2 overflow-hidden">
            {/* Все 4 таймера */}
            <div className="glass-panel p-2 rounded-xl flex-shrink-0">
              <div className="grid grid-cols-2 gap-2">
                {/* Radiant */}
                <div className={`space-y-1 p-2 rounded-lg border ${
                  step?.team === 0 && !finished ? 'border-emerald-500 bg-emerald-900/20' : 'border-zinc-700 bg-zinc-900/50'
                }`}>
                  <div className="text-emerald-400 esports-title font-bold text-[10px] text-center">RADIANT</div>
                  <div className="space-y-1">
                    <div>
                      <div className="text-[8px] text-zinc-500 uppercase">Основное</div>
                      <div className={`text-lg font-mono font-bold ${timers[0].main === 0 ? 'text-zinc-600' : 'text-white'}`}>
                        {formatTime(timers[0].main)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[8px] text-zinc-500 uppercase">Доп.</div>
                      <div className={`text-lg font-mono font-bold ${timers[0].main > 0 ? 'text-zinc-600' : timers[0].extra === 0 ? 'text-red-500 animate-pulse' : 'text-yellow-400'}`}>
                        {formatTime(timers[0].extra)}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Dire */}
                <div className={`space-y-1 p-2 rounded-lg border ${
                  step?.team === 1 && !finished ? 'border-red-500 bg-red-900/20' : 'border-zinc-700 bg-zinc-900/50'
                }`}>
                  <div className="text-red-400 esports-title font-bold text-[10px] text-center">DIRE</div>
                  <div className="space-y-1">
                    <div>
                      <div className="text-[8px] text-zinc-500 uppercase">Основное</div>
                      <div className={`text-lg font-mono font-bold ${timers[1].main === 0 ? 'text-zinc-600' : 'text-white'}`}>
                        {formatTime(timers[1].main)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[8px] text-zinc-500 uppercase">Доп.</div>
                      <div className={`text-lg font-mono font-bold ${timers[1].main > 0 ? 'text-zinc-600' : timers[1].extra === 0 ? 'text-red-500 animate-pulse' : 'text-yellow-400'}`}>
                        {formatTime(timers[1].extra)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Заголовки команд */}
            <div className="glass-panel p-2 rounded-xl flex-shrink-0">
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="text-emerald-400 esports-title font-bold text-sm">СИЛЫ СВЕТА</div>
                <div className="text-red-400 esports-title font-bold text-sm">СИЛЫ ТЬМЫ</div>
              </div>
            </div>

            {/* Дерево драфта */}
            <div className="glass-panel p-2 rounded-xl flex-1 overflow-y-auto">
              <div className="space-y-1.5">
                {draftOrder.map((slot, idx) => {
                  const historyItem = draftHistory.find(h => h.step === idx);
                  const isCurrent = !finished && idx === draftStep;
                  const isCompleted = idx < draftStep;
                  const hero = historyItem ? pool.find(h => h.id === historyItem.heroId) : null;
                  const isBan = slot.action === 'ban';

                  return (
                    <div key={idx} className="flex items-center gap-1.5">
                      {/* Слот Radiant (слева) - размеры немного увеличены для пропорции */}
                      <div className="flex-1 flex justify-end">
                        {slot.team === 0 && (
                          <div className={`relative ${isBan ? 'w-16 h-8' : 'w-20 h-12'} rounded border-2 overflow-hidden ${
                            isCompleted 
                              ? (isBan ? 'border-red-500 bg-red-900/20' : 'border-emerald-500 bg-emerald-900/30')
                              : isCurrent
                                ? 'border-yellow-500 bg-yellow-500/10 animate-pulse'
                                : 'border-zinc-700 bg-zinc-900/50'
                          }`}>
                            {hero && (
                              <img src={hero.image} alt="" className="w-full h-full object-cover" />
                            )}
                          </div>
                        )}
                      </div>

                      {/* Номер шага (центр) */}
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                        isCurrent ? 'bg-yellow-500 text-black' : 'bg-zinc-800 text-zinc-400'
                      }`}>
                        {idx + 1}
                      </div>

                      {/* Слот Dire (справа) - размеры немного увеличены для пропорции */}
                      <div className="flex-1 flex justify-start">
                        {slot.team === 1 && (
                          <div className={`relative ${isBan ? 'w-16 h-8' : 'w-20 h-12'} rounded border-2 overflow-hidden ${
                            isCompleted 
                              ? (isBan ? 'border-red-500 bg-red-900/20' : 'border-emerald-500 bg-emerald-900/30')
                              : isCurrent
                                ? 'border-yellow-500 bg-yellow-500/10 animate-pulse'
                                : 'border-zinc-700 bg-zinc-900/50'
                          }`}>
                            {hero && (
                              <img src={hero.image} alt="" className="w-full h-full object-cover" />
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Статус хода / Кнопка подтверждения */}
            {!finished && (
              <div className="glass-panel p-2 rounded-xl flex-shrink-0">
                {paused ? (
                  <div className="text-center py-2">
                    <div className="text-sm font-bold text-yellow-400">⏸ Выбор героев заблокирован</div>
                    <div className="text-xs text-zinc-500 mt-1">Ожидание продолжения драфта</div>
                  </div>
                ) : canAct && selectedHero && selectedHeroData ? (
                  <>
                    <div className="flex items-center gap-2 mb-2">
                      <img src={selectedHeroData.image} alt="" className="w-12 h-12 rounded-lg object-cover border-2 border-yellow-500" />
                      <div className="flex-1">
                        <div className="text-[10px] text-zinc-400 uppercase">Выбрано:</div>
                        <div className="text-sm font-bold text-white">{selectedHeroData.localizedName}</div>
                      </div>
                    </div>
                    <button
                      onClick={confirmAction}
                      className={`w-full py-2 rounded-lg font-bold uppercase tracking-wider text-sm transition-all ${
                        step.action === 'ban'
                          ? 'bg-red-600 hover:bg-red-700 text-white'
                          : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                      }`}
                    >
                      {step.action === 'ban' ? '🚫 Забанить' : '✅ Пикнуть'}
                    </button>
                  </>
                ) : canAct && !selectedHero ? (
                  <div className="text-center py-2">
                    <div className="text-xs text-zinc-400 uppercase mb-1">Твой ход!</div>
                    <div className="text-sm font-bold text-yellow-400">Выбери героя слева</div>
                  </div>
                ) : (
                  <div className="text-center py-2">
                    <div className="text-xs text-zinc-400 uppercase mb-1">
                      {step?.team === 0 ? '🟢 RADIANT' : '🔴 DIRE'} {step?.action === 'ban' ? 'делает БАН' : 'делает ВЫБОР'}
                    </div>
                    <div className="text-sm font-bold text-zinc-300">Ожидание хода противника...</div>
                  </div>
                )}
              </div>
            )}

            {/* Кнопка следующей игры */}
            {finished && state.series.currentGame < state.series.totalGames && isCaptain && (
              <button
                onClick={() => socket.emit('nextGame')}
                className="w-full py-2 rounded-xl bg-gradient-to-r from-yellow-600 to-yellow-500 text-black font-bold uppercase tracking-wider esports-title text-sm flex-shrink-0"
              >
                ▶ Игра {state.series.currentGame + 1}/{state.series.totalGames}
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="fixed bottom-4 right-4 bg-red-900/90 border border-red-500 text-white px-6 py-3 rounded-lg shadow-2xl">
            ⚠️ {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 border-4 border-yellow-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-zinc-400 uppercase tracking-widest text-sm">Загрузка данных...</p>
      </div>
    </div>
  );
}
