import { schedule } from "@netlify/functions";
import * as xrpl from "xrpl";

// ─── CONFIG ───────────────────────────────────
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_ANON_KEY;
const COINGECKO_URL   = "https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd";
const XRPL_WS         = "wss://xrplcluster.com";

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

// ─── FETCH TOKEN PRICE FROM XRPL DEX ─────────
// Uses the ASK price (best sell offer) as the primary price, matching what
// DEX aggregators like XPMarket display. The ASK is what you actually pay to
// buy the token. The BID (what buyers offer) is typically far lower for
// illiquid tokens — using it was the root cause of prices being ~35% wrong.
//
// book_offers semantics (XRPL):
//   taker_gets: xSTIK, taker_pays: XRP  →  makers are SELLING xSTIK  →  ASK
//   taker_gets: XRP,   taker_pays: xSTIK →  makers are BUYING  xSTIK  →  BID
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

  // PRIMARY: ASK — taker pays XRP, receives token → seller's lowest ask price
  const askOffers = await tryBook(
    { currency: token.currency, issuer: token.issuer },
    { currency: "XRP" }
  );
  if (askOffers.length) {
    const b    = askOffers[0];
    const tokA = typeof b.TakerGets === "string" ? +b.TakerGets : (+b.TakerGets?.value ?? 0);
    const xrpD = typeof b.TakerPays === "string" ? +b.TakerPays : (+b.TakerPays?.value ?? 0) * 1e6;
    if (xrpD > 0 && tokA > 0) return (xrpD / 1e6) / tokA;
  }

  // FALLBACK: BID — taker receives XRP, pays token → buyer's best bid price
  // Only used when there are no sell offers at all (extremely rare).
  const bidOffers = await tryBook(
    { currency: "XRP" },
    { currency: token.currency, issuer: token.issuer }
  );
  if (bidOffers.length) {
    const b    = bidOffers[0];
    const xrpD = typeof b.TakerGets === "string" ? +b.TakerGets : (+b.TakerGets?.value ?? 0) * 1e6;
    const tokA = typeof b.TakerPays === "string" ? +b.TakerPays : (+b.TakerPays?.value ?? 0);
    if (xrpD > 0 && tokA > 0) return (xrpD / 1e6) / tokA;
  }

  return null;
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

  // 2. Connect to XRPL
  const client = new xrpl.Client(XRPL_WS);
  await client.connect();

  const rows = [];

  // 3. Fetch price for each token
  for (const token of TOKENS) {
    const priceXrp = await fetchTokenPrice(client, token);
    if (priceXrp === null) {
      console.warn(`[collect-prices] No price found for ${token.symbol} — skipping`);
      continue;
    }
    const priceUsd = xrpUsd !== null ? priceXrp * xrpUsd : null;
    rows.push({ symbol: token.symbol, price_xrp: priceXrp, price_usd: priceUsd });
    console.log(`[collect-prices] ${token.symbol}: ${priceXrp} XRP / ${priceUsd ?? "?"} USD`);
  }

  // 4. Disconnect XRPL
  await client.disconnect();

  // 5. Write to Supabase (only if we got at least one price)
  if (rows.length > 0) {
    await insertRows(rows);
    console.log(`[collect-prices] Inserted ${rows.length} rows into Supabase`);
  } else {
    console.warn("[collect-prices] No rows to insert — nothing written");
  }

  return { statusCode: 200 };
});
