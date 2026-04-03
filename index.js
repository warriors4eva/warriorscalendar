require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const { createEvents } = require('ics');

// ================= CONFIG =================
const TEAM_ID = 2;
const NBA_API_URL = 'https://www.balldontlie.io/api/v1/games';

// Auto season detection
const now = new Date();
const year = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
const SEASON_START = `${year}-10-01`;
const SEASON_END = `${year + 1}-06-30`;

// ================= HELPERS =================

const sanitize = (text = '') =>
  text.replace(/[<>]/g, '').replace(/\n/g, ' ').trim();

const toHST = (utcDate) => {
  const date = new Date(utcDate);
  return new Date(date.getTime() - 10 * 60 * 60 * 1000);
};

const formatTimeHST = (date) => {
  const h = date.getHours();
  const m = String(date.getMinutes()).padStart(2, '0');
  const hour = h % 12 || 12;
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${hour}:${m} ${ampm}`;
};

const normalize = (str) =>
  str.toLowerCase().replace(/[^a-z]/g, '');

const formatDateKey = (date) => {
  return new Date(date).toISOString().slice(0, 10);
};

// ================= FETCH DATA =================

const fetchAllGames = async () => {
  let allGames = [];
  let page = 1;

  while (true) {
    const res = await axios.get(NBA_API_URL, {
      params: {
        team_ids: TEAM_ID,
        start_date: SEASON_START,
        end_date: SEASON_END,
        per_page: 100,
        page
      }
    });

    const games = res.data.data || [];
    allGames = allGames.concat(games);

    if (games.length < 100) break;
    page++;
  }

  return allGames;
};

// Fetch ESPN for next 3 days (balanced)
const fetchESPNGames = async () => {
  try {
    let all = [];

    for (let i = 0; i < 3; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);

      const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');

      const res = await axios.get(
        `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard`,
        { params: { dates: dateStr } }
      );

      all = all.concat(res.data.events || []);
    }

    return all;
  } catch (err) {
    console.error('ESPN fetch failed');
    return [];
  }
};

// ================= MATCH BROADCAST =================

const findBroadcast = (game, espnGames) => {
  const opponent = (
    game.home_team.id === TEAM_ID
      ? game.visitor_team.full_name
      : game.home_team.full_name
  );

  const gameDate = formatDateKey(game.date);

  const warriorsKey = normalize('Golden State Warriors');
  const opponentKey = normalize(opponent);

  for (const e of espnGames) {
    const comp = e.competitions?.[0];
    if (!comp) continue;

    const eventDate = formatDateKey(e.date);
    if (eventDate !== gameDate) continue;

    const teamKeys = comp.competitors.map(c =>
      normalize(c.team.displayName)
    );

    const hasWarriors = teamKeys.some(t => t.includes('warriors'));
    const hasOpponent = teamKeys.some(t => t.includes(opponentKey.slice(-6)));

    if (hasWarriors && hasOpponent) {
      return comp.broadcasts?.[0]?.names?.[0] || null;
    }
  }

  return null;
};

// ================= BUILD EVENTS =================

const buildEvents = (games, espnGames) => {
  games.sort((a, b) => new Date(a.date) - new Date(b.date));

  return games
    .map(game => {
      if (!game.home_team || !game.visitor_team) return null;

      const isHome = game.home_team.id === TEAM_ID;
      const opponent = isHome ? game.visitor_team : game.home_team;

      const hst = toHST(game.date);
      const broadcast = findBroadcast(game, espnGames);

      let title;
      let description = `
Opponent: ${opponent.full_name}
Location: ${isHome ? 'Home (Chase Center)' : 'Away'}
`;

      if (broadcast) {
        description += `Broadcast: ${broadcast}\n`;
      }

      if (game.status === 'Final') {
        const ws = isHome ? game.home_team_score : game.visitor_team_score;
        const os = isHome ? game.visitor_team_score : game.home_team_score;
        const result = ws > os ? 'W' : 'L';

        title = sanitize(
          `Warriors ${ws} - ${opponent.full_name} ${os} (${result})`
        );

        description += `
FINAL: Warriors ${ws} - ${opponent.full_name} ${os} (${result})
`;

      } else if (game.status === 'Postponed' || game.status === 'Canceled') {
        title = sanitize(
          `Warriors vs ${opponent.full_name} - ${game.status}`
        );

        description += `Status: ${game.status}\n`;

      } else {
        const timeString = formatTimeHST(hst);

        title = sanitize(
          `Warriors vs ${opponent.full_name} (${isHome ? 'HOME' : 'AWAY'}) - ${timeString} HST`
        );
      }

      return {
        uid: `warriors-${game.id}@warriors-calendar.local`,
        title,
        description: sanitize(description),
        start: [
          hst.getFullYear(),
          hst.getMonth() + 1,
          hst.getDate(),
          hst.getHours(),
          hst.getMinutes()
        ],
        startInputType: 'local',
        startOutputType: 'local',
        duration: { hours: 2 },
        timestamp: Date.now()
      };
    })
    .filter(Boolean);
};

// ================= GENERATE ICS =================

const generateICS = (events) => {
  createEvents(events, {
    calName: 'Golden State Warriors Schedule',
    method: 'PUBLISH'
  }, (error, value) => {
    if (error) {
      console.error('ICS generation error:', error);
      return;
    }

    fs.writeFileSync('warriors.ics', value);
    console.log('✅ warriors.ics updated');
  });
};

// ================= MAIN =================

const run = async () => {
  console.log(`[${new Date().toISOString()}] Sync start`);

  try {
    const games = await fetchAllGames();
    console.log(`Fetched ${games.length} games`);

    const espnGames = await fetchESPNGames();
    console.log(`Fetched ESPN games (${espnGames.length})`);

    const events = buildEvents(games, espnGames);

    generateICS(events);

  } catch (err) {
    console.error('❌ Sync failed:', err.message);
  }
};

run();