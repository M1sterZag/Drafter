// server/dota-api.js
const axios = require('axios');

// OpenDota API — бесплатный, без ключа, возвращает атрибуты героев
const HEROES_URL = 'https://api.opendota.com/api/heroes';

let heroesCache = null;
let lastFetch = 0;
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 часов

async function fetchHeroes() {
  if (heroesCache && Date.now() - lastFetch < CACHE_TTL) return heroesCache;

  console.log('📡 Загружаю список героев из OpenDota API...');
  const { data } = await axios.get(HEROES_URL);

  heroesCache = data
    .filter(h => h.name && h.name.startsWith('npc_dota_hero_'))
    .map(h => {
      const shortName = h.name.replace('npc_dota_hero_', '');
      // OpenDota API возвращает primary_attr как 'str', 'agi', 'int', 'universal' или 'all'
      const rawAttr = h.primary_attr?.toLowerCase();
      let primaryAttr = 'uni'; // по умолчанию универсал
      
      if (rawAttr === 'str') primaryAttr = 'str';
      else if (rawAttr === 'agi') primaryAttr = 'agi';
      else if (rawAttr === 'int') primaryAttr = 'int';
      else if (rawAttr === 'universal' || rawAttr === 'all') primaryAttr = 'uni';
      else primaryAttr = 'uni'; // всё остальное тоже универсал

      return {
        id: h.id,
        name: h.name,
        shortName,
        localizedName: h.localized_name,
        primaryAttr,
        attackType: h.attack_type,
        image: `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${shortName}.png`,
        icon: `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${shortName}_sb.png`
      };
    });

  // Логируем распределение по атрибутам
  const attrCount = { str: 0, agi: 0, int: 0, uni: 0 };
  heroesCache.forEach(h => attrCount[h.primaryAttr]++);
  console.log(`✅ Загружено героев: ${heroesCache.length}`);
  console.log(`📊 Распределение: ${attrCount.str} силы, ${attrCount.agi} ловкости, ${attrCount.int} интеллекта, ${attrCount.uni} универсалов`);

  lastFetch = Date.now();
  return heroesCache;
}

// Генерация пула из 28 героев (7+7+7+7)
function generatePool(heroes, bannedIds = []) {
  const available = heroes.filter(h => !bannedIds.includes(h.id));
  const byAttr = { str: [], agi: [], int: [], uni: [] };

  available.forEach(h => {
    const attr = h.primaryAttr; // уже 'str', 'agi', 'int' или 'uni'
    if (byAttr[attr]) {
      byAttr[attr].push(h);
    } else {
      // Если атрибут неизвестен — добавляем в универсалы
      byAttr.uni.push(h);
    }
  });

  // Перемешиваем массив (Fisher-Yates)
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const pool = [
    ...shuffle(byAttr.str).slice(0, 7),
    ...shuffle(byAttr.agi).slice(0, 7),
    ...shuffle(byAttr.int).slice(0, 7),
    ...shuffle(byAttr.uni).slice(0, 7)
  ];

  console.log(`📊 Пул: ${byAttr.str.length} силы, ${byAttr.agi.length} ловкости, ${byAttr.int.length} интеллекта, ${byAttr.uni.length} универсалов`);

  return pool;
}

module.exports = { fetchHeroes, generatePool };