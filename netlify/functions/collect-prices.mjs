import { schedule } from "@netlify/functions";

// ─── CONFIG ───────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY;
const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd";
const ONTHEDEX_BASE = "https://api.onthedex.live/public/v1";
const XRPL_HTTP     = "https://xrplcluster.com/";

const TOKENS = [
  {
    symbol:   "xSTIK",
    source:   "onthedex",          // indexed by OnTheDEX — last-traded price available
    ticker:   "xSTIK",
    issuer:   "rJNV9i4Q6zvRhpE2zjxgkvff3eGHQohZht",
  },
  {
    symbol:   "xOFOOD",
    source:   "xrpl_account_tx",   // trades are cross-currency Payments, not offers
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

// ─── PRICE: OnTheDEX last-traded (xSTIK) ─────
// OnTheDEX indexes actual DEX offer executions. Works for xSTIK because its
// trades appear as OfferCreate crosses in the XRPL ledger.
//
// Endpoint: GET /ticker/TOKEN_NAME.issuer:XRP
// Response: { pairs: [{ last: price_in_xrp, ... }] }
async function fetchOnthedexPrice(token) {
  try {
    const url = `${ONTHEDEX_BASE}/ticker/${token.ticker}.${token.issuer}:XRP`;
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

// ─── PRICE: XRPL account_tx (xOFOOD) ─────────
// xOFOOD trades are executed as XRPL cross-currency Payment transactions,
// NOT as OfferCreate crosses. This means DEX aggregators like OnTheDEX do
// not see them — they only watch offer books.
//
// Strategy: query account_tx for the xOFOOD issuer. When users buy xOFOOD
// with XRP via a cross-currency Payment, the transaction appears here with:
//   tx.SendMax  = XRP string in drops  (max XRP the buyer was willing to pay)
//   meta.delivered_amount = xOFOOD object (actual xOFOOD received)
//
// Price in XRP/token = parseInt(sendMax) / 1e6 / parseFloat(deliveredAmount.value)
//
// The "SELL" side of these pairs sets sendMax to 9000000000000000 xOFOOD
// (essentially unlimited), which produces nonsense prices — filtered by the
// MAX_XOFOOD_PER_TX guard below.
//
// Uses plain fetch() POST to the XRPL HTTP cluster — no xrpl.js needed.
const MAX_XOFOOD_PER_TX = 1_000_000; // any delivery above this is a "sell any amount" order

async function fetchXrplAccountTxPrice(token) {
  try {
    const resp = await fetch(XRPL_HTTP, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        method: "account_tx",
        params: [{
          account:          token.issuer,
          limit:            50,
          ledger_index_min: -1,
          ledger_index_max: -1,
        }],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const txns = data?.result?.transactions ?? [];

    for (const item of txns) {
      const tx   = item.tx_json ?? item.tx;
      const meta = item.meta    ?? item.metaData;
      if (!tx || !meta || meta.TransactionResult !== "tesSUCCESS") continue;
      if (tx.TransactionType !== "Payment") continue;

      const sm = tx.SendMax;
      const da = meta.delivered_amount;

      // BUY pattern: sendMax is XRP drops (string), deliveredAmount is token (object)
      const smIsXrp  = typeof sm === "string";
      const daIsToken = typeof da === "object"
        && (da.currency === token.currency || da.currency === token.symbol)
        && da.issuer === token.issuer;

      if (!smIsXrp || !daIsToken) continue;

      const xrpPaid     = parseInt(sm, 10) / 1e6;
      const tokenRecvd  = parseFloat(da.value);

      // Filter out "unlimited sell" orders where sendMax is a tiny XRP amount
      // but deliveredAmount.value is absurdly large (seller set limit to huge number)
      if (tokenRecvd <= 0 || tokenRecvd > MAX_XOFOOD_PER_TX) continue;
      if (xrpPaid <= 0) continue;

      const priceXrp = xrpPaid / tokenRecvd;
      console.log(`[collect-prices] ${token.symbol} via account_tx: ${xrpPaid} XRP for ${tokenRecvd} ${token.symbol} → price ${priceXrp} XRP`);
      return priceXrp;
    }

    console.warn(`[collect-prices] No valid ${token.symbol} payment found in last ${txns.length} txns`);
    return null;
  } catch (e) {
    console.error(`[collect-prices] account_tx fetch failed: ${e.message}`);
    return null;
  }
}

// ─── PRICE ROUTER ─────────────────────────────
async function fetchTokenPrice(token) {
  if (token.source === "onthedex")        return fetchOnthedexPrice(token);
  if (token.source === "xrpl_account_tx") return fetchXrplAccountTxPrice(token);
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
// Stores a row every run regardless of price change — dense data is required
// for charts to render correctly on all timeframes.
export const handler = schedule("*/5 * * * *", async () => {
  console.log(`[collect-prices] Starting run at ${new Date().toISOString()}`);

  // 1. Get XRP/USD rate
  const xrpUsd = await fetchXrpUsd();
  console.log(`[collect-prices] XRP/USD: ${xrpUsd ?? "unavailable"}`);

  const rows = [];

  // 2. Fetch price for each token using its designated source
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
