const axios = require('axios');
const fs = require('fs');
const { createEvents } = require('ics');

const TEAM_ABBREV = 'GS';
const TEAM_SLUG = 'warriors';
const OUTPUT_FILE = 'warriors.ics';
const ESPN_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';

function sanitize(text = '') {
  return String(text).replace(/[<>]/g, '').replace(/\r?\n/g, ' ').trim();
}

function toUTCDateParts(isoString) {
  const d = new Date(isoString);

  return [
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
  ];
}

function formatDisplayTimeHST(isoString) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Pacific/Honolulu',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(isoString));
}

function formatDateForEspn(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function buildDateRange() {
  const now = new Date();

  const seasonStartYear =
    now.getUTCMonth() >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;

  const start = new Date(Date.UTC(seasonStartYear, 9, 1)); // Oct 1
  const end = new Date(Date.UTC(seasonStartYear + 1, 5, 30)); // Jun 30

  const dates = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    dates.push(formatDateForEspn(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

async function fetchGamesForDate(dateStr) {
  const res = await axios.get(ESPN_SCOREBOARD_URL, {
    params: { dates: dateStr },
    timeout: 30000,
  });

  return Array.isArray(res.data?.events) ? res.data.events : [];
}

function isWarriorsEvent(event) {
  const competitors = event?.competitions?.[0]?.competitors || [];
  return competitors.some((c) => {
    const abbr = c?.team?.abbreviation;
    const shortDisplayName = c?.team?.shortDisplayName?.toLowerCase();
    const displayName = c?.team?.displayName?.toLowerCase();

    return (
      abbr === TEAM_ABBREV ||
      shortDisplayName === TEAM_SLUG ||
      displayName?.includes('warriors')
    );
  });
}

function getWarriorsAndOpponent(event) {
  const competitors = event?.competitions?.[0]?.competitors || [];

  const warriors = competitors.find(
    (c) =>
      c?.team?.abbreviation === TEAM_ABBREV ||
      c?.team?.shortDisplayName?.toLowerCase() === TEAM_SLUG ||
      c?.team?.displayName?.toLowerCase()?.includes('warriors')
  );

  const opponent = competitors.find((c) => c !== warriors);

  return { warriors, opponent };
}

function getBroadcast(event) {
  const broadcasts = event?.competitions?.[0]?.broadcasts || [];
  const names = broadcasts.flatMap((b) =>
    Array.isArray(b.names) ? b.names : []
  );
  return names.length ? names.join(', ') : null;
}

function buildEventFromEspn(event) {
  const competition = event?.competitions?.[0];
  if (!competition) return null;

  const { warriors, opponent } = getWarriorsAndOpponent(event);
  if (!warriors || !opponent) return null;

  const isHome = warriors.homeAway === 'home';
  const opponentName = opponent?.team?.displayName || 'Unknown Opponent';
  const isoDate = event.date;
  const statusType =
    event?.status?.type?.description || event?.status?.type?.name || '';
  const statusState = event?.status?.type?.state || '';
  const broadcast = getBroadcast(event);

  const warriorsScore = Number(warriors?.score ?? 0);
  const opponentScore = Number(opponent?.score ?? 0);

  const description = [
    `Opponent: ${opponentName}`,
    `Location: ${isHome ? 'Home' : 'Away'}`,
  ];

  if (broadcast) {
    description.push(`Broadcast: ${broadcast}`);
  }

  let title = '';

  if (statusState === 'post' || /final/i.test(statusType)) {
    const result =
      warriorsScore > opponentScore
        ? 'W'
        : warriorsScore < opponentScore
        ? 'L'
        : 'T';

    title = `Warriors ${warriorsScore} - ${opponentName} ${opponentScore} (${result})`;
    description.push(
      `Final: Warriors ${warriorsScore} - ${opponentName} ${opponentScore} (${result})`
    );
  } else if (/postponed|canceled/i.test(statusType)) {
    title = `Warriors vs ${opponentName} - ${statusType}`;
    description.push(`Status: ${statusType}`);
  } else {
    const timeHST = formatDisplayTimeHST(isoDate);
    title = `Warriors vs ${opponentName} (${isHome ? 'HOME' : 'AWAY'}) - ${timeHST} HST`;
    description.push(`Tipoff: ${timeHST} HST`);
  }

  return {
    uid: `espn-nba-${event.id}@warriorscalendar`,
    title: sanitize(title),
    description: sanitize(description.join('\n')),
    start: toUTCDateParts(isoDate),
    startInputType: 'utc',
    startOutputType: 'utc',
    duration: { hours: 3 },
    status: 'CONFIRMED',
    busyStatus: 'BUSY',
    productId: 'warriorscalendar',
  };
}

async function fetchSeasonWarriorsEvents() {
  const dates = buildDateRange();
  const seen = new Map();

  for (const dateStr of dates) {
    const events = await fetchGamesForDate(dateStr);

    for (const event of events) {
      if (!isWarriorsEvent(event)) continue;
      if (!seen.has(event.id)) {
        seen.set(event.id, event);
      }
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(buildEventFromEspn)
    .filter(Boolean);
}

function writeICS(events) {
  return new Promise((resolve, reject) => {
    createEvents(
      events,
      {
        calName: 'Golden State Warriors Schedule',
        method: 'PUBLISH',
      },
      (error, value) => {
        if (error) {
          reject(error);
          return;
        }

        fs.writeFileSync(OUTPUT_FILE, value, 'utf8');
        console.log(`✅ ${OUTPUT_FILE} updated`);
        resolve();
      }
    );
  });
}

async function run() {
  console.log(`[${new Date().toISOString()}] Sync start`);

  const events = await fetchSeasonWarriorsEvents();
  console.log(`Fetched ${events.length} Warriors events from ESPN`);

  if (!events.length) {
    throw new Error('No Warriors events found from ESPN');
  }

  await writeICS(events);
}

run().catch((err) => {
  console.error(`❌ Sync failed: ${err.message}`);
  process.exit(1);
});
