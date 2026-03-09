export const config = { runtime: 'edge' };

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID  = process.env.TELEGRAM_CHANNEL_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const V1_REJECT = 0.0047;
const V2_REJECT = 0.000151;

function fmtUSD(v) {
  const abs = Math.abs(v);
  const sign = v >= 0 ? '' : '-';
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(3) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(2) + 'k';
  return sign + '$' + abs.toFixed(2);
}

function pct(a, b) {
  const p = ((a - b) / b) * 100;
  return (p >= 0 ? '+' : '') + p.toFixed(1) + '%';
}

function minerNet(wth, hashTH, hp, powerCost) {
  const netPerTH = hp * (1 - V2_REJECT) - (wth / 1000 * 24 * powerCost);
  return netPerTH * hashTH;
}

function minerV2Extra(hashTH, hp) {
  return (V1_REJECT - V2_REJECT) * hp * hashTH;
}

const MINERS = [
  { name: 'S21 XP+ Hyd',          wth: 11.0, hashTH: 500 },
  { name: 'S21 XP Hyd',           wth: 12.0, hashTH: 473 },
  { name: 'S21 Hydro',            wth: 16.0, hashTH: 335 },
  { name: 'S21 XP',               wth: 13.5, hashTH: 270 },
  { name: 'S21 Pro',              wth: 15.0, hashTH: 234 },
  { name: 'S19j Pro',             wth: 29.5, hashTH: 104 },
  { name: 'SealMiner A2 Pro Hyd', wth: 14.9, hashTH: 500 },
  { name: 'SealMiner A2 Pro Air', wth: 14.9, hashTH: 265 },
  { name: 'M66S++',               wth: 15.5, hashTH: 348 },
  { name: 'M66S+',                wth: 17.0, hashTH: 318 },
  { name: 'M63S Hydro',           wth: 18.5, hashTH: 390 },
];

export default async function handler(req) {
  const auth = req.headers.get('authorization');
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Fetch current hashprice
  const base = process.env.SITE_URL || `https://${process.env.VERCEL_URL}`;
  let hp;
  try {
    const res = await fetch(`${base}/api/hashprice`);
    if (!res.ok) throw new Error(`hashprice API ${res.status}`);
    hp = await res.json();
  } catch (e) {
    return new Response(`Failed to fetch hashprice: ${e.message}`, { status: 500 });
  }

  // Fetch weekly stats from Neon
  let weekStats = null;
  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`
      SELECT
        MIN(price_usd)::FLOAT  AS min_hp,
        MAX(price_usd)::FLOAT  AS max_hp,
        AVG(price_usd)::FLOAT  AS avg_hp,
        MIN(btc_price)::FLOAT  AS min_btc,
        MAX(btc_price)::FLOAT  AS max_btc,
        (array_agg(btc_price ORDER BY ts ASC))[1]::FLOAT  AS first_btc,
        (array_agg(btc_price ORDER BY ts DESC))[1]::FLOAT AS last_btc,
        (array_agg(price_usd ORDER BY ts ASC))[1]::FLOAT  AS first_hp,
        COUNT(*)               AS snapshots
      FROM hashprice_snapshots
      WHERE ts >= NOW() - INTERVAL '7 days'
    `;
    if (rows.length > 0) weekStats = rows[0];
  } catch (e) {
    console.warn('Neon weekly stats failed:', e.message);
  }

  const POWER   = 0.05;
  const hpNow   = hp.priceUSD;
  const hpPerPH = hpNow * 1000;

  // V2 savings over the full week at 100 PH/s
  const dailySaving  = (V1_REJECT - V2_REJECT) * hpNow * 100 * 1000;
  const weeklySaving = dailySaving * 7;
  const monthlySaving = dailySaving * 30;
  const yearlySaving  = dailySaving * 365;

  // Best and worst miner this week
  const minersSorted = MINERS
    .map(m => ({ ...m, net: minerNet(m.wth, m.hashTH, hpNow, POWER) }))
    .sort((a, b) => b.net - a.net);
  const best  = minersSorted[0];
  const worst = minersSorted[minersSorted.length - 1];

  // Difficulty change indicator
  const diffAdjusted = weekStats && weekStats.first_hp
    ? Math.abs((hpNow - weekStats.first_hp) / weekStats.first_hp) > 0.03
    : false;

  // Build weekly trend line
  const hpTrend = weekStats
    ? (hpNow >= weekStats.avg_hp ? '📈' : '📉')
    : '➡️';

  const btcChange = weekStats
    ? pct(weekStats.last_btc, weekStats.first_btc)
    : 'n/a';

  const hpChange = weekStats
    ? pct(hpNow, weekStats.first_hp)
    : 'n/a';

  const now = new Date().toUTCString().replace(/:\d{2} GMT/, ' UTC');

  // Miner table — top 5 profitable + flag unprofitable
  const minerLines = minersSorted.map(m => {
    const v2up = minerV2Extra(m.hashTH, hpNow);
    const status = m.net > 0 ? '✅' : '❌';
    return `${status} <b>${m.name}</b> (${m.hashTH}T): ${fmtUSD(m.net)}/day  💚 +${fmtUSD(v2up)} vs V1`;
  }).join('\n');

  const weekSummary = weekStats ? [
    ``,
    `<b>📊 WEEK IN REVIEW</b>`,
    `  Hashprice range: <b>$${weekStats.min_hp.toFixed(6)}</b> – <b>$${weekStats.max_hp.toFixed(6)}</b>`,
    `  Hashprice avg:   <b>$${weekStats.avg_hp.toFixed(6)}</b>  ${hpTrend} ${hpChange} wow`,
    `  BTC range: <b>$${Math.round(weekStats.min_btc).toLocaleString()}</b> – <b>$${Math.round(weekStats.max_btc).toLocaleString()}</b>`,
    `  BTC change: <b>${btcChange}</b> week over week`,
    `  🏆 Best miner: <b>${best.name}</b> at ${fmtUSD(best.net)}/day`,
    `  📉 Tightest margins: <b>${worst.name}</b> at ${fmtUSD(worst.net)}/day`,
  ].join('\n') : '';

  const msg = [
    `⛏ <b>WEEKLY HASHPRICE RECAP</b> — ${now}`,
    ``,
    `💰 <b>$${hpNow.toFixed(6)}</b> / TH / day  (<b>$${hpPerPH.toFixed(4)}</b> / PH / day)`,
    `₿ BTC: <b>$${hp.btcPrice.toLocaleString()}</b>`,
    weekSummary,
    ``,
    `<b>V2 Savings @ 100 PH/s ($0.05/kWh)</b>`,
    `  This week:  <b>${fmtUSD(weeklySaving)}</b>`,
    `  This month: <b>${fmtUSD(monthlySaving)}</b>`,
    `  This year:  <b>${fmtUSD(yearlySaving)}</b>`,
    ``,
    `<b>Per Machine @ $0.05/kWh — net profit + V2 upside</b>`,
    minerLines,
    ``,
    `📈 <a href="https://stratumv2.com">stratumv2.com</a>  ·  ⛏ <a href="https://dmnd.work">dmnd.work</a>`,
  ].join('\n');

  async function postToChannel(chatId) {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: msg,
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        }),
      }
    );
    return res.json();
  }

  const channels = [CHANNEL_ID, process.env.TELEGRAM_CHANNEL_ID_2].filter(Boolean);
  const results  = await Promise.all(channels.map(postToChannel));
  const failed   = results.filter(r => !r.ok);
  if (failed.length) {
    return new Response(`Telegram error: ${JSON.stringify(failed)}`, { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, hashprice: hpNow, weeklySaving }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
