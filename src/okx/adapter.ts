// OKX Onchain OS adapter — the ONLY place with OKX-specific code.
// Endpoints + auth scheme follow the official OKX Onchain OS docs:
// - GET  /api/v6/dex/market/token/search (Basic tier)
// - POST /api/v6/dex/market/price (Basic tier)
// - POST /api/v6/dex/market/price-info (Premium tier)
// - GET  /api/v6/dex/market/token/holder (Premium tier)
// - GET  /api/v6/dex/market/token/advanced-info (Premium tier)
// Auth: OK-ACCESS-KEY / SIGN / TIMESTAMP / PASSPHRASE (+ PROJECT if set).
// Sign = Base64(HMAC_SHA256(timestamp + METHOD + requestPath + body, secret)).
// The rest of Uzam never touches OKX directly — it calls this adapter.
//
// Tier note: search/price/candles/trades/top-liquidity/basic-info are Basic;
// price-info/holder/advanced-info/historical-candles are Premium. A Basic-only
// key gets HTTP 402 or a permission error on Premium calls — the adapter
// surfaces those as `missing[]` entries, never crashes.

import { createHmac } from "node:crypto";

const BASE = "https://web3.okx.com";
export const XLAYER_CHAIN_INDEX = "196";

export type OkxConfig = {
  key: string;
  secret: string;
  passphrase: string;
  projectId?: string;
};

export function loadOkxConfig(): OkxConfig | null {
  const key = (process.env.OKX_ACCESS_KEY ?? "").trim();
  const secret = (process.env.OKX_SECRET_KEY ?? process.env.OKX_API_SECRET ?? "").trim();
  const passphrase = (process.env.OKX_PASSPHRASE ?? process.env.OKX_API_PASSPHRASE ?? "").trim();
  if (!key || !secret || !passphrase) return null;
  const projectId = (process.env.OKX_PROJECT_ID ?? "").trim() || undefined;
  return { key, secret, passphrase, projectId };
}

function signature(timestamp: string, method: string, requestPath: string, body: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(timestamp + method.toUpperCase() + requestPath + body)
    .digest("base64");
}

export type OkxResult = {
  ok: boolean;
  status: number;
  // Raw `data` field from OKX when code == "0", else undefined.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  error?: string;
};

async function signedFetch(
  cfg: OkxConfig,
  method: "GET" | "POST",
  path: string,
  // For GET: query string WITHOUT leading "?". For POST: ignored (body built below).
  query: string,
  // For POST: the payload object — stringified ONCE here so the signed bytes
  // and the sent bytes can never diverge. For GET: undefined.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postBody?: any,
  timeoutMs = 15000
): Promise<OkxResult> {
  const timestamp = new Date().toISOString();
  const requestPath = method === "GET" && query ? `${path}?${query}` : path;
  const body = method === "POST" && postBody !== undefined ? JSON.stringify(postBody) : "";
  const headers: Record<string, string> = {
    "OK-ACCESS-KEY": cfg.key,
    "OK-ACCESS-SIGN": signature(timestamp, method, requestPath, body, cfg.secret),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": cfg.passphrase,
  };
  if (method === "POST") headers["Content-Type"] = "application/json";
  if (cfg.projectId) headers["OK-ACCESS-PROJECT"] = cfg.projectId;

  let res: Response;
  try {
    res = await fetch(`${BASE}${requestPath}`, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // One retry for transient network failures only (never for 4xx/auth).
    await new Promise((r) => setTimeout(r, 500));
    try {
      res = await fetch(`${BASE}${requestPath}`, {
        method,
        headers,
        body: method === "POST" ? body : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e2) {
      return { ok: false, status: 0, error: `network error: ${e2 instanceof Error ? e2.message : String(e2)}` };
    }
    void e;
  }
  // Cap the body before parsing: an authed endpoint returning an error page
  // must not buffer unbounded bytes. 1 MB is far above any market payload.
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { ok: false, status: res.status, error: `unreadable response (HTTP ${res.status})` };
  }
  if (text.length > 1_000_000) {
    return { ok: false, status: res.status, error: `response too large (${text.length} chars)` };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, error: `non-JSON response (HTTP ${res.status})` };
  }
  if (!res.ok) {
    const msg = String(json?.msg ?? "unknown").slice(0, 200);
    const code = json?.code ?? "?";
    const clockHint =
      res.status === 401 ? " (if persistent, check server clock/NTP — skewed timestamps fail auth)" : "";
    return { ok: false, status: res.status, error: `HTTP ${res.status}: code ${code} ${msg}${clockHint}` };
  }
  if (json && String(json.code) !== "0") {
    // 429 / 50011 = rate limit: surface immediately (no retry loop — the
    // caller records missing[] and degrades instead of hammering quota).
    const msg = String(json.msg ?? "unknown").slice(0, 200);
    return { ok: false, status: res.status, error: `OKX code ${json.code}: ${msg}` };
  }
  if (json == null || json.data === undefined) {
    return { ok: false, status: res.status, error: "missing data field in OKX response" };
  }
  return { ok: true, status: res.status, data: json.data };
}

export class OKXOnchainAdapter {
  constructor(private cfg: OkxConfig) {}

  /** Basic tier: search by symbol on a chain (e.g. chains=196, search=AAPLx). First page only. */
  async searchToken(chains: string, search: string): Promise<OkxResult> {
    const q = `chains=${encodeURIComponent(chains)}&search=${encodeURIComponent(search)}`;
    return signedFetch(this.cfg, "GET", "/api/v6/dex/market/token/search", q);
  }

  /** Basic tier: latest price for [{ chainIndex, tokenContractAddress }]. */
  async getPrice(items: { chainIndex: string; tokenContractAddress: string }[]): Promise<OkxResult> {
    return signedFetch(this.cfg, "POST", "/api/v6/dex/market/price", "", items);
  }

  /** Premium tier: full trading info (holders count, liquidity, volume, txs). */
  async getPriceInfo(items: { chainIndex: string; tokenContractAddress: string }[]): Promise<OkxResult> {
    return signedFetch(this.cfg, "POST", "/api/v6/dex/market/price-info", "", items);
  }

  /** Premium tier: top holder addresses with percentages. First page only (limit, no cursor). */
  async getHolders(chainIndex: string, tokenContractAddress: string, limit = "20"): Promise<OkxResult> {
    const addr = tokenContractAddress.toLowerCase();
    const q = `chainIndex=${encodeURIComponent(chainIndex)}&tokenContractAddress=${encodeURIComponent(
      addr
    )}&limit=${encodeURIComponent(limit)}`;
    return signedFetch(this.cfg, "GET", "/api/v6/dex/market/token/holder", q);
  }

  /** Premium tier: stockProfile for RWA tokens, top10HoldPercent, risk flags. */
  async getAdvancedInfo(chainIndex: string, tokenContractAddress: string): Promise<OkxResult> {
    const addr = tokenContractAddress.toLowerCase();
    const q = `chainIndex=${encodeURIComponent(chainIndex)}&tokenContractAddress=${encodeURIComponent(
      addr
    )}`;
    return signedFetch(this.cfg, "GET", "/api/v6/dex/market/token/advanced-info", q);
  }

  /** Basic tier: OHLCV candles. bar e.g. "1Dutc" (daily), "1H", "4H". limit <= 100. */
  async getCandles(chainIndex: string, tokenContractAddress: string, bar = "1Dutc", limit = "30"): Promise<OkxResult> {
    const addr = tokenContractAddress.toLowerCase();
    const q = `chainIndex=${encodeURIComponent(chainIndex)}&tokenContractAddress=${encodeURIComponent(
      addr
    )}&bar=${encodeURIComponent(bar)}&limit=${encodeURIComponent(limit)}`;
    return signedFetch(this.cfg, "GET", "/api/v6/dex/market/candles", q);
  }

  /** Basic tier: recent trades (side, size, price, dex, tx hash). limit <= 100. */
  async getTrades(chainIndex: string, tokenContractAddress: string, limit = "20"): Promise<OkxResult> {
    const addr = tokenContractAddress.toLowerCase();
    const q = `chainIndex=${encodeURIComponent(chainIndex)}&tokenContractAddress=${encodeURIComponent(
      addr
    )}&limit=${encodeURIComponent(limit)}`;
    return signedFetch(this.cfg, "GET", "/api/v6/dex/market/trades", q);
  }

  /** Basic tier: top-5 liquidity pools (protocol, USD liquidity, fee). No paging. */
  async getTopLiquidity(chainIndex: string, tokenContractAddress: string): Promise<OkxResult> {
    const addr = tokenContractAddress.toLowerCase();
    const q = `chainIndex=${encodeURIComponent(chainIndex)}&tokenContractAddress=${encodeURIComponent(
      addr
    )}`;
    return signedFetch(this.cfg, "GET", "/api/v6/dex/market/token/top-liquidity", q);
  }

  /** Basic tier: token metadata cards (name/symbol/decimals/logo), batched. */
  async getBasicInfo(items: { chainIndex: string; tokenContractAddress: string }[]): Promise<OkxResult> {
    return signedFetch(this.cfg, "POST", "/api/v6/dex/market/token/basic-info", "", items);
  }
}
