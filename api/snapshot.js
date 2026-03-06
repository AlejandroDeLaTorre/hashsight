import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const auth = req.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Fetch live hashprice
    const base = new URL(req.url).origin;
    const hp = await fetch(`${base}/api/hashprice`).then(r => r.json());

    // neon() uses HTTP by default in Edge runtime — fast single-shot queries
    const sql = neon(process.env.DATABASE_URL, { fetchConnectionCache: true });

    // Create table if needed, then insert — batched in one transaction
    await sql.transaction([
      sql`CREATE TABLE IF NOT EXISTS hashprice_snapshots (
        id         BIGSERIAL PRIMARY KEY,
        ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        price_usd  NUMERIC(18,10) NOT NULL,
        price_btc  NUMERIC(18,14) NOT NULL,
        btc_price  NUMERIC(12,2)  NOT NULL,
        difficulty NUMERIC(20,0)  NOT NULL,
        fees_btc   NUMERIC(10,6)  NOT NULL DEFAULT 0
      )`,
      sql`CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON hashprice_snapshots (ts DESC)`,
      sql`INSERT INTO hashprice_snapshots (price_usd, price_btc, btc_price, difficulty, fees_btc)
          VALUES (${hp.priceUSD}, ${hp.priceBTC}, ${hp.btcPrice}, ${hp.difficulty}, ${hp.avgFeesBTC ?? 0})`,
    ]);

    return new Response(JSON.stringify({ ok: true, hp }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
