export const config = { runtime: 'edge' };

async function sql(query, params = []) {
  const res = await fetch(process.env.NEON_HTTP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${process.env.NEON_CREDENTIALS_B64}`,
    },
    body: JSON.stringify({ query, params }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Neon HTTP error ${res.status}: ${text}`);
  }
  return res.json();
}

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const days = Math.min(365, Math.max(1, parseInt(searchParams.get('days') ?? '30')));

  let result;
  try {
    result = await sql(
      `SELECT
         DATE_TRUNC('hour', ts) AS hour,
         AVG(price_usd)::FLOAT   AS price_usd,
         AVG(price_btc)::FLOAT   AS price_btc,
         AVG(btc_price)::FLOAT   AS btc_price
       FROM hashprice_snapshots
       WHERE ts >= NOW() - INTERVAL '${days} days'
       GROUP BY hour
       ORDER BY hour ASC`,
      []
    );
  } catch (e) {
    // Table doesn't exist yet — return empty
    return new Response(JSON.stringify({ rows: [], days, note: 'no data yet' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ rows: result.rows ?? [], days }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 's-maxage=300', // cache 5 min
    },
  });
}
