import { schedule } from "@netlify/functions";

// ─── CONFIG ───────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY;
const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd";
const ONTHEDEX_BASE = "https://api.onthedex.live/public/v1";

// Token name is the human-readable ticker OnTheDEX uses (not the hex currency code).
// OnTheDEX ticker format: TOKEN_NAME.issuer:XRP
const TOKENS = [
  {
    symbol: "xSTIK",
    name:   "xSTIK",
    issuer: "rJNV9i4Q6zvRhpE2zjxgkvff3eGHQohZht",
  },
  {
    symbol: "xOFOOD",
    name:   "xOFOOD",
    issuer: "rQJdoz8sM3qupab9qjnbC6YFYmHreWPpNb",
  },
];

// ─── FETCH XRP/USD ────────────────────────────
async function fetchXrpUsd() {
  try {
    const r = await fetch(COINGECKO_URL);
    if (!r.ok) return null;
    const data = await r.json();
    return data?.ripple?.usd ?? null;
  } catch {
    return null;
  }
}

// ─── FETCH TOKEN PRICE FROM ONTHEDEX ─────────
// OnTheDEX returns the last-traded price from actual DEX execution history.
// Unlike book_offers (which only sees current open orders), this works for
// illiquid tokens with no active orders — it always has the last known trade.
//
// Endpoint: GET /ticker/TOKEN_NAME.issuer:XRP
// Response: { pairs: [{ last: price_in_xrp, time: unix_ts, ... }] }
//
// `last` = price of the most recent executed trade, expressed in XRP per token.
async function fetchTokenPrice(token) {
  try {
    const url = `${ONTHEDEX_BASE}/ticker/${token.name}.${token.issuer}:XRP`;
    const r   = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const pair = data?.pairs?.[0];
    if (!pair) return null;
    const last = pair.last;
    return (typeof last === "number" && last > 0) ? last : null;
  } catch {
    return null;
  }
}

// ─── WRITE TO SUPABASE ────────────────────────
async function insertRows(rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/token_prices`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Prefer":        "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Supabase insert failed: ${r.status} — ${text}`);
  }
}

// ─── MAIN HANDLER ─────────────────────────────
// Runs every 5 minutes via Netlify cron.
// Stores a row every run regardless of price change — matches QFS behaviour.
// Dense data is required for charts to render correctly on all timeframes.
export const handler = schedule("*/5 * * * *", async () => {
  console.log(`[collect-prices] Starting run at ${new Date().toISOString()}`);

  // 1. Get XRP/USD rate
  const xrpUsd = await fetchXrpUsd();
  console.log(`[collect-prices] XRP/USD: ${xrpUsd ?? "unavailable"}`);

  const rows = [];

  // 2. Fetch last-traded price for each token from OnTheDEX
  for (const token of TOKENS) {
    const priceXrp = await fetchTokenPrice(token);
    if (priceXrp === null) {
      console.warn(`[collect-prices] No price found for ${token.symbol} — skipping`);
      continue;
    }
    const priceUsd = xrpUsd !== null ? priceXrp * xrpUsd : null;
    rows.push({ symbol: token.symbol, price_xrp: priceXrp, price_usd: priceUsd });
    console.log(`[collect-prices] ${token.symbol}: ${priceXrp} XRP / ${priceUsd ?? "?"} USD`);
  }

  // 3. Write to Supabase (only if we got at least one price)
  if (rows.length > 0) {
    await insertRows(rows);
    console.log(`[collect-prices] Inserted ${rows.length} rows into Supabase`);
  } else {
    console.warn("[collect-prices] No rows to insert — nothing written");
  }

  return { statusCode: 200 };
});
