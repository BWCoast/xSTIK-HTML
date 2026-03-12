import { schedule } from "@netlify/functions";
import * as xrpl from "xrpl";

// ─── CONFIG ───────────────────────────────────
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_ANON_KEY;
const COINGECKO_URL   = "https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd";
const XRPL_WS         = "wss://xrplcluster.com";

// Skip insert when price changed less than this fraction (relative).
// Prevents thousands of identical rows filling Supabase for illiquid tokens.
const DEDUP_THRESHOLD = 0.0001; // 0.01%

const TOKENS = [
  {
    symbol:   "xSTIK",
    currency: "785354494B000000000000000000000000000000",
    issuer:   "rJNV9i4Q6zvRhpE2zjxgkvff3eGHQohZht",
  },
  {
    symbol:   "xOFOOD",
    currency: "784F464F4F440000000000000000000000000000",
    issuer:   "rQJdoz8sM3qupab9qjnbC6YFYmHreWPpNb",
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

// ─── FETCH LAST STORED PRICE PER SYMBOL ───────
// Used for deduplication: only insert a new row when the price has actually moved.
async function fetchLastStoredPrices() {
  const results = {};
  for (const token of TOKENS) {
    try {
      const url = `${SUPABASE_URL}/rest/v1/token_prices`
        + `?select=price_xrp`
        + `&symbol=eq.${token.symbol}`
        + `&order=fetched_at.desc`
        + `&limit=1`;
      const r = await fetch(url, {
        headers: {
          "apikey":        SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
        },
      });
      if (!r.ok) continue;
      const rows = await r.json();
      if (rows.length > 0) results[token.symbol] = +rows[0].price_xrp;
    } catch {
      // Non-fatal — missing entry just means no dedup check for this symbol
    }
  }
  return results;
}

// ─── FETCH TOKEN PRICE FROM XRPL DEX ─────────
// Queries both the ask side and the bid side; returns the midpoint when both
// are available, or the best available side when only one is present.
// The midpoint is more representative than the ask alone, and surfaces price
// changes that happen when the market maker adjusts their quotes.
async function fetchTokenPrice(client, token) {
  const tryBook = async (gets, pays) => {
    try {
      const r = await client.request({
        command:     "book_offers",
        taker_gets:  gets,
        taker_pays:  pays,
        limit:       5,
      });
      return r.result?.offers ?? [];
    } catch {
      return [];
    }
  };

  // Ask side: taker pays token, gets XRP → cheapest token price in XRP
  const askOffers = await tryBook(
    { currency: "XRP" },
    { currency: token.currency, issuer: token.issuer }
  );
  let askPrice = null;
  if (askOffers.length) {
    const b    = askOffers[0];
    const xrpD = typeof b.TakerGets === "string" ? +b.TakerGets : (+b.TakerGets?.value ?? 0) * 1e6;
    const tokA = typeof b.TakerPays === "string" ? +b.TakerPays : (+b.TakerPays?.value ?? 0);
    if (xrpD > 0 && tokA > 0) askPrice = (xrpD / 1e6) / tokA;
  }

  // Bid side: taker pays XRP, gets token → highest XRP someone will pay per token
  const bidOffers = await tryBook(
    { currency: token.currency, issuer: token.issuer },
    { currency: "XRP" }
  );
  let bidPrice = null;
  if (bidOffers.length) {
    const b    = bidOffers[0];
    const tokA = typeof b.TakerGets === "string" ? +b.TakerGets : (+b.TakerGets?.value ?? 0);
    const xrpD = typeof b.TakerPays === "string" ? +b.TakerPays : (+b.TakerPays?.value ?? 0) * 1e6;
    if (xrpD > 0 && tokA > 0) bidPrice = (xrpD / 1e6) / tokA;
  }

  // Midpoint when both sides present; otherwise best available
  if (askPrice !== null && bidPrice !== null) return (askPrice + bidPrice) / 2;
  return askPrice ?? bidPrice ?? null;
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
// Runs every 5 minutes via Netlify cron
export const handler = schedule("*/5 * * * *", async () => {
  console.log(`[collect-prices] Starting run at ${new Date().toISOString()}`);

  // 1. Fetch last stored prices for deduplication check
  const lastPrices = await fetchLastStoredPrices();
  console.log(`[collect-prices] Last stored prices: ${JSON.stringify(lastPrices)}`);

  // 2. Get XRP/USD rate
  const xrpUsd = await fetchXrpUsd();
  console.log(`[collect-prices] XRP/USD: ${xrpUsd ?? "unavailable"}`);

  // 3. Connect to XRPL
  const client = new xrpl.Client(XRPL_WS);
  await client.connect();

  const rows = [];

  // 4. Fetch and filter prices for each token
  for (const token of TOKENS) {
    const priceXrp = await fetchTokenPrice(client, token);
    if (priceXrp === null) {
      console.warn(`[collect-prices] No price found for ${token.symbol} — skipping`);
      continue;
    }

    // Deduplication: skip insert when price hasn't moved beyond threshold
    const lastXrp = lastPrices[token.symbol];
    if (lastXrp !== undefined && lastXrp > 0) {
      const delta = Math.abs(priceXrp - lastXrp) / lastXrp;
      if (delta < DEDUP_THRESHOLD) {
        console.log(`[collect-prices] ${token.symbol}: unchanged (${priceXrp.toPrecision(8)} XRP, Δ${(delta * 100).toFixed(5)}%) — skipping`);
        continue;
      }
    }

    const priceUsd = xrpUsd !== null ? priceXrp * xrpUsd : null;
    rows.push({ symbol: token.symbol, price_xrp: priceXrp, price_usd: priceUsd });
    console.log(`[collect-prices] ${token.symbol}: ${priceXrp} XRP / ${priceUsd ?? "?"} USD — queued`);
  }

  // 5. Disconnect XRPL
  await client.disconnect();

  // 6. Write to Supabase only when something changed
  if (rows.length > 0) {
    await insertRows(rows);
    console.log(`[collect-prices] Inserted ${rows.length} row(s) into Supabase`);
  } else {
    console.log(`[collect-prices] All prices unchanged — nothing written`);
  }

  return { statusCode: 200 };
});
