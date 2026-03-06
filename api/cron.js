export const config = { runtime: 'edge' };

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const V1_REJECT = 0.0047;
const V2_REJECT = 0.000151;

function esc(str) {
  // Escape special chars for Telegram MarkdownV2
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function fmtUSD(v) {
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(3) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(2) + 'k';
  return '$' + v.toFixed(2);
}

function profitabilityLine(name, wth, hp, powerCost) {
  const rev    = hp;
  const pwr    = wth / 1000 * 24 * powerCost;
  const margin = rev * (1 - V2_REJECT) - pwr;
  const pct    = ((margin / rev) * 100).toFixed(1);
  if (margin > 0) return `✅ ${name}: \\+${esc(pct)}% margin`;
  return `❌ ${name}: unprofitable at \\$${esc(powerCost)}/kWh`;
}

export default async function handler(req) {
  // Verify this is a legitimate cron call
  const auth = req.headers.get('authorization');
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Fetch live hashprice from our own proxy
  let hp;
  try {
    const res = await fetch('https://stratumv2.com/api/hashprice');
    if (!res.ok) throw new Error(`hashprice API ${res.status}`);
    hp = await res.json();
  } catch (e) {
    return new Response(`Failed to fetch hashprice: ${e.message}`, { status: 500 });
  }

  const PH       = 100;
  const POWER    = 0.05;
  const v1Cost   = hp.priceUSD * V1_REJECT * PH * 1000;
  const v2Cost   = hp.priceUSD * V2_REJECT * PH * 1000;
  const saving   = v1Cost - v2Cost;
  const monthly  = saving * 30;
  const yearly   = saving * 365;

  const MINERS = [
    { name: 'S21 XP',    wth: 13.5 },
    { name: 'S21 Pro',   wth: 15.0 },
    { name: 'S21',       wth: 17.5 },
    { name: 'S19 XP',    wth: 21.5 },
    { name: 'S19j Pro',  wth: 29.5 },
    { name: 'M60S',      wth: 18.5 },
  ];

  const profitLines = MINERS
    .map(m => profitabilityLine(m.name, m.wth, hp.priceUSD, POWER))
    .join('\n');

  const now = new Date().toUTCString().replace(/:\d{2} GMT/, ' UTC');

  const msg = [
    `⛏ *HASHPRICE UPDATE* — ${esc(now)}`,
    ``,
    `💰 *${esc('$' + hp.priceUSD.toFixed(6))}* / TH / day`,
    `₿ ${esc(hp.priceBTC.toFixed(10))} BTC / TH / day`,
    `📊 BTC: *${esc('$' + hp.btcPrice.toLocaleString())}*`,
    ``,
    `*V1 vs V2 @ 100 PH/s \\(\\$0\\.05/kWh\\)*`,
    `  V1 stale cost: ${esc(fmtUSD(v1Cost))}/day`,
    `  V2 stale cost: ${esc(fmtUSD(v2Cost))}/day`,
    `  💚 V2 saves: *${esc(fmtUSD(saving))}/day · ${esc(fmtUSD(monthly))}/mo · ${esc(fmtUSD(yearly))}/yr*`,
    ``,
    `*Miner Profitability @ \\$0\\.05/kWh*`,
    profitLines,
    ``,
    `📈 [stratumv2\\.com](https://stratumv2.com)`,
  ].join('\n');

  const tgRes = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        text: msg,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: false,
      }),
    }
  );

  const tgJson = await tgRes.json();

  if (!tgJson.ok) {
    console.error('Telegram error:', JSON.stringify(tgJson));
    return new Response(`Telegram error: ${JSON.stringify(tgJson)}`, { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, hashprice: hp.priceUSD, saved: saving }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
