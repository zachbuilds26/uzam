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
    return { ok: false, status: 0, error: `network error: ${e instanceof Error ? e.message : String(e)}` };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    return { ok: false, status: res.status, error: `non-JSON response (HTTP ${res.status})` };
  }
  if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}: code ${json?.code ?? "?"} ${json?.msg ?? "unknown"}` };
  if (json && String(json.code) !== "0") {
    return { ok: false, status: res.status, error: `OKX code ${json.code}: ${json.msg ?? "unknown"}` };
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
}
