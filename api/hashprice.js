export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const [priceRes, diffRes, blocksRes] = await Promise.allSettled([
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'),
    fetch('https://blockchain.info/q/getdifficulty'),
    fetch('https://mempool.space/api/blocks'),
  ]);

  const btcPrice = priceRes.status === 'fulfilled'
    ? (await priceRes.value.json()).bitcoin?.usd ?? null
    : null;

  const difficulty = diffRes.status === 'fulfilled'
    ? parseFloat(await diffRes.value.text())
    : null;

  const blocks = blocksRes.status === 'fulfilled'
    ? await blocksRes.value.json()
    : [];

  if (!btcPrice || !difficulty) {
    return new Response(JSON.stringify({ error: 'upstream fetch failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const avgFeesBTC = blocks.length
    ? blocks.slice(0, 6).reduce((s, b) => s + (b?.extras?.totalFees ?? 0) / 1e8, 0) / Math.min(blocks.length, 6)
    : 0;

  const SUBSIDY = 3.125;
  const priceUSD = (86400 * (SUBSIDY + avgFeesBTC) * btcPrice * 1e12) / (difficulty * Math.pow(2, 32));

  const payload = {
    priceUSD,
    priceBTC: priceUSD / btcPrice,
    btcPrice,
    difficulty,
    avgFeesBTC,
    timestamp: new Date().toISOString(),
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 's-maxage=60',
    },
  });
}
