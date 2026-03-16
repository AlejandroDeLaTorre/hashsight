export const config = { runtime: 'edge' };

export default async function handler(req) {
  async function getBTCPrice() {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    if (!res.ok || res.headers.get('content-type')?.includes('text')) {
      const cb = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
      const cbJson = await cb.json();
      return parseFloat(cbJson?.data?.amount) ?? null;
    }
    const json = await res.json();
    return json.bitcoin?.usd ?? null;
  }

  const [btcPrice, diffText, blocksRes] = await Promise.all([
    getBTCPrice().catch(() => null),
    fetch('https://blockchain.info/q/getdifficulty').then(r => r.text()).catch(() => null),
    fetch('https://mempool.space/api/blocks').catch(() => null),
  ]);

  const difficulty = diffText ? parseFloat(diffText) : null;
  const blocks = blocksRes?.ok ? await blocksRes.json().catch(() => []) : [];

  if (!btcPrice || !difficulty) {
    return new Response(JSON.stringify({ error: 'upstream fetch failed', btcPrice, difficulty }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const avgFeesBTC = blocks.length
    ? blocks.slice(0, 6).reduce((s, b) => s + (b?.extras?.totalFees ?? 0) / 1e8, 0) / Math.min(blocks.length, 6)
    : 0;

  const SUBSIDY  = 3.125;
  const priceUSD = (86400 * (SUBSIDY + avgFeesBTC) * btcPrice * 1e12) / (difficulty * Math.pow(2, 32));

  return new Response(JSON.stringify({
    priceUSD,
    priceBTC:    priceUSD / btcPrice,
    pricePerPH:  priceUSD * 1000,
    btcPrice,
    difficulty,
    avgFeesBTC,
    timestamp:   new Date().toISOString(),
    source:      'stratumv2.com',
    powered_by:  'dmnd.work — Stratum V2 Bitcoin Mining Pool',
    docs:        'https://stratumv2.com/api-docs',
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 's-maxage=60',
      'X-Powered-By': 'stratumv2.com',
    },
  });
}