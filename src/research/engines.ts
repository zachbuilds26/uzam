// Research engines — composition layer for research_asset + compare_assets.
// The single-asset tools in server.ts stay as they are; this module composes
// the same primitives (registry, OKX adapter, page fetcher) into full reports.
// Future refactor: make server.ts tools thin wrappers around these gathers.

import registryJson from "../data/xlayer-assets.json" with { type: "json" };
import { OKXOnchainAdapter, loadOkxConfig, XLAYER_CHAIN_INDEX } from "../okx/adapter.js";
import {
  fetchPage, extractPassages, BACKING_KEYWORDS, REDEMPTION_KEYWORDS, fetchNews,
  tierOf, itemConfidence,
} from "./provider.js";
import { normalizeLang, t, sev, langFallbackNote } from "./i18n.js";
import { planResearch, planFlags } from "./planner.js";
import type { SourceType } from "./provider.js";

type RegistryAsset = {
  symbol: string;
  name: string;
  asset_type: string;
  issuer: string;
  issuer_legal?: string;
  underlying_asset: string;
  underlying?: { ticker: string; exchange: string; cik: string | null; sec_filings: string };
  chains: string[];
  chainIds: number[];
  contract_addresses: string[];
  product_page?: string;
  issuer_published_contract?: string;
  official_website: string;
  official_documents: string[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyObj = Record<string, any>;

const registry = registryJson as {
  chain: { name: string; chainId: number; chainIndex: number };
  tokenlist: string;
  tokenlist_raw?: string;
  assets: RegistryAsset[];
};

const CHAIN_ID_196 = registry.chain.chainId;

/** Chain facts for API layers that don't own the registry (identify parity). */
export function chainMeta(): { name: string; chainId: number; chainIndex: number; rpc: string | null; explorer: string | null } {
  const c = (registryJson as AnyObj).chain as AnyObj | undefined;
  return {
    name: String(c?.name ?? "X Layer"),
    chainId: Number(c?.chainId ?? 196),
    chainIndex: Number(c?.chainIndex ?? 196),
    rpc: typeof c?.rpc === "string" ? c.rpc : null,
    explorer: typeof c?.explorer === "string" ? c.explorer : null,
  };
}

export const now = (): string => new Date().toISOString();

export function findAsset(symbol: string): RegistryAsset | undefined {
  const clean = symbol.trim().toUpperCase();
  return registry.assets.find((a) => a.symbol.toUpperCase() === clean);
}

export function supportedSymbols(): string[] {
  return registry.assets.map((a) => a.symbol);
}

// ---- Independent verification: Backed xStocks tokenlist (third-party, Tier 2) ----
// Checks the OKX-resolved contract against the public tokenlist for chain 196.
// Cached in memory for 1h so we don't refetch ~3500 tokens per call.
// Single source of truth for the independent tokenlist (mirrors registry).
const TOKENLIST_RAW =
  registry.tokenlist_raw ?? "https://raw.githubusercontent.com/backed-fi/cowswap-xstocks-tokenlist/main/tokenlist.json";

/** Tokenlist URL for API layers (identify parity). */
export function tokenlistRaw(): string {
  return TOKENLIST_RAW;
}
let tlCache: { at: number; tokens: AnyObj[] } | null = null;
let tlInflight: Promise<AnyObj[]> | null = null;
let tlFailedAt = 0;

function lookupTokenlist(contract: string): { listed: boolean; matched_symbol: string | null } {
  const hit = tlCache?.tokens.find(
    (t) => Number(t.chainId) === CHAIN_ID_196 && String(t.address ?? "").toLowerCase() === contract.toLowerCase()
  );
  return { listed: !!hit, matched_symbol: hit ? String((hit as AnyObj).symbol ?? "") : null };
}

async function fetchTokenlist(): Promise<AnyObj[]> {
  if (!tlInflight) {
    tlInflight = (async () => {
      const res = await fetch(TOKENLIST_RAW, {
        headers: { "User-Agent": "uzam-mvp/0.1 (+research)" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`tokenlist HTTP ${res.status}`);
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > 5_000_000) throw new Error("tokenlist too large");
      const text = await res.text();
      if (text.length > 5_000_000) throw new Error("tokenlist too large");
      const json = JSON.parse(text) as AnyObj;
      const tokens = Array.isArray(json.tokens) ? (json.tokens as AnyObj[]) : [];
      tlCache = { at: Date.now(), tokens };
      return tokens;
    })().finally(() => {
      tlInflight = null;
    });
  }
  return tlInflight;
}

export async function verifyTokenlist(contract: string): Promise<{ listed: boolean; matched_symbol: string | null; stale?: boolean; error?: string }> {
  const fresh = tlCache && Date.now() - tlCache.at < 3600_000;
  if (fresh) return lookupTokenlist(contract);
  // Negative backoff: a dead tokenlist host must not cost every request a
  // doomed 20s fetch (compare would pay it 4x serially — now in parallel).
  if (Date.now() - tlFailedAt < 300_000) {
    if (tlCache) return { ...lookupTokenlist(contract), stale: true };
    return { listed: false, matched_symbol: null, error: "tokenlist fetch backing off (recent failure)" };
  }
  try {
    await fetchTokenlist();
    return lookupTokenlist(contract);
  } catch (e) {
    tlFailedAt = Date.now();
    if (tlCache) return { ...lookupTokenlist(contract), stale: true };
    return { listed: false, matched_symbol: null, error: `tokenlist fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---- Onchain gather (same flow as analyze_onchain: search -> price -> premium) ----
export async function gatherOnchain(clean: string, asset: RegistryAsset): Promise<AnyObj> {
  const dataTimestamp = now();
  const cfg = loadOkxConfig();
  if (!cfg) {
    return {
      found: true, symbol: asset.symbol, name: asset.name,
      chains: asset.chains, chainIds: asset.chainIds,
      onchain: null, missing: ["okx_credentials"], confidence: "UNKNOWN", data_timestamp: dataTimestamp,
    };
  }
  const okx = new OKXOnchainAdapter(cfg);
  const missing: string[] = [];
  const search = await okx.searchToken(XLAYER_CHAIN_INDEX, clean);
  let contract: string | null = null;
  let hit: AnyObj | null = null;
  if (search.ok && Array.isArray(search.data)) {
    const onX = (search.data as AnyObj[]).filter((t) => String(t.chainIndex) === XLAYER_CHAIN_INDEX);
    hit = onX.find((t) => String(t.tokenSymbol ?? "").toUpperCase() === clean) ?? null;
    if (hit?.tokenContractAddress) contract = String(hit.tokenContractAddress);
    if (!hit && onX.length > 0) {
      missing.push(`token_search: no exact ${clean} match on 196 (${onX.length} other token(s) ignored, e.g. ${onX.slice(0, 5).map((t) => String(t.tokenSymbol ?? "?")).join(", ")})`);
    }
  } else {
    missing.push(`token_search: ${search.error ?? "unknown error"}`);
  }
  if (!contract || !/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    missing.push(!contract ? "contract_on_xlayer" : "contract_on_xlayer: search returned a non-EVM address; refusing to query further");
    return {
      found: true, symbol: asset.symbol, name: asset.name,
      chains: asset.chains, chainIds: asset.chainIds, contracts: [],
      onchain: null, missing, confidence: "LOW", data_timestamp: dataTimestamp,
    };
  }
  const lc = contract.toLowerCase();
  const item = { chainIndex: XLAYER_CHAIN_INDEX, tokenContractAddress: lc };
  let price: AnyObj | null = null;
  let info: AnyObj | null = null;
  let advanced: AnyObj | null = null;
  let holders: AnyObj[] = [];
  const [priceRes, infoRes, advRes, holdRes] = await Promise.all([
    okx.getPrice([item]),
    okx.getPriceInfo([item]),
    okx.getAdvancedInfo(XLAYER_CHAIN_INDEX, lc),
    okx.getHolders(XLAYER_CHAIN_INDEX, lc, "20"),
  ]);
  if (priceRes.ok && Array.isArray(priceRes.data) && priceRes.data[0]) price = priceRes.data[0];
  else missing.push(`price: ${priceRes.error ?? "no data"}`);
  if (infoRes.ok && Array.isArray(infoRes.data) && infoRes.data[0]) info = infoRes.data[0];
  else missing.push(`price_info: ${infoRes.error ?? "no data (Premium tier?)"}`);
  if (advRes.ok && advRes.data) advanced = advRes.data as AnyObj;
  else missing.push(`advanced_info: ${advRes.error ?? "no data (Premium tier?)"}`);
  if (holdRes.ok && Array.isArray(holdRes.data)) holders = holdRes.data as AnyObj[];
  else missing.push(`holders: ${holdRes.error ?? "no data (Premium tier?)"}`);

  // Batch 2: history + activity (all Basic tier — works on any key).
  // Response arrays are capped BEFORE parsing: OKX `limit` params are hints,
  // a misbehaving upstream must not balloon CPU/memory downstream.
  let candles: AnyObj[] = [];
  let trades: AnyObj[] = [];
  let pools: AnyObj[] = [];
  let meta: AnyObj | null = null;
  const [candleRes, tradeRes, poolRes, metaRes] = await Promise.all([
    okx.getCandles(XLAYER_CHAIN_INDEX, lc, "1Dutc", "30"),
    okx.getTrades(XLAYER_CHAIN_INDEX, lc, "20"),
    okx.getTopLiquidity(XLAYER_CHAIN_INDEX, lc),
    okx.getBasicInfo([item]),
  ]);
  if (candleRes.ok && Array.isArray(candleRes.data)) candles = (candleRes.data as AnyObj[]).slice(0, 200);
  else missing.push(`candles: ${candleRes.error ?? "no data"}`);
  if (tradeRes.ok && Array.isArray(tradeRes.data)) trades = (tradeRes.data as AnyObj[]).slice(0, 200);
  else missing.push(`trades: ${tradeRes.error ?? "no data"}`);
  if (poolRes.ok && Array.isArray(poolRes.data)) pools = poolRes.data as AnyObj[];
  else missing.push(`pools: ${poolRes.error ?? "no data"}`);
  if (metaRes.ok && Array.isArray(metaRes.data) && metaRes.data[0]) meta = metaRes.data[0] as AnyObj;
  else missing.push(`token_meta: ${metaRes.error ?? "no data"}`);

  const priceHistory = summarizeCandles(candles);
  const tradeFeed = summarizeTrades(trades);
  const poolBreakdown = summarizePools(pools);

  // Independent check: does the public tokenlist list this exact contract on 196?
  const extra_evidence: AnyObj[] = [];
  let tokenlist_check: AnyObj = { checked: false };
  const tl = await verifyTokenlist(contract);
  if (tl.error) {
    missing.push(`tokenlist: ${tl.error}`);
    tokenlist_check = { checked: false, error: tl.error };
  } else if (tl.listed) {
    tokenlist_check = { checked: true, listed: true, matched_symbol: tl.matched_symbol, ...(tl.stale ? { stale: true } : {}) };
    if (tl.stale) missing.push("tokenlist: showing stale cache (fetch failed)");
    extra_evidence.push({
      claim: "Independent tokenlist lists this exact contract on X Layer (chain 196).",
      source_title: "xStocks Token List (Backed, CowSwap format)",
      source_url: TOKENLIST_RAW,
      excerpt: `Contract ${contract} is listed as ${tl.matched_symbol} on chainId 196 — agrees with the OKX-resolved contract.`,
      basis: "fact", source_type: "third_party" as SourceType, tier: 2, confidence: "MEDIUM", retrieved_at: now(),
    });
  } else {
    tokenlist_check = { checked: true, listed: false, matched_symbol: null };
    missing.push("tokenlist: contract not found in the public xStocks tokenlist for chain 196");
  }

  // Second independent check: OKX-resolved vs issuer-published contract.
  // Agreement is Tier-1-flavored corroboration; mismatch becomes contradiction #4.
  let contract_crosscheck: AnyObj = { checked: false };
  const published = asset.issuer_published_contract ?? null;
  if (published && /^0x[0-9a-fA-F]{40}$/.test(published)) {
    if (published.toLowerCase() === contract.toLowerCase()) {
      contract_crosscheck = { checked: true, agrees: true };
      extra_evidence.push({
        claim: "OKX-resolved contract matches the issuer-published contract for this symbol.",
        source_title: "xStocks product data (issuer-published addresses)",
        source_url: asset.product_page ?? "https://xstocks.fi/products",
        excerpt: `Resolved contract equals the issuer-published address for ${asset.symbol} — observed agreement between two sources, corroboration rather than onchain proof of backing.`,
        basis: "claim", source_type: "official_issuer" as SourceType, tier: 1, confidence: "MEDIUM", retrieved_at: now(),
      });
    } else {
      contract_crosscheck = { checked: true, agrees: false, published, resolved: contract };
    }
  }

  const top = holders
    .map((h) => ({ address: String(h.holderWalletAddress ?? ""), percent: Number(h.holdPercent ?? 0) }))
    .filter((h) => h.address && Number.isFinite(h.percent))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 5);
  const top3 = top.slice(0, 3).reduce((s, h) => s + h.percent, 0);
  // Upstream free-text caps: exchange-controlled strings are display data,
  // never trusted content — cap before they enter observations/evidence.
  const capStr = (v: unknown, n = 200): string => String(v ?? "").slice(0, n);
  const sp = advanced?.stockProfile as { companyName?: unknown; stockCode?: unknown; exchange?: unknown } | undefined;
  const explorerUrl = typeof hit?.explorerUrl === "string" && hit.explorerUrl.startsWith("https://")
    ? hit.explorerUrl.slice(0, 500)
    : `https://www.okx.com/web3/explorer/xlayer/token/${contract}`;
  const observations: string[] = [];
  if (priceHistory) observations.push(`30d range: low ${priceHistory.low} / high ${priceHistory.high} (${priceHistory.points} daily candles, ${priceHistory.change_pct ?? "n/a"}% change).`);
  if (tradeFeed && (tradeFeed.buys + tradeFeed.sells) > 0) observations.push(`Recent trades: ${tradeFeed.buys} buys / ${tradeFeed.sells} sells in last ${tradeFeed.sampled} swaps.`);
  if (poolBreakdown && poolBreakdown.pools.length > 0) observations.push(`Liquidity sits in ${poolBreakdown.pools.length} pool(s), top: ${poolBreakdown.pools[0].label}.`);
  if (advanced?.top10HoldPercent !== null && advanced?.top10HoldPercent !== undefined && advanced?.top10HoldPercent !== "") observations.push(`Top 10 holders control ${advanced.top10HoldPercent}% of supply (OKX advanced-info).`);
  if (top.length > 0) observations.push(`Largest holder: ${top[0].address.slice(0, 10)}… at ${top[0].percent}%. Top 3 combined: ${top3.toFixed(2)}%.`);
  if (sp) {
    observations.push(
      `OKX reports underlying stock profile: ${capStr(sp.companyName)} (${capStr(sp.stockCode, 20)}, ${capStr(sp.exchange, 40)}). Cross-check against issuer docs — this is exchange data, not issuer verification.`
    );
  }
  if (missing.length > 0) observations.push(`Partial data: ${missing.length} source(s) unavailable. See missing[].`);
  if (tokenlist_check.listed) observations.push(`Independent tokenlist confirms this contract as ${tokenlist_check.matched_symbol} on X Layer — agrees with OKX.`);
  const ratios = tradeRatios(info?.volume24H, info?.liquidity ?? hit?.liquidity, info?.marketCap ?? hit?.marketCap, info?.txs24H);
  const sourcesAgree = (price ? 1 : 0) + (info ? 1 : 0) + (advanced ? 1 : 0) >= 2;
  return {
    found: true, symbol: asset.symbol, name: asset.name,
    chains: ["X Layer"], contracts: [contract],
    explorer: explorerUrl,
    search_price: hit?.price ?? null,
    stock_profile: advanced?.stockProfile ?? null,
    tokenlist_check,
    contract_crosscheck,
    extra_evidence,
    token_meta: meta ? {
      name: capStr(meta.name ?? meta.tokenName, 120) || null,
      symbol: capStr(meta.symbol ?? meta.tokenSymbol, 20) || null,
      decimals: Number.isInteger(Number(meta.decimals)) ? Number(meta.decimals) : null,
    } : null,
    supply: info?.circSupply ? { circulating: info.circSupply } : null,
    holders_count: toNum(info?.holders ?? hit?.holders),
    holder_concentration: {
      top10HoldPercent: advanced?.top10HoldPercent ?? null,
      top3Percent: top.length > 0 ? Number(top3.toFixed(2)) : null,
      remainder_after_top3: top.length > 0 ? Number((100 - top3).toFixed(2)) : null,
      topHolders: top,
    },
    trading_activity: {
      price: fmtMoney(price?.price ?? info?.price ?? hit?.price),
      price_raw: price?.price ?? info?.price ?? hit?.price ?? null,
      priceChange24H: info?.priceChange24H ?? hit?.change ?? null,
      volume24H: fmtMoney(info?.volume24H),
      volume24H_raw: info?.volume24H ?? null,
      txs24H: info?.txs24H ?? null,
      liquidity: fmtMoney(info?.liquidity ?? hit?.liquidity),
      liquidity_raw: info?.liquidity ?? hit?.liquidity ?? null,
      marketCap: fmtMoney(info?.marketCap ?? hit?.marketCap),
      marketCap_raw: info?.marketCap ?? hit?.marketCap ?? null,
      turnover_24h: ratios.turnover_24h,
      liquidity_to_mcap: ratios.liquidity_to_mcap,
      avg_trade_size: ratios.avg_trade_size,
    },
    risk_flags: {
      riskControlLevel: advanced?.riskControlLevel ?? null,
      devHoldingPercent: advanced?.devHoldingPercent ?? null,
      bundleHoldingPercent: advanced?.bundleHoldingPercent ?? null,
      suspiciousHoldingPercent: advanced?.suspiciousHoldingPercent ?? null,
    },
    price_history: priceHistory,
    recent_trades: tradeFeed,
    pools: poolBreakdown,
    observations, missing,
    confidence: sourcesAgree ? "HIGH" : price || info ? "MEDIUM" : "LOW",
    data_timestamp: dataTimestamp,
  };
}

// ---- Live quote for identify: one price, fast, honestly capped ----
// Uses the issuer-published contract straight from the registry (one OKX
// call, no search) — with live OKX-search fallback if it's ever missing.
// Total budget 12s — a dead OKX returns "unavailable", never hangs identify.
export async function fetchLiveQuote(clean: string): Promise<AnyObj> {
  const stamp = now();
  const cfg = loadOkxConfig();
  if (!cfg) return { available: false, reason: "okx_credentials", data_timestamp: stamp };
  try {
    const work = (async (): Promise<AnyObj> => {
      const okx = new OKXOnchainAdapter(cfg);
      const known = findAsset(clean)?.issuer_published_contract ?? null;
      let contract: string | null = known && /^0x[0-9a-fA-F]{40}$/.test(known) ? known : null;
      let hit: AnyObj | null = null;
      let via: string = "issuer_published";
      if (!contract) {
        via = "okx_search";
        const search = await okx.searchToken(XLAYER_CHAIN_INDEX, clean);
        if (search.ok && Array.isArray(search.data)) {
          const onX = (search.data as AnyObj[]).filter((x) => String(x.chainIndex) === XLAYER_CHAIN_INDEX);
          hit = onX.find((x) => String(x.tokenSymbol ?? "").toUpperCase() === clean) ?? null;
          if (hit?.tokenContractAddress) contract = String(hit.tokenContractAddress);
        } else {
          return { available: false, reason: `token_search: ${search.error ?? "unknown error"}`, data_timestamp: stamp };
        }
      }
      if (!contract || !/^0x[0-9a-fA-F]{40}$/.test(contract)) {
        return { available: false, reason: "contract_on_xlayer", data_timestamp: stamp };
      }
      const lc = contract.toLowerCase();
      const priceRes = await okx.getPrice([{ chainIndex: XLAYER_CHAIN_INDEX, tokenContractAddress: lc }]);
      const p = priceRes.ok && Array.isArray(priceRes.data) && priceRes.data[0] ? (priceRes.data[0] as AnyObj) : null;
      if (!p) return { available: false, reason: `price: ${priceRes.error ?? "no data"}`, contracts: [contract], data_timestamp: stamp };
      return {
        available: true,
        price: fmtMoney(p.price ?? hit?.price),
        price_raw: p.price ?? hit?.price ?? null,
        contracts: [contract],
        contract_source: via,
        explorer: typeof hit?.explorerUrl === "string" && hit.explorerUrl.startsWith("https://") ? hit.explorerUrl : `https://www.okx.com/web3/explorer/xlayer/token/${contract}`,
        data_timestamp: stamp,
      };
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<AnyObj>((resolve) => {
      timer = setTimeout(() => resolve({ available: false, reason: "timeout_12s", data_timestamp: stamp }), 12000);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (e) {
    return { available: false, reason: `quote failed: ${e instanceof Error ? e.message : String(e)}`, data_timestamp: stamp };
  }
}

// ---- Backing gather (same flow as analyze_backing: read official pages live) ----
export async function gatherBacking(asset: RegistryAsset): Promise<AnyObj> {
  const urls = [asset.official_website, ...asset.official_documents].filter(
    (u, i, arr): u is string => typeof u === "string" && u.startsWith("http") && arr.indexOf(u) === i
  );
  const evidence: AnyObj[] = [];
  const fetched: string[] = [];
  const failed: string[] = [];
  const fullTexts: string[] = [];
  const targets = urls.slice(0, 4);
  const docs = await Promise.all(targets.map((u) => fetchPage(u)));
  for (const doc of docs) {
    if (doc.ok && doc.text) {
      fetched.push(doc.url);
      fullTexts.push(doc.text);
      const st: SourceType = "official_issuer";
      for (const p of extractPassages(doc.text, BACKING_KEYWORDS)) {
        // Evidence capped at 10 with an explicit flag — unbounded excerpts
        // bloat every downstream report.
        if (evidence.length >= 10) break;
        evidence.push({
          claim: "Issuer describes backing/custody/redemption on its official site.",
          source_title: doc.title, source_url: doc.url, excerpt: p, basis: "claim",
          source_type: st, tier: tierOf(st), confidence: itemConfidence(st), retrieved_at: now(),
        });
      }
    } else {
      failed.push(`${doc.url} (${doc.error ?? `HTTP ${doc.status}`})`);
    }
  }
  const namedCustodian = detectNamedCustodian(evidence.map((e) => String(e.excerpt)));
  const redemptionExcerpts = extractPassages(fullTexts.join(" "), REDEMPTION_KEYWORDS, 4);
  // Geo: pull jurisdiction sentences from the same pages (no extra fetches).
  const geoExcerpts = extractPassages(fullTexts.join(" "), ["restricted", "prohibited", "not available", "excluded", "jurisdiction", "eligible countries"], 4);
  // Attestation links: URLs in page text mentioning attest/reserve/transparency.
  const attestationLinks = [...new Set(
    fullTexts.flatMap((t) => [...t.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0].replace(/[.,;]+$/, "")))
      .filter((u) => /attest|transparency|proof[-_]of[-_]reserve|reserve[-_]report/i.test(u))
  )].slice(0, 5);
  const unanswered: string[] = [];
  if (!namedCustodian) unanswered.push("No specific custodian named on the fetched official pages (custody arrangements are mentioned in general terms).");
  if (!evidence.some((e) => /redeem|redemption|cash value/i.test(String(e.excerpt)))) unanswered.push("No redemption mechanics found on the fetched official pages.");
  if (!evidence.some((e) => /reserve|attest|audit/i.test(String(e.excerpt)))) unanswered.push("No reserve report or attestation linked from the fetched official pages.");
  unanswered.push("No independent (non-issuer) verification of backing gathered in MVP — treat issuer statements as CLAIM, not FACT.");
  if (failed.length > 0) unanswered.push(`Could not read: ${failed.join("; ")}`);
  return {
    found: true, symbol: asset.symbol, name: asset.name,
    underlying_assets: [asset.underlying_asset],
    issuer_claim: evidence.length > 0
      ? "Issuer claims the token tracks the underlying 1:1 with backing held in custody — see quoted excerpts. CLAIM until independently verified."
      : "No backing statement extracted from official pages.",
    custodian: namedCustodian
      ? `${namedCustodian} (as named on the official page — still the issuer's claim, not independent verification).`
      : "UNKNOWN — pages mention custody arrangements but name no specific custodian.",
    redemption_excerpts: redemptionExcerpts,
    geo_excerpts: geoExcerpts,
    attestation_links: attestationLinks,
    evidence, evidence_truncated: evidence.length >= 10, pages_read: fetched,
    confidence: evidence.length >= 3 && fetched.length >= 2 ? "MEDIUM" : evidence.length > 0 ? "LOW" : "UNKNOWN",
    unanswered_questions: unanswered,
    data_timestamp: now(),
  };
}

// ---- Risk engine: 9 fixed categories, observed language, never "safe" ----
export type Risk = {
  category: string;
  severity: "low" | "moderate" | "high" | "unknown";
  reason: string;
  evidence: string[];
};

export function buildRisks(onchain: AnyObj, backing: AnyObj): Risk[] {
  // Thresholds (provisional, revisit after N reports — documented, not magic):
  // top-10 >80% ≈ single-wallet control; <$50k pool = one trade moves price.
  const CONC_HIGH = 80;
  const CONC_MODERATE = 50;
  const LIQ_HIGH = 50000;
  const LIQ_MODERATE = 500000;
  const top10 = toNum(onchain?.holder_concentration?.top10HoldPercent);
  // Raw figure for math (display strings round and can flip boundaries).
  const liq = toNum(onchain?.trading_activity?.liquidity_raw ?? onchain?.trading_activity?.liquidity);
  const missing: string[] = Array.isArray(onchain?.missing) ? onchain.missing : [];
  const cov = okxCoverage(missing);
  const uq: string[] | null = Array.isArray(backing?.unanswered_questions) ? backing.unanswered_questions : null;
  const redemptEx: unknown[] = Array.isArray(backing?.redemption_excerpts) ? backing.redemption_excerpts : [];
  const geoEx: unknown[] = Array.isArray(backing?.geo_excerpts) ? backing.geo_excerpts : [];
  const pagesRead: string[] = Array.isArray(backing?.pages_read) ? backing.pages_read : [];
  const backingConf: string | null = typeof backing?.confidence === "string" ? backing.confidence : null;
  const risks: Risk[] = [
    {
      category: "concentration",
      severity: top10 === null ? "unknown" : top10 > CONC_HIGH ? "high" : top10 > CONC_MODERATE ? "moderate" : "low",
      reason: top10 === null ? "No holder distribution data available." : `Top 10 holders control ${Number(top10.toFixed(2))}% of supply.`,
      evidence: top10 === null ? [] : ["okx:advanced-info:top10HoldPercent"],
    },
    {
      category: "liquidity",
      severity: liq === null ? "unknown" : liq < LIQ_HIGH ? "high" : liq < LIQ_MODERATE ? "moderate" : "low",
      reason: liq === null ? "No liquidity figure available." : `Observed pool liquidity $${fmtNum(liq) ?? liq} (OKX). Thin books can mean large price impact.`,
      evidence: liq === null ? [] : ["okx:price-info:liquidity"],
    },
    {
      // Weak or missing backing evidence is itself the risk — fail toward high.
      category: "backing",
      severity: backingConf === "HIGH" ? "low" : backingConf === "MEDIUM" ? "moderate" : "high",
      reason: `Backing evidence confidence is ${backingConf ?? "UNKNOWN"}. Issuer statements are claims until independently verified.`,
      evidence: ["uzam:analyze_backing"],
    },
    {
      // No data about redemption => unknown, never a reassuring low.
      category: "redemption",
      severity: uq === null ? "unknown" : redemptEx.length === 0 ? "moderate" : "low",
      reason: "Redemption eligibility, minimums and settlement must be confirmed in issuer terms before assuming exit is available.",
      evidence: ["uzam:analyze_backing"],
    },
    {
      category: "issuer",
      severity: pagesRead.length === 0 ? "unknown" : "low",
      reason: "xStocks/Backed is an established tokenized-equity issuer network (issuer claim — see evidence). Single-issuer dependency remains.",
      evidence: ["issuer:official_site"],
    },
    {
      category: "smart_contract",
      severity: "unknown",
      reason: "No contract audit reviewed in the MVP. Unknown until audit sources are added.",
      evidence: [],
    },
    {
      category: "counterparty",
      severity: "moderate",
      reason: "Token value depends on the issuer, custodian and their intermediaries performing — not just the smart contract.",
      evidence: ["uzam:analyze_backing"],
    },
    {
      category: "regulatory_access",
      severity: geoEx.length > 0 ? "moderate" : "unknown",
      reason: "Tokenized equities typically carry geo and eligibility restrictions (e.g. xStocks excludes several jurisdictions). Confirm eligibility in issuer terms.",
      evidence: ["issuer:terms"],
    },
    {
      category: "information",
      severity: cov.ok >= cov.total ? "low" : cov.ok >= 5 ? "moderate" : "high",
      reason: cov.ok >= cov.total ? "All 7 OKX endpoints returned data." : `Only ${cov.ok}/${cov.total} OKX endpoints returned data: ${missing.join("; ")}.`,
      evidence: [],
    },
  ];
  return risks;
}

// ---- Contradiction detection (PDF section 18): never silently pick a side ----
export function detectContradictions(asset: RegistryAsset, onchain: AnyObj): AnyObj[] {
  const out: AnyObj[] = [];
  // Check 1: underlying code — registry explicit ticker preferred (ETF-safe).
  const expected = (asset.underlying?.ticker ?? asset.underlying_asset.split(/[\s(]/)[0]).toUpperCase();
  const reported = onchain?.stock_profile?.stockCode ? String(onchain.stock_profile.stockCode).toUpperCase() : null;
  if (expected && reported && expected !== reported) {
    out.push({
      issue: `Underlying code differs: registry says ${expected}, OKX reports ${reported}.`,
      source_a: { name: "Uzam registry", value: asset.underlying_asset },
      source_b: { name: "OKX advanced-info stockProfile", value: onchain.stock_profile },
      status: "conflict",
      recommended_action: "Review the latest issuer Final Terms / prospectus before concluding which exposure is correct.",
    });
  }
  // Check 2: price consistency — OKX search quote vs price endpoint (raws).
  const a = Number(onchain?.search_price);
  const b = Number(onchain?.trading_activity?.price_raw ?? onchain?.trading_activity?.price);
  if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) {
    const drift = Math.abs(a - b) / ((a + b) / 2);
    if (drift > 0.1) {
      out.push({
        issue: `OKX price sources disagree by ${(drift * 100).toFixed(1)}% (search: ${a}, price endpoint: ${b}).`,
        source_a: { name: "OKX token/search", value: a },
        source_b: { name: "OKX market/price", value: b },
        status: "conflict",
        recommended_action: "Treat price as approximate; re-query before any time-sensitive use.",
      });
    }
  }
  // Check 3: tokenlist symbol vs requested symbol.
  const tl = onchain?.tokenlist_check;
  if (tl?.checked && tl?.listed && tl?.matched_symbol && String(tl.matched_symbol).toUpperCase() !== asset.symbol.toUpperCase()) {
    out.push({
      issue: `Tokenlist lists this contract as ${tl.matched_symbol}, but research was requested for ${asset.symbol}.`,
      source_a: { name: "Uzam registry / request", value: asset.symbol },
      source_b: { name: "xStocks tokenlist (chain 196)", value: tl.matched_symbol },
      status: "conflict",
      recommended_action: "Do not assume these are the same product — verify the contract in the issuer's Final Terms.",
    });
  }
  // Check 4: OKX-resolved contract vs the issuer-published contract
  // (from xStocks' own product data). A mismatch smells like a lookalike token.
  const published = asset.issuer_published_contract ?? null;
  const resolved = Array.isArray(onchain?.contracts) && onchain.contracts[0] ? String(onchain.contracts[0]) : null;
  if (published && resolved && published.toLowerCase() !== resolved.toLowerCase()) {
    out.push({
      issue: `Contract mismatch: OKX search resolved ${resolved}, but xStocks publishes ${published} for ${asset.symbol}.`,
      source_a: { name: "OKX token search (chainIndex 196)", value: resolved },
      source_b: { name: "xStocks product data (issuer-published)", value: published },
      status: "conflict",
      recommended_action: "Treat the token as unverified — one of these is a lookalike. Confirm via the issuer's Final Terms before any use.",
    });
  }
  return out;
}

// ---- Recent developments via keyless news RSS (Tier 2, never Tier 1) ----
// Filler filter: RSS search returns price-converter/calculator pages
// ("Convert 50 USD to NVDAX", "NVDAX to INR Live Price") which are not news.
// Those are dropped; if everything drops we say so instead of showing filler.
const NEWS_FILLER = /convert \d+|calculator|live price|price today|price prediction|price forecast|converter|how much is|worth today/i;

export async function gatherRecent(asset: RegistryAsset): Promise<{ items: AnyObj[]; note: string }> {
  const company = asset.underlying_asset.split("(")[0].trim();
  const { items, error } = await fetchNews(`${asset.symbol} xStocks ${company}`.slice(0, 120));
  if (error) return { items: [], note: `News unavailable: ${error}.` };
  const st: SourceType = "reputable_news";
  const real = items.filter((n) => !NEWS_FILLER.test(`${n.title} ${n.url}`));
  const dropped = items.length - real.length;
  return {
    items: real.map((n) => ({
      title: n.title, url: n.url, source: n.source, published_at: n.published_at,
      source_type: st, tier: tierOf(st), confidence: itemConfidence(st), retrieved_at: now(),
    })),
    note: dropped > 0 && real.length === 0
      ? `News search returned only price-converter pages (${dropped} excluded as filler).`
      : dropped > 0 ? `${dropped} converter page(s) excluded as filler.` : "",
  };
}

// ---- Shared honesty helpers ----

// Missing values are null — never 0. Number(null)===0 would turn gaps into fake data.
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === "" || typeof v === "boolean";
}

export function toNum(v: unknown): number | null {
  if (isBlank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function hasNum(v: unknown): boolean {
  return toNum(v) !== null;
}

export function pct(v: unknown): string {
  const n = toNum(v);
  return n === null ? "n/a" : `${Number(n.toFixed(2))}%`;
}

// Money for display: 2 decimals. Raw strings stay in *_raw fields.
export function fmtMoney(v: unknown): string | null {
  const n = toNum(v);
  return n === null ? null : n.toFixed(2);
}

// Big numbers for humans: thousands separators, fixed decimals.
// Data stays raw in *_raw fields; this is display-only, always en-US
// (digits are data, never translated).
export function fmtNum(v: unknown, digits = 2): string | null {
  const n = toNum(v);
  if (n === null) return null;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Excerpts cut at a word boundary — never mid-word ("...to lear").
export function cutWords(s: string, max = 200): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(" ", max);
  return (cut > max * 0.5 ? s.slice(0, cut) : s.slice(0, max)).trimEnd() + "…";
}

// ---- Shared OKX coverage counter: ONE definition, used by receipt,
// verdict box and unknowns alike so the numbers can never disagree.
// The 7 counted endpoints are the data calls; token_search/tokenlist are
// resolution steps and are reported separately in missing[], not here.
const OKX_CORE = ["price", "price_info", "advanced_info", "holders", "candles", "trades", "pools"];

export function okxCoverage(missing: unknown): { ok: number; total: number } {
  const total = OKX_CORE.length;
  // Absent list proves nothing — never count it as full coverage.
  if (!Array.isArray(missing)) return { ok: 0, total };
  // No credentials, no identity, or no contract = no data call was possible.
  // Colon-suffixed variants (e.g. "contract_on_xlayer: ...") must match too.
  const strs = missing.map((m) => String(m).split(":")[0].trim());
  if (
    strs.includes("skipped_by_focus") ||
    strs.includes("skipped_by_plan") ||
    strs.includes("okx_credentials") ||
    strs.includes("asset_identity") ||
    strs.includes("contract_on_xlayer")
  ) return { ok: 0, total };
  const failed = new Set(strs);
  return { ok: OKX_CORE.filter((k) => !failed.has(k)).length, total };
}

// ---- Candle / trade / pool summarizers (defensive: array-row or object rows) ----
// OKX candles come back as [ts,o,h,l,c,vol,volUsd,confirm] rows or objects;
// either shape yields the same range summary. Garbage in -> null, never 0.
export function summarizeCandles(candles: AnyObj[]): { points: number; high: string | null; low: string | null; first_close: string | null; last_close: string | null; change_pct: string | null } | null {
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  for (const c of candles) {
    const row = Array.isArray(c) ? { t: c[0], o: c[1], h: c[2], l: c[3], c: c[4] } : c;
    const h = toNum(row.h ?? row.high), l = toNum(row.l ?? row.low), cl = toNum(row.c ?? row.close ?? row.price);
    if (h !== null) highs.push(h);
    if (l !== null) lows.push(l);
    if (cl !== null) closes.push(cl);
  }
  if (closes.length < 2 && highs.length === 0) return null;
  const high = highs.length > 0 ? Math.max(...highs) : Math.max(...closes);
  const low = lows.length > 0 ? Math.min(...lows) : Math.min(...closes);
  const first = closes[0] ?? null, last = closes[closes.length - 1] ?? null;
  const change = first !== null && last !== null && first > 0 ? Number((((last - first) / first) * 100).toFixed(2)) : null;
  return {
    points: Math.max(closes.length, highs.length, lows.length),
    high: high.toFixed(2), low: low.toFixed(2),
    first_close: first !== null ? first.toFixed(2) : null,
    last_close: last !== null ? last.toFixed(2) : null,
    change_pct: change !== null ? String(change) : null,
  };
}

export function summarizeTrades(trades: AnyObj[]): { sampled: number; buys: number; sells: number; latest: AnyObj[] } | null {
  if (trades.length === 0) return null;
  let buys = 0, sells = 0;
  const latest: AnyObj[] = [];
  for (const t of trades) {
    const side = String(t.side ?? t.direction ?? t.action ?? "").toLowerCase();
    if (side.startsWith("buy")) buys++;
    else if (side.startsWith("sell")) sells++;
    if (latest.length < 5) {
      latest.push({
        side: side || null,
        size: fmtMoney(t.amount ?? t.volume ?? t.quantity ?? t.tokenAmount),
        price: fmtMoney(t.price ?? t.tokenPrice),
        tx: t.txHash ?? t.hash ?? t.transactionHash ?? null,
        dex: t.dex ?? t.protocol ?? t.exchange ?? null,
      });
    }
  }
  return { sampled: trades.length, buys, sells, latest };
}

export function summarizePools(pools: AnyObj[]): { pools: { label: string; liquidity_usd: string | null }[]; total_liquidity_usd: string | null } | null {
  if (pools.length === 0) return null;
  const rows = pools.slice(0, 5).map((p, i) => {
    const liq = toNum(p.liquidityUsd ?? p.liquidity ?? p.tvl ?? p.tvlUsd);
    const who = p.protocol ?? p.dex ?? p.exchange ?? p.dexName ?? p.protocolName ?? p.name ?? null;
    const addr = p.poolAddress ?? p.address ?? p.pairAddress ?? null;
    const label = `${who ? `${who} ` : ""}Pool ${i + 1}${typeof addr === "string" && addr.length > 10 ? ` (${addr.slice(0, 6)}…${addr.slice(-4)})` : ""} ${p.fee ?? p.feeRate ?? ""}`.trim();
    return { label, liquidity_usd: liq !== null ? liq.toFixed(2) : null, _n: liq ?? 0 };
  });
  const total = rows.reduce((s, r) => s + r._n, 0);
  return {
    pools: rows.map(({ label, liquidity_usd }) => ({ label, liquidity_usd })),
    total_liquidity_usd: total > 0 ? total.toFixed(2) : null,
  };
}

// Derived market ratios from fields OKX already returns — pure arithmetic.
export function tradeRatios(volume24H: unknown, liquidity: unknown, marketCap: unknown, txs24H: unknown): { turnover_24h: number | null; liquidity_to_mcap: number | null; avg_trade_size: string | null } {  const vol = toNum(volume24H);
  const liq = toNum(liquidity);
  const mc = toNum(marketCap);
  const txs = toNum(txs24H);
  return {
    turnover_24h: vol !== null && liq !== null && liq > 0 ? Number((vol / liq).toFixed(4)) : null,
    liquidity_to_mcap: liq !== null && mc !== null && mc > 0 ? Number((liq / mc).toFixed(4)) : null,
    avg_trade_size: vol !== null && txs !== null && txs > 0 ? (vol / txs).toFixed(2) : null,
  };
}

// A custodian is only "named" if an excerpt actually names an entity.
// Patterns are case-SENSITIVE on purpose: with /i, "custody by them" would
// capture "them" as a custodian. Generic words are blocklisted below.
const CUSTODIAN_BLOCKLIST = /^(not|no|unknown|various|several|regulated|reputable|leading|qualified|independent|third[- ]party|external)\b/i;

export function detectNamedCustodian(excerpts: string[]): string | null {
  const patterns = [
    /(?:held in|in)\s+(?:regulated\s+)?custody\s+(?:by|with|through|at)\s+([A-Z][\w&.,'’\- ]{2,60})/,
    /([A-Z][\w&.,'’\- ]{2,60}?)\s+(?:acts?|serves?)\s+as\s+(?:the\s+)?custodian/,
    /custodian\s*(?:is|:)\s*([A-Z][\w&.,'’\- ]{2,60})/,
  ];
  for (const p of excerpts) {
    for (const re of patterns) {
      const m = p.match(re);
      if (!m || !m[1]) continue;
      const name = m[1].trim().replace(/[.,;:—-]+$/, "").trim();
      if (name && !CUSTODIAN_BLOCKLIST.test(name)) return name;
    }
  }
  return null;
}

// ---- Underlying spot price (Stooq free quote, no key) + market status ----
type Spot = { price: number | null; date: string | null; time: string | null; error?: string };
let spotCache: Record<string, { at: number; spot: Spot }> = {};

// Capped JSON fetch: fixed host + validated path segment + body cap before
// parse. Mirrors the tokenlist pattern — never bare res.json() on third parties.
async function fetchJsonCapped(
  url: string, headers: Record<string, string>, capBytes = 1_000_000, timeoutMs = 15000
): Promise<{ json?: AnyObj; error?: string; status?: number }> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { error: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { error: `unreadable body (HTTP ${res.status})`, status: res.status };
  }
  if (text.length > capBytes) return { error: `response too large (${text.length} chars)`, status: res.status };
  try {
    return { json: JSON.parse(text) as AnyObj };
  } catch {
    return { error: `non-JSON response (HTTP ${res.status})`, status: res.status };
  }
}

export async function fetchSpot(code: string): Promise<Spot & { stale?: boolean }> {
  if (!/^[A-Z][A-Z.]{0,9}$/.test(code)) {
    return { price: null, date: null, time: null, error: "invalid ticker for spot lookup" };
  }
  const key = code.toUpperCase();
  const cached = spotCache[key];
  if (cached && Date.now() - cached.at < 60_000) return cached.spot;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${key}?interval=1d&range=5d`;
  const fail = (error: string): Spot & { stale?: boolean } =>
    cached ? { ...cached.spot, stale: true } : { price: null, date: null, time: null, error };
  const out = await fetchJsonCapped(url, {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  });
  if (out.error || !out.json) return fail(`spot ${out.error ?? "unknown"}`);
  try {
    const meta = out.json?.chart?.result?.[0]?.meta;
    const px = Number(meta?.regularMarketPrice);
    const t = Number(meta?.regularMarketTime);
    if (!Number.isFinite(px) || px <= 0) return fail("spot quote unparseable");
    const spot: Spot = {
      price: px,
      date: t ? new Date(t * 1000).toISOString().slice(0, 10) : null,
      time: t ? new Date(t * 1000).toISOString().slice(11, 16) + " UTC" : null,
    };
    spotCache[key] = { at: Date.now(), spot };
    // LRU eviction: drop the oldest entry, never nuke the whole cache.
    const keys = Object.keys(spotCache);
    if (keys.length > 50) {
      const oldest = keys.sort((a, b) => spotCache[a].at - spotCache[b].at)[0];
      delete spotCache[oldest];
    }
    return spot;
  } catch (e) {
    return fail(`spot parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---- SEC EDGAR filings recency (keyless, UA header required) + dividends ----
export type FilingInfo = { form: string; date: string; url: string } | null;

export async function fetchLatestFilings(cik: string): Promise<{ k10: FilingInfo; q10: FilingInfo; error?: string }> {
  if (!/^\d{1,10}$/.test(cik)) return { k10: null, q10: null, error: "invalid CIK for filings lookup" };
  const padded = cik.padStart(10, "0");
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
  const out = await fetchJsonCapped(url, {
    "User-Agent": "uzam-mvp/0.1 (+research)", Accept: "application/json",
  });
  if (out.error || !out.json) return { k10: null, q10: null, error: `SEC ${out.error ?? "unknown"}` };
  try {
    const recent = out.json?.filings?.recent;
    if (!recent || !Array.isArray(recent.form)) return { k10: null, q10: null, error: "SEC response unparseable" };
    const pick = (form: string): FilingInfo => {
      const i = (recent.form as unknown[]).findIndex((f) => f === form);
      if (i < 0) return null;
      const acc = String(recent.accessionNumber?.[i] ?? "").replace(/-/g, "");
      const date = String(recent.filingDate?.[i] ?? "");
      if (!acc) return null;
      return { form, date, url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/` };
    };
    return { k10: pick("10-K"), q10: pick("10-Q") };
  } catch (e) {
    return { k10: null, q10: null, error: `SEC parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function fetchDividend(code: string): Promise<{ amount: string | null; date: string | null; error?: string }> {
  if (!/^[A-Z][A-Z.]{0,9}$/.test(code)) return { amount: null, date: null, error: "invalid ticker for dividend lookup" };
  const out = await fetchJsonCapped(`https://query1.finance.yahoo.com/v8/finance/chart/${code}?range=1y&interval=1mo&events=div`, {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  });
  if (out.error || !out.json) return { amount: null, date: null, error: `dividend ${out.error ?? "unknown"}` };
  try {
    const divs = out.json?.chart?.result?.[0]?.events?.dividends;
    if (!divs || typeof divs !== "object") return { amount: null, date: null };
    const entries = Object.values(divs as Record<string, AnyObj>);
    if (entries.length === 0) return { amount: null, date: null };
    const last = entries[entries.length - 1];
    const amt = Number(last.amount);
    return {
      amount: Number.isFinite(amt) ? amt.toFixed(4) : null,
      date: last.date ? new Date(Number(last.date) * 1000).toISOString().slice(0, 10) : null,
    };
  } catch (e) {
    return { amount: null, date: null, error: `dividend parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Nasdaq hours in America/New_York: Mon–Fri 09:30–16:00. Else closed.
// "unknown" on formatter failure — never mislabel a bug as a closed market.
export function marketStatus(at = new Date()): "open" | "closed" | "unknown" {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
    const day = parts.weekday ?? "";
    if (day === "Sat" || day === "Sun") return "closed";
    const mins = Number(parts.hour) * 60 + Number(parts.minute);
    return mins >= 570 && mins < 960 ? "open" : "closed";
  } catch {
    return "unknown";
  }
}

// ---- Human-readable summaries: structured markdown beside the JSON ----
// Agents get full JSON; humans (and chat answers) get this.
const SEV_RANK: Record<string, number> = { high: 0, moderate: 1, unknown: 2, low: 3 };

export function summarizeResearch(r: AnyObj): string {
  if (r.found !== true) return `**${r.symbol ?? "?"} — not identified.** ${r.uncertainty ?? ""} Supported: ${(r.supported_symbols ?? []).join(", ")}.`;
  const lang = normalizeLang(r.lang);
  const lines: string[] = [];
  const L = (k: string): string => t(lang, k);
  const ta = r.onchain.trading_activity ?? {};
  // Verdict box: numbers first, one screen.
  lines.push(`## ${r.asset.symbol} — ${r.asset.name} (X Layer)`);
  const snap = r.research_snapshot ?? {};
  lines.push(`### ${L("sec_snapshot")}`);
  lines.push(`- ${snap.symbol ?? r.asset.symbol} · ${snap.underlying_asset ?? ""} · ${snap.issuer ?? ""} · ${snap.chain ?? "X Layer"}`);
  lines.push(`- Research timestamp: ${snap.research_timestamp ?? r.data_timestamp} · Sources: ${snap.sources ?? "n/a"} (${snap.primary_sources ?? "n/a"} primary, ${snap.onchain_sources ?? "n/a"} on-chain)`);
  const rp = r.research_plan ?? null;
  if (rp) {
    lines.push(`### ${L("sec_plan")}`);
    if (rp.question) lines.push(`- Question: "${String(rp.question).slice(0, 200)}"`);
    lines.push(`- Needed: ${((rp.evidence_needed as string[] | undefined) ?? []).join(", ") || "full dossier"}`);
    const skipped = ((rp.skipped as AnyObj[] | undefined) ?? []).map((s) => String(s.evidence));
    if (skipped.length > 0) lines.push(`- Deliberately skipped: ${skipped.join(", ")} (not needed for this question)`);
    if (rp.note) lines.push(`- ${rp.note}`);
  }
  const findings = (r.executive_findings as AnyObj[] | undefined) ?? [];
  lines.push(`### ${L("sec_findings")}`);
  if (findings.length === 0) lines.push(`- None established — see unknowns.`);
  findings.forEach((f, i) => lines.push(`${i + 1}. ${f.finding} [${f.evidence_ref ?? "no ref"}]`));
  const ident = r.identity ?? {};
  const idChecks = (ident.verification_checks as AnyObj[] | undefined) ?? [];
  lines.push(`### ${L("sec_identity")}`);
  lines.push(`- Contract: ${ident.identity?.contract_address ?? "UNKNOWN"} · Standard/decimals: UNKNOWN (see explorer)`);
  lines.push(`- ${L("sec_checks")}: ${idChecks.filter((c) => c.verified).length}/${idChecks.length} ${L("id_verified")}`);
  const bd = r.backing_detail ?? {};
  lines.push(`### ${L("sec_backing")} — ${L("lbl_claim")} / ${L("lbl_verified_fact")} / ${L("lbl_onchain_obs")} / ${L("lbl_unknown")}`);
  lines.push(`- ${L("lbl_claim")}: ${cutWords(String(bd.issuer_claim ?? r.backing?.issuer_claim ?? "none extracted"), 220)}`);
  const verList = (bd.independently_verified as AnyObj[] | undefined) ?? [];
  lines.push(`- ${L("lbl_verified_fact")}: ${verList.length === 0 ? "none" : verList.map((v) => String(v.statement).slice(0, 140)).join(" | ")}`);
  const obsList = (bd.onchain_observation as AnyObj[] | undefined) ?? [];
  lines.push(`- ${L("lbl_onchain_obs")}: ${obsList.length === 0 ? "none" : obsList.map((o) => String(o.statement).slice(0, 140)).join(" | ")}`);
  lines.push(`- Reserve/supply reconciliation: ${bd.reconciliation?.note ?? "not possible — no reserve amount"}`);
  lines.push(`> ${L("lbl_overall")}: **${r.confidence.overall}** — ${confidenceReceipt(r)}`);
  lines.push(`> ${L("scale")}`);
  const pr = r.price_relationship ?? {};
  const premFormula = pr.difference_bps !== null && pr.difference_bps !== undefined && pr.reference_price
    ? `Premium = (token − underlying) / underlying, token ${pr.token_price ?? "n/a"} vs reference ${pr.reference_price} (${pr.timestamp ?? "no timestamp"}) — ${L("lbl_calc")}.${pr.market_status === "closed" ? " Underlying market was CLOSED — treat as stale, re-check when open." : ""}`
    : `No premium computed (${!pr.reference_price ? "underlying reference unavailable" : "no token price"}). ${pr.limitations ?? ""}`;
  lines.push(`### ${L("sec_price_rel")}`);
  lines.push(premFormula);
  // Market activity: everything OKX already returned, finally shown.
  const ph = r.onchain.price_history ?? null;
  const tf = r.onchain.recent_trades ?? null;
  const pb = r.onchain.pools ?? null;
  if (ph || tf || pb || ta.turnover_24h != null) {
    lines.push(`### ${L("sec_activity")}`);
    if (ph) lines.push(`- 30d range: low **${ph.low}** / high **${ph.high}** (${ph.points} daily candles, ${ph.change_pct ?? "n/a"}% change).`);
    if (tf && (tf.buys + tf.sells) > 0) {
      lines.push(`- Recent swaps: **${tf.buys} buys / ${tf.sells} sells** in last ${tf.sampled}.`);
      for (const s of (tf.latest ?? []).slice(0, 5)) {
        lines.push(`  - ${s.side ?? "?"} ${s.size ?? "?"} @ ${s.price ?? "?"}${s.dex ? ` via ${s.dex}` : ""}${s.tx ? ` (${String(s.tx).slice(0, 12)}…)` : ""}`);
      }
    }
    if (pb && (pb.pools ?? []).length > 0) {
      lines.push(`- Pools (${pb.pools.length}): ${pb.pools.map((p: AnyObj) => `${p.label} ($${p.liquidity_usd ?? "?"})`).join(" · ")}${pb.total_liquidity_usd ? ` — total $${pb.total_liquidity_usd}` : ""}.`);
    }
    if (ta.turnover_24h != null || ta.liquidity_to_mcap != null || ta.avg_trade_size != null) {
      const turn = toNum(ta.turnover_24h);
      lines.push(`- Turnover 24h: **${turn !== null ? `${turn.toFixed(2)}x` : "n/a"}** · Liquidity/mcap: **${ta.liquidity_to_mcap ?? "n/a"}** · Avg trade: **${ta.avg_trade_size ? `$${fmtNum(ta.avg_trade_size)}` : "n/a"}** · Txs 24h: **${ta.txs24H ?? "n/a"}** · Volume 24h: **$${fmtNum(ta.volume24H_raw) ?? "n/a"}** · Mcap: **$${fmtNum(ta.marketCap_raw) ?? "n/a"}**.`);
    }
    const impact = r.liquidity_detail?.price_impact ?? null;
    if (impact && Array.isArray(impact.venues) && impact.venues.length > 0) {
      lines.push(`### ${L("sec_liquidity_detail")} (${L("lbl_calc")})`);
      for (const v of impact.venues.slice(0, 5)) {
        const e = v.estimates ?? {};
        lines.push(`- ${v.venue} ($${v.liquidity_usd}): $100 → ${e.usd_100 ?? "n/a"} · $1k → ${e.usd_1000 ?? "n/a"} · $10k → ${e.usd_10000 ?? "n/a"}`);
      }
      lines.push(`- Method: ${impact.method}. ${impact.assumption}`);
    }
  }
  lines.push(`### ${L("sec_backing")}`);
  lines.push(`${r.backing.issuer_claim ?? "No backing statement."} (confidence ${r.backing.confidence})`);
  lines.push(`${L("lbl_custodian")}: ${r.backing.custodian ?? "UNKNOWN"}`);
  const ud = r.underlying_detail ?? {};
  const fil = ud.filings ?? {};
  const div = ud.dividend ?? {};
  if (fil.latest_10k || fil.latest_10q || fil.note || fil.holdings_url) {
    lines.push(`### ${L("sec_filings")}`);
    if (fil.latest_10k) lines.push(`- Latest 10-K: ${fil.latest_10k.date} — ${fil.latest_10k.url}`);
    if (fil.latest_10q) lines.push(`- Latest 10-Q: ${fil.latest_10q.date} — ${fil.latest_10q.url}`);
    if (fil.note) lines.push(`- ${fil.note}${fil.holdings_url ? ` See: ${fil.holdings_url}` : ""}`);
    if (div.underlying_last_amount) lines.push(`- Underlying last dividend: ${div.underlying_last_amount} on ${div.underlying_last_date ?? "unknown date"} (underlying stock — xStock passthrough: ${div.xstock_treatment ?? "UNKNOWN"}).`);
    else if (!div.skipped) lines.push(`- No underlying dividend in last 12m of history. xStock passthrough treatment: UNKNOWN — confirm in Final Terms.`);
  }
  // Exit & redemption: the "how do I get out" section buyers actually need.
  const red = r.redemption ?? {};
  const redEx: string[] = Array.isArray(red.excerpts) ? red.excerpts : [];
  const geoEx: string[] = Array.isArray(red.geo_excerpts) ? red.geo_excerpts : [];
  const attL: string[] = Array.isArray(red.attestation_links) ? red.attestation_links : [];
  if (redEx.length > 0 || geoEx.length > 0 || attL.length > 0 || red.who_can_redeem) {
    lines.push(`### ${L("sec_exit")}`);
    lines.push(`- Who can redeem: **${red.who_can_redeem ?? "UNKNOWN"}**`);
    for (const e of redEx.slice(0, 4)) lines.push(`- "${String(e).slice(0, 220)}"`);
    for (const g of geoEx.slice(0, 4)) lines.push(`- Eligibility: "${String(g).slice(0, 220)}"`);
    if (attL.length > 0) for (const a of attL) lines.push(`- Attestation: ${a}`);
    else lines.push(`- No reserve attestation link found on fetched pages.`);
  }
  // All 10 dossier risks — every category carries evidence, observation,
  // meaning and its limitation. Ranked high to low, unknowns last.
  const risks = [...((r.risks_detailed as DetailedRisk[] | undefined) ?? [])].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  lines.push(`### ${L("sec_risks")}`);
  for (const x of risks) {
    lines.push(`- **${x.category}** (${sev(lang, x.severity)}): ${x.risk}`);
    lines.push(`  - Evidence: ${(x.evidence ?? []).join("; ") || "none"} · Observed: ${x.current_observation}`);
    lines.push(`  - Means: ${x.what_it_means} · Limitation: ${x.unknown_limitation}`);
  }
  // Unknowns reframed as diligence, not failure.
  lines.push(`### ${L("sec_checked")}`);
  const checked: string[] = [];
  if (Array.isArray(r.backing.pages_read) && r.backing.pages_read.length > 0) checked.push(`${r.backing.pages_read.length} official page(s)`);
  if (r.onchain.tokenlist_check?.listed) checked.push("independent tokenlist (contract confirmed)");
  const covSummary = okxCoverage(r.onchain?.missing);
  checked.push(`${covSummary.ok}/${covSummary.total} OKX endpoints`);
  if (r.economics?.underlying_price) checked.push("underlying spot");
  if (Array.isArray(r.recent_developments) && r.recent_developments.length > 0) checked.push(`${r.recent_developments.length} news item(s)`);
  lines.push(`${L("lbl_checked")}: ${checked.join(" · ") || "registry only"}.`);
  const unknowns = ((r.unknowns as string[] | undefined) ?? []);
  if (unknowns.length > 0) {
    lines.push(`${L("lbl_couldnt")}:`);
    for (const u of unknowns) lines.push(`- ${u}`);
  }
  // Source register: every important source with quality, dates and support.
  const reg = ((r.source_register as AnyObj[] | undefined) ?? []);
  lines.push(`### ${L("sec_sources")} ${L("ev_original")}`);
  if (reg.length === 0) lines.push(`- None captured — see unknowns.`);
  for (const s of reg.slice(0, 12)) {
    lines.push(`- [${s.name ?? "source"}](${s.url ?? "#"}) [${s.quality ?? "?"} · ${s.type ?? ""}] — supports: ${cutWords(String(s.supports ?? ""), 160)} (retrieved ${s.retrieved_at ?? "?"})`);
  }
  lines.push(`- Quality scale: PRIMARY = official issuer/legal docs, official xStocks data, on-chain evidence · SECONDARY = exchange data, recognized providers · TERTIARY = reputable news · UNVERIFIED = social/community claims (none used in this report). Quality rates THE SOURCE, never the asset.`);
  const recent = ((r.recent_developments as AnyObj[] | undefined) ?? []).slice(0, 3);
  lines.push(`### ${L("sec_recent")}`);
  if (recent.length === 0) lines.push(`- None found${r.recent_note ? ` (${r.recent_note})` : ""}.`);
  for (const n of recent) lines.push(`- [${n.title}](${n.url ?? "#"}) (${n.source ?? "news"}${n.published_at ? `, ${n.published_at}` : ""})`);
  const contra = (r.contradictions as AnyObj[]) ?? [];
  lines.push(`### ${L("sec_contradictions")}`);
  if (contra.length === 0) lines.push(`- No contradictions in the 4 automated checks (underlying code, OKX price drift >10%, tokenlist symbol, issuer-contract crosscheck). Limited coverage — see unknowns.`);
  for (const c of contra) lines.push(`- CONFLICT: ${c.issue} See: ${c.recommended_action}`);
  // Methodology: what was consulted, so the report is auditable.
  lines.push(`### ${L("sec_method")}`);
  lines.push(`- ${covSummary.ok}/${covSummary.total} OKX Onchain OS endpoints (chain 196) · ${dataTs(r)}`);
  if (Array.isArray(r.backing.pages_read) && r.backing.pages_read.length > 0) {
    lines.push(`- ${r.backing.pages_read.length} official page(s): ${r.backing.pages_read.join(" · ")}`);
  }
  lines.push(`- Independent tokenlist (chain 196): ${r.onchain.tokenlist_check?.listed ? `confirms contract as ${r.onchain.tokenlist_check.matched_symbol}` : "contract not confirmed"}`);
  lines.push(`- Underlying spot: ${r.economics?.underlying_source ?? "unavailable"}${r.economics?.reference_price_timestamp ? ` (${r.economics.reference_price_timestamp})` : ""}`);
  lines.push(`- Grades capped by design: issuer claims alone can never exceed MEDIUM; HIGH needs multi-source agreement + tokenlist confirmation + zero contradictions.`);
  lines.push(`- ${L("data_notice")}`);
  return lines.join("\n");
}

// Report timestamp helper (single data clock for the methodology section).
function dataTs(r: AnyObj): string {
  return String(r.data_timestamp ?? "unknown time");
}

// One-line derivation of the overall confidence from fields already computed.
function confidenceReceipt(r: AnyObj): string {
  const bits: string[] = [];
  const cov = okxCoverage(r.onchain?.missing);
  bits.push(cov.ok === cov.total ? "all OKX endpoints agree" : `${cov.ok}/${cov.total} OKX endpoints`);
  if (r.onchain?.tokenlist_check?.listed) bits.push("tokenlist confirms contract");
  const pages = Array.isArray(r.backing?.pages_read) ? r.backing.pages_read.length : 0;
  if (pages > 0) bits.push(`${pages} official page(s) read`);
  else bits.push("no official pages read");
  if ((r.contradictions ?? []).length > 0) bits.push(`${r.contradictions.length} contradiction(s) flagged`);
  return bits.join(" · ");
}

export function summarizeCompare(c: AnyObj): string {
  if (!c.rows || c.rows.length === 0) {
    const nf = ((c.not_found as string[] | undefined) ?? []);
    const sup = ((c.supported_symbols as string[] | undefined) ?? []).join(", ");
    return `**No assets compared.** ${c.error ?? ""}${nf.length > 0 ? ` Not found: ${nf.join(", ")}.` : ""}${sup ? ` Supported: ${sup}.` : ""}`;
  }
  const lang = normalizeLang(c.lang);
  const L = (k: string): string => t(lang, k);
  const lines: string[] = [];
  lines.push(`## ${L("cmp_title")}: ${(c.compared as string[]).join(" vs ")}`);
  lines.push(`| Asset | Price | Premium | Holders | Top 10 | Liquidity | Backing | Overall |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  const cellPct = (v: unknown): string => (v === null || v === undefined ? "n/a" : `${v}%`);
  for (const r of c.rows as AnyObj[]) {
    const prem = r.premium_discount_bps === null || r.premium_discount_bps === undefined ? "n/a" : `${r.premium_discount_bps >= 0 ? "+" : ""}${r.premium_discount_bps}bps`;
    lines.push(`| ${r.symbol} | ${r.price ?? "n/a"} | ${prem} | ${r.holders ?? "n/a"} | ${cellPct(r.top10HoldPercent)} | ${r.liquidity ?? "n/a"} | ${r.backing_confidence} | ${r.overall_confidence} |`);
  }
  // Deltas in plain English — the "can't get this from raw OKX" moment.
  const rows = c.rows as AnyObj[];
  if (rows.length > 1) {
    lines.push(`### ${L("sec_deltas")}`);
    const withPrem = rows.filter((r) => hasNum(r.premium_discount_bps));
    if (withPrem.length > 1) {
      const sorted = [...withPrem].sort((a, b) => Number(a.premium_discount_bps) - Number(b.premium_discount_bps));
      const d = Math.abs(Number(sorted[sorted.length - 1].premium_discount_bps) - Number(sorted[0].premium_discount_bps));
      lines.push(`- ${L("cmp_cheapest")}: ${sorted[0].symbol} (${sorted[0].premium_discount_bps} bps, ≈ ${(Number(sorted[0].premium_discount_bps) / 100).toFixed(2)}%) vs ${sorted[sorted.length - 1].symbol} (${sorted[sorted.length - 1].premium_discount_bps} bps) — Δ ${d} bps (≈ ${(d / 100).toFixed(2)}%).`);
    }
    const withLiq = rows.filter((r) => hasNum(r.liquidity));
    if (withLiq.length > 1) {
      const sorted = [...withLiq].sort((a, b) => Number(b.liquidity) - Number(a.liquidity));
      const lo = Number(sorted[sorted.length - 1].liquidity);
      const ratio = lo > 0 ? `${(Number(sorted[0].liquidity) / lo).toFixed(1)}x` : "n/a (zero baseline)";
      lines.push(`- ${L("cmp_liquid")}: ${sorted[0].symbol} (${sorted[0].liquidity}) vs ${sorted[sorted.length - 1].symbol} (${sorted[sorted.length - 1].liquidity}, ${ratio}).`);
    }
    const withConc = rows.filter((r) => hasNum(r.top10HoldPercent));
    if (withConc.length > 1) {
      const sorted = [...withConc].sort((a, b) => Number(a.top10HoldPercent) - Number(b.top10HoldPercent));
      lines.push(`- ${L("cmp_dispersed")}: ${sorted[0].symbol} (top-10 ${sorted[0].top10HoldPercent}%) vs ${sorted[sorted.length - 1].symbol} (${sorted[sorted.length - 1].top10HoldPercent}%).`);
    }
  }
  lines.push(`### ${L("sec_leaders")}`);
  if ((c.leaders as AnyObj[]).length === 0) lines.push(`- ${L("leaders_none")}`);
  for (const l of (c.leaders as AnyObj[])) lines.push(`- **${l.category}: ${l.leader ?? "tie"}** — ${l.reason}`);
  const withRange = rows.filter((r) => r.range_30d && r.range_30d.low);
  if (withRange.length > 0) {
    lines.push(`### ${L("sec_activity")}`);
    for (const r of withRange) {
      const to = r.turnover_24h === null || r.turnover_24h === undefined ? "n/a" : `${r.turnover_24h}x`;
      lines.push(`- ${r.symbol} 30d: low **${r.range_30d.low}** / high **${r.range_30d.high}** (${r.range_30d.change_pct ?? "n/a"}% change) · turnover **${to}**.`);
    }
  }
  const shared = ((c.shared_holders as AnyObj[] | undefined) ?? []).slice(0, 3);
  if (shared.length > 0) {
    lines.push(`### ${L("sec_whales")}`);
    for (const h of shared) lines.push(`- \`${String(h.address).slice(0, 12)}…\` in ${h.tokens.join(", ")} (max ${h.max_percent}%) — consistent with issuer/venue wallets, UNVERIFIED.`);
  }
  // Normalized side-by-side matrix: one row per metric, one column per asset.
  const matrix = ((c.comparison_table as AnyObj[] | undefined) ?? []);
  if (matrix.length > 0) {
    lines.push(`### ${L("sec_compare_matrix")} (value · source)`);
    let lastCat = "";
    for (const m of matrix) {
      if (m.category !== lastCat) {
        lastCat = m.category;
        const cols = (c.compared as string[]).join(" | ");
        lines.push(`**${lastCat}**`);
        lines.push(`| Metric | ${cols} |`);
        lines.push(`|---|${(c.compared as string[]).map(() => "---").join("|")}|`);
      }
      const cells = (c.compared as string[]).map((s) => {
        const v = m.values?.[s]?.value;
        return v === null || v === undefined || v === "" ? "n/a" : String(v).slice(0, 60);
      });
      lines.push(`| ${m.metric} | ${cells.join(" | ")} |`);
    }
    lines.push(`- Metric-specific observations only — never an overall winner. Timestamps and per-cell sources in JSON.`);
  }
  const nf = ((c.not_found as string[] | undefined) ?? []);
  if (nf.length > 0) lines.push(`Not found: ${nf.join(", ")}.`);
  if (typeof c.duplicates_dropped === "number" && c.duplicates_dropped > 0) lines.push(`Note: ${c.duplicates_dropped} duplicate input(s) collapsed.`);
  if (Array.isArray(c.dropped_symbols) && c.dropped_symbols.length > 0) lines.push(`${c.dropped_note ?? `Ignored: ${c.dropped_symbols.join(", ")}.`}`);
  return lines.join("\n");
}

// ---- Service 1: identify — fast identity verification, NOT a research report ----
// Answers "what exactly is this token?" in under a minute: identity fields,
// legal/product structure, explicit verification checks, official sources and
// unknowns. No market analysis, no live quotes, no fetches — registry only.
// Every check is { check, status, detail }: "verified" only when the registry
// itself ties the field to an official source; otherwise "unverified".
// Fields the registry cannot establish (standard, decimals, rights,
// jurisdiction, live status) are UNKNOWN, never guessed.
export function buildIdentity(symbol: string, opts?: { lang?: string }): AnyObj {
  const lang = normalizeLang(opts?.lang);
  const L = (k: string): string => t(lang, k);
  const fallbackNote = langFallbackNote(opts?.lang, lang);
  const clean = symbol.trim().toUpperCase();
  const asset = findAsset(clean);
  const ts = now();
  if (!asset) {
    return {
      service: "identify",
      found: false, symbol: clean, lang,
      ...(fallbackNote ? { lang_note: fallbackNote } : {}),
      uncertainty: L("id_unknown"),
      supported_symbols: supportedSymbols(), confidence: "UNKNOWN", data_timestamp: ts,
    };
  }
  const chain = chainMeta();
  const published = asset.issuer_published_contract ?? null;
  const publishedOk = typeof published === "string" && /^0x[0-9a-fA-F]{40}$/.test(published);
  const listedContracts = (asset.contract_addresses ?? []).filter((c) => /^0x[0-9a-fA-F]{40}$/.test(c));
  const contractListed = publishedOk && listedContracts.some((c) => c.toLowerCase() === (published as string).toLowerCase());
  const check = (name: string, ok: boolean, detail: string): AnyObj =>
    ({ check: name, status: ok ? L("id_verified") : L("id_unverified"), verified: ok, detail });
  const checks = [
    check("symbol_matches_official_source", !!asset.product_page,
      asset.product_page ? `Registry links the official xStocks product page for this exact symbol: ${asset.product_page}` : "No official product page recorded for this symbol."),
    check("contract_matches_official_source", publishedOk,
      publishedOk ? `xStocks product data publishes ${(published as string)} for ${asset.symbol} (issuer-published address).` : "No issuer-published contract address recorded — resolve via OKX token search (chainIndex 196) or the xStocks tokenlist."),
    check("network_matches_official_source", true,
      `Registry chain block: ${chain.name} (chainId ${chain.chainId}, OKX chainIndex ${chain.chainIndex}).`),
    check("underlying_matches_official_source", !!(asset.underlying?.ticker),
      asset.underlying?.ticker ? `Registry records underlying ${asset.underlying.ticker} on ${asset.underlying.exchange ?? "unknown exchange"} with SEC CIK ${asset.underlying.cik ?? "n/a"}.` : "No explicit underlying ticker recorded."),
    check("issuer_matches_official_documentation", !!(asset.issuer_legal && asset.official_documents.length > 0),
      asset.issuer_legal ? `Legal entity recorded as ${asset.issuer_legal}; ${asset.official_documents.length} official document link(s) on file.` : "No legal entity name recorded."),
  ];
  const explorerContract = publishedOk
    ? `https://www.okx.com/web3/explorer/xlayer/token/${published}`
    : null;
  const unknown: string[] = [
    "Token standard (e.g. ERC-20) — not recorded in the registry. Confirm on the chain explorer.",
    "Decimals — not recorded in the registry. Confirm on the chain explorer or via research (token meta).",
    "Direct shareholder rights — UNKNOWN. The token tracks the underlying per the issuer's claim; whether it confers shareholder rights must be confirmed in the issuer's Final Terms.",
    "Voting rights — UNKNOWN. Confirm in the issuer's Final Terms.",
    "Jurisdiction and eligibility — UNKNOWN in this check. See research (issuer focus) for extracted geo passages.",
    "Current issuer status — UNKNOWN. The registry is a snapshot; live status needs current issuer documentation.",
    "Backing and reserves — out of scope for identify. See research (backing focus).",
  ];
  if (!contractListed && publishedOk && listedContracts.length > 0) {
    unknown.push("Registry contract list differs from the issuer-published address — treat the token as unverified until reconciled.");
  }
  return {
    service: "identify",
    found: true, symbol: asset.symbol, lang,
    ...(fallbackNote ? { lang_note: fallbackNote } : {}),
    identity: {
      token_symbol: asset.symbol,
      token_name: asset.name,
      underlying_asset: asset.underlying_asset,
      underlying_ticker: asset.underlying?.ticker ?? null,
      issuer: asset.issuer,
      network: chain.name,
      chain_id: chain.chainId,
      contract_address: published,
      token_standard: null,
      decimals: null,
      asset_status: "tracked_in_registry — live status not checked in identify; use research for live data",
    },
    legal_structure: {
      instrument_type: asset.asset_type,
      represents: "Issuer describes the token as tracking the underlying 1:1 (ISSUER CLAIM — evidence in research, backing focus).",
      direct_shareholder_rights: null,
      voting_rights: null,
      legal_entity: asset.issuer_legal ?? null,
      jurisdiction: null,
      official_product_documentation: asset.official_documents,
    },
    verification_checks: checks,
    official_sources: {
      product_page: asset.product_page ?? null,
      issuer_documentation: asset.official_website,
      legal_documentation: asset.official_documents,
      chain_explorer_contract: explorerContract,
    },
    unknown,
    summary: `## ${asset.symbol} — ${asset.name} (${chain.name})\n` +
      `- ${asset.underlying_asset} · issued as ${asset.issuer}${asset.issuer_legal ? ` (${asset.issuer_legal})` : ""}\n` +
      `- Contract: ${published ?? "UNKNOWN"} · Standard/decimals: UNKNOWN (see explorer)\n` +
      `- Checks: ${checks.filter((c) => c.verified).length}/${checks.length} ${L("id_verified")}\n` +
      `- Shareholder/voting rights, jurisdiction, live status: UNKNOWN — confirm in Final Terms; market data: see research.`,
    confidence: "MEDIUM",
    data_timestamp: ts,
  };
}

// ---- Service 2: research — evidence dossier builders ----
// The dossier separates every statement into CLAIM (issuer says), VERIFIED
// FACT (primary source or direct observation), ON-CHAIN OBSERVATION (current
// chain measurement), CALCULATION (Uzam arithmetic, labeled) and UNKNOWN
// (evidence insufficient). Nothing is promoted without supporting evidence.

type Quality = "PRIMARY" | "SECONDARY" | "TERTIARY" | "UNVERIFIED";

function qualityOf(sourceType: string): Quality {
  if (
    sourceType === "official_issuer" || sourceType === "official_documentation" ||
    sourceType === "legal_document" || sourceType === "reserve_report" ||
    sourceType === "blockchain_data"
  ) return "PRIMARY";
  if (sourceType === "market_data" || sourceType === "third_party") return "SECONDARY";
  if (sourceType === "reputable_news") return "TERTIARY";
  return "UNVERIFIED";
}

/** Source register: every important source with name, URL, type, quality,
 * dates and what it supports. No UNVERIFIED sources are used — the register
 * says so explicitly instead of silently omitting the tier. */
export function buildSourceRegister(evidence: AnyObj[], recent: AnyObj[], extra: { okxUsed: boolean; tokenlistUrl: string | null; tokenlistListed: boolean; spotSource: string | null; ts: string }): AnyObj[] {
  const seen = new Set<string>();
  const reg: AnyObj[] = [];
  const push = (name: string, url: string | null, type: string, quality: Quality, published: string | null, retrieved: string, supports: string): void => {
    const key = `${type}|${url ?? name}`;
    if (seen.has(key)) return;
    seen.add(key);
    reg.push({ name, url, type, quality, published_at: published, retrieved_at: retrieved, supports });
  };
  for (const e of evidence) {
    const url = typeof e.source_url === "string" && e.source_url.startsWith("https://") ? e.source_url : null;
    push(
      String(e.source_title ?? "Untitled source"), url,
      String(e.source_type ?? "unknown"), qualityOf(String(e.source_type ?? "")),
      null, String(e.retrieved_at ?? extra.ts),
      `${String(e.claim ?? "evidence").slice(0, 160)} [basis: ${String(e.basis ?? "?")}, confidence ${String(e.confidence ?? "?")}]`
    );
  }
  if (extra.okxUsed) {
    push("OKX Onchain OS (DEX market endpoints, chainIndex 196)", "https://web3.okx.com/onchainos", "exchange_documentation", "SECONDARY", null, extra.ts, "Token price, supply, holders, concentration, trades, pools — exchange data, not issuer verification.");
  }
  if (extra.tokenlistUrl) {
    push("xStocks token list (Backed, CowSwap format)", extra.tokenlistUrl, "official_xstocks_api", extra.tokenlistListed ? "PRIMARY" : "SECONDARY", null, extra.ts, extra.tokenlistListed ? "Independent confirmation that the resolved contract is listed for this symbol on chain 196." : "Checked for the resolved contract; listing not confirmed.");
  }
  if (extra.spotSource) {
    push("Yahoo Finance quote (via keyless chart API)", "https://finance.yahoo.com", "market_data_provider", "SECONDARY", null, extra.ts, "Underlying/reference price only — unverified third party, never token evidence.");
  }
  for (const n of recent.slice(0, 5)) {
    if (typeof n.url === "string" && n.url.startsWith("https://")) {
      push(String(n.title ?? "News item").slice(0, 120), n.url, "news", "TERTIARY", typeof n.published_at === "string" ? n.published_at : null, extra.ts, "Context on the underlying company — never token backing evidence.");
    }
  }
  return reg;
}

const IMPACT_SIZES = [100, 1000, 10000];

/** Price-impact estimates per venue for $100/$1,000/$10,000 trades.
 * CALCULATION, not observation: impact ≈ size / (pool_liquidity + size),
 * assuming the pool's stated total liquidity is fully available on one side.
 * Real impact may be LARGER (reserve split, fees, routing unknown). No
 * liquidity figure => no estimate, never a zero. */
export function buildPriceImpact(pools: AnyObj | null): AnyObj {
  const rows: AnyObj[] = Array.isArray(pools?.pools) ? pools.pools : [];
  const venues = rows
    .map((p: AnyObj) => {
      const liq = toNum(p.liquidity_usd);
      if (liq === null || liq <= 0) return null;
      const estimates: AnyObj = {};
      for (const s of IMPACT_SIZES) estimates[`usd_${s}`] = `${((s / (liq + s)) * 100).toFixed(2)}%`;
      return { venue: String(p.label ?? "Pool"), liquidity_usd: liq.toFixed(2), estimates };
    })
    .filter(Boolean);
  return {
    venue_count: venues.length,
    venues,
    method: "impact_pct = trade_usd / (pool_liquidity_usd + trade_usd) x 100 per venue",
    assumption: "Pool's stated total liquidity treated as single-sided reserves; fees, routing and reserve split unknown — real impact may be larger. CALCULATION, not a market fact.",
    ...(venues.length === 0 ? { note: "Unknown — no venue liquidity figures available, no impact estimated." } : {}),
  };
}

export type DetailedRisk = {
  category: string;
  severity: "low" | "moderate" | "high" | "unknown";
  risk: string;
  evidence: string[];
  current_observation: string;
  what_it_means: string;
  unknown_limitation: string;
};

/** The 10 dossier risk categories. Observed severities are reused from
 * buildRisks (thresholds documented there); structural categories with no
 * data source read "unknown" with the gap stated — never filler. */
export function buildRisksDetailed(ctx: {
  base: Risk[]; underlyingCode: string; exchange: string | null; underlyingPrice: string | null;
  premiumBps: number | null; marketStatus: string | null; liquidityRaw: number | null; venueCount: number;
  custodianNamed: boolean; geoCount: number; tokenDecimals: number | null; spotSource: string | null;
  okxOk: number; okxTotal: number; redemptionExcerpts: number;
}): DetailedRisk[] {
  const byCat = (c: string): Risk | undefined => ctx.base.find((r) => r.category === c);
  const sevOf = (c: string): DetailedRisk["severity"] => byCat(c)?.severity ?? "unknown";
  const worse = (a: DetailedRisk["severity"], b: DetailedRisk["severity"]): DetailedRisk["severity"] => {
    const rank: Record<string, number> = { high: 0, moderate: 1, unknown: 2, low: 3 };
    return rank[a] <= rank[b] ? a : b;
  };
  return [
    {
      category: "underlying_equity",
      severity: "unknown",
      risk: `The token tracks ${ctx.underlyingCode} — single-equity exposure including downside, volatility and corporate actions. Uzam performs no company analysis.`,
      evidence: ["registry:underlying", "sec:edgar-filings"],
      current_observation: `Underlying ${ctx.underlyingCode}${ctx.exchange ? ` (${ctx.exchange})` : ""}; reference price ${ctx.underlyingPrice ?? "unavailable"}.`,
      what_it_means: "Token value follows one company's stock. Company-specific events affect the token's reference value.",
      unknown_limitation: "Fundamentals, earnings quality and upcoming corporate actions not analyzed; dividend passthrough treatment UNKNOWN.",
    },
    {
      category: "tracking_pricing",
      severity: ctx.premiumBps === null ? "unknown" : ctx.marketStatus === "closed" ? "moderate" : "low",
      risk: "Token price can deviate from the underlying reference (premium/discount), especially outside market hours when the reference is stale.",
      evidence: ["uzam:premium-calculation", "okx:market/price", "yahoo:reference-quote"],
      current_observation: ctx.premiumBps === null ? "No premium computed (token price or reference unavailable)." : `Premium/discount ${ctx.premiumBps >= 0 ? "+" : ""}${ctx.premiumBps} bps vs ${ctx.marketStatus ?? "unknown-state"} reference.`,
      what_it_means: "You may pay more (or receive less) than the underlying reference price at trade time.",
      unknown_limitation: "Intraday creation/redemption arbitrage mechanics not observed; exact deviation drivers UNKNOWN.",
    },
    {
      category: "liquidity",
      severity: sevOf("liquidity"),
      risk: byCat("liquidity")?.reason ?? "No liquidity figure available.",
      evidence: byCat("liquidity")?.evidence ?? [],
      current_observation: ctx.liquidityRaw === null ? "No liquidity figure available." : `Observed liquidity $${fmtNum(ctx.liquidityRaw) ?? ctx.liquidityRaw} across ${ctx.venueCount} venue(s). See calculated price impact.`,
      what_it_means: "Thin books can mean large price impact on entry and exit.",
      unknown_limitation: ctx.venueCount === 0 ? "No venues identified — liquidity outside OKX top-pools UNKNOWN." : "Venues beyond OKX top-liquidity not surveyed.",
    },
    {
      category: "issuer_counterparty",
      severity: worse(sevOf("issuer"), sevOf("counterparty")),
      risk: "Token value depends on the issuer, custodian and their intermediaries performing — not just the smart contract.",
      evidence: [...(byCat("issuer")?.evidence ?? []), ...(byCat("counterparty")?.evidence ?? [])],
      current_observation: byCat("issuer")?.reason ?? "Issuer pages not read.",
      what_it_means: "Issuer failure, freeze or restructuring can impair redemption regardless of chain state.",
      unknown_limitation: "Current issuer financial standing and operational resilience not assessed from primary sources.",
    },
    {
      category: "custody",
      severity: ctx.custodianNamed ? "moderate" : "high",
      risk: "Backing depends on a custodian holding the underlying; custody terms are the issuer's description until verified.",
      evidence: ["uzam:analyze_backing"],
      current_observation: ctx.custodianNamed ? "A custodian is named on official pages (still the issuer's claim)." : "No specific custodian named on the fetched official pages.",
      what_it_means: "If custody fails or is misdescribed, the token's backing claim fails with it.",
      unknown_limitation: "No independent custodian attestation gathered; segregation and audit status UNKNOWN.",
    },
    {
      category: "legal_regulatory",
      severity: sevOf("regulatory_access"),
      risk: byCat("regulatory_access")?.reason ?? "Eligibility unknown.",
      evidence: byCat("regulatory_access")?.evidence ?? [],
      current_observation: ctx.geoCount > 0 ? `${ctx.geoCount} jurisdiction/eligibility passage(s) extracted — confirm eligibility in issuer terms.` : "No jurisdiction/eligibility list extracted from fetched pages.",
      what_it_means: "Tokenized equities typically carry geo and eligibility restrictions; holders in excluded regions may be unable to hold or redeem.",
      unknown_limitation: "Full restricted-country list and investor-eligibility criteria UNKNOWN beyond extracted passages.",
    },
    {
      category: "smart_contract",
      severity: sevOf("smart_contract"),
      risk: byCat("smart_contract")?.reason ?? "No contract audit reviewed.",
      evidence: byCat("smart_contract")?.evidence ?? [],
      current_observation: `No contract audit reviewed in this report.${ctx.tokenDecimals !== null ? ` Token decimals observed: ${ctx.tokenDecimals}.` : ""}`,
      what_it_means: "Bugs, upgrade keys or admin controls in the token contract can affect balances independently of backing.",
      unknown_limitation: "Contract audit status, proxy/admin-key structure UNKNOWN.",
    },
    {
      category: "blockchain_network",
      severity: "unknown",
      risk: "The token lives on X Layer (chain 196, EVM L2) — sequencer, bridge and finality behavior are the network's, not the issuer's.",
      evidence: ["registry:chain-block"],
      current_observation: "X Layer chainId 196, EVM-compatible L2; RPC and explorer recorded in chain info.",
      what_it_means: "Network outages, congestion or sequencer issues can delay transfers and price discovery.",
      unknown_limitation: "Validator/sequencer decentralization and incident history not assessed.",
    },
    {
      category: "oracle_data",
      severity: "moderate",
      risk: "Every price and reference figure comes from third-party data providers (OKX, Yahoo), not from the issuer or the chain.",
      evidence: ["okx:market-endpoints", "yahoo:reference-quote"],
      current_observation: ctx.spotSource ? `Reference via ${ctx.spotSource} (unverified third party).` : "No reference price source available.",
      what_it_means: "Stale, erroneous or manipulated feeds produce wrong premiums and wrong conclusions.",
      unknown_limitation: "No oracle audit; feed methodology and update cadence UNKNOWN.",
    },
    {
      category: "operational",
      severity: sevOf("information"),
      risk: byCat("information")?.reason ?? "Source coverage unknown.",
      evidence: byCat("information")?.evidence ?? [],
      current_observation: `${ctx.okxOk}/${ctx.okxTotal} OKX endpoints returned data; ${ctx.redemptionExcerpts} redemption passage(s) extracted.`,
      what_it_means: "Gaps in data mean conclusions rest on fewer sources — treat thinly-sourced sections as provisional.",
      unknown_limitation: "Redemption minimums, fees and settlement time must be confirmed in current issuer terms.",
    },
  ];
}

/** 3-7 executive findings: factual only, each with an evidence reference.
 * Never a recommendation; gaps are stated as findings about the evidence. */
export function buildFindings(ctx: {
  symbol: string; name: string; checksVerified: number; checksTotal: number;
  tokenPrice: string | null; underlyingPrice: string | null; premiumBps: number | null;
  marketStatus: string | null; refTs: string | null;
  top10: number | null; top5: number | null; holders: number | null;
  liquidityRaw: number | null; venueCount: number;
  backingConfidence: string; custodianNamed: boolean;
  contradictions: number; firstContradiction: string | null;
  unknowns: string[]; evidenceCount: number;
}): AnyObj[] {
  const findings: AnyObj[] = [];
  findings.push({
    finding: `${ctx.symbol} identified as ${ctx.name}: ${ctx.checksVerified}/${ctx.checksTotal} identity checks verified against official sources.`,
    evidence_ref: "identify:verification_checks",
  });
  if (ctx.tokenPrice !== null && ctx.underlyingPrice !== null && ctx.premiumBps !== null) {
    findings.push({
      finding: `Token ${ctx.tokenPrice} vs underlying reference ${ctx.underlyingPrice} = ${ctx.premiumBps >= 0 ? "+" : ""}${ctx.premiumBps} bps (${ctx.refTs ?? "no reference timestamp"}; underlying market ${ctx.marketStatus ?? "unknown"}).${ctx.marketStatus === "closed" ? " Reference is stale — re-check when open." : ""}`,
      evidence_ref: "uzam:premium-calculation",
    });
  }
  if (ctx.top10 !== null) {
    findings.push({
      finding: `Top-10 holders control ${ctx.top10}% of supply${ctx.top5 !== null ? `; top-5 control ${ctx.top5}%` : ""}${ctx.holders !== null ? ` across ${ctx.holders} holders` : ""} (observation, not a judgment).`,
      evidence_ref: "okx:advanced-info:top10HoldPercent",
    });
  }
  if (ctx.liquidityRaw !== null) {
    findings.push({
      finding: `Observed liquidity $${fmtNum(ctx.liquidityRaw) ?? ctx.liquidityRaw} across ${ctx.venueCount} venue(s) — see calculated price impact before assuming exit size.`,
      evidence_ref: "okx:price-info:liquidity",
    });
  }
  findings.push({
    finding: `Backing evidence confidence ${ctx.backingConfidence}; custodian ${ctx.custodianNamed ? "named on official pages (issuer claim)" : "UNKNOWN"}. Reserve amount unavailable — reserve/supply reconciliation not possible.`,
    evidence_ref: "uzam:analyze_backing",
  });
  if (ctx.contradictions > 0) {
    findings.push({
      finding: `${ctx.contradictions} conflict(s) between sources flagged${ctx.firstContradiction ? `: ${ctx.firstContradiction}` : ""} — both sides shown, neither silently chosen.`,
      evidence_ref: "uzam:contradiction-checks",
    });
  }
  const reserveUnknown = ctx.unknowns.some((u) => /reserve|attest|reconcil/i.test(u));
  if (!reserveUnknown) {
    findings.push({
      finding: `${ctx.unknowns.length} question(s) could not be answered from available evidence — see unknowns.`,
      evidence_ref: "uzam:report-sections",
    });
  }
  if (findings.length < 3) {
    findings.push({ finding: `Evidence base: ${ctx.evidenceCount} evidence item(s), ${ctx.unknowns.length} open question(s) — see unknowns and source register.`, evidence_ref: "uzam:report-sections" });
  }
  return findings.slice(0, 7);
}

// ---- research_asset: one-call full report ----
export async function researchAsset(symbol: string, focus: "full" | "issuer" | "backing" | "risks" = "full", opts?: { price?: string; lang?: string; question?: string }): Promise<AnyObj> {
  const t0 = Date.now();
  const lang = normalizeLang(opts?.lang);
  const L = (k: string): string => t(lang, k);
  const fallbackNote = langFallbackNote(opts?.lang, lang);
  const clean = symbol.trim().toUpperCase();
  const asset = findAsset(clean);
  if (!asset) {
    return {
      found: false, symbol: clean, lang,
      ...(fallbackNote ? { lang_note: fallbackNote } : {}),
      uncertainty: L("id_unknown"),
      supported_symbols: supportedSymbols(), confidence: "UNKNOWN", data_timestamp: now(),
    };
  }
  // Planner runs only on default focus — an explicit focus always wins.
  // Unknown/empty questions fall back to the full dossier (never less evidence).
  const plan = focus === "full" ? planResearch(opts?.question) : null;
  const flags = planFlags(plan);
  // Document stub when the plan excludes docs: same shape as gatherBacking's
  // essentials, unknowns carrying the skip reason instead of gaps.
  const docsStub: AnyObj = {
    found: true, symbol: asset.symbol, name: asset.name,
    issuer_claim: null, custodian: null, confidence: "UNKNOWN",
    pages_read: [], evidence: [], redemption_excerpts: [],
    geo_excerpts: [], attestation_links: [],
    unanswered_questions: ["Document research skipped by the research plan — not needed for this question."],
  };
  const planIdentity = plan !== null && plan.depth === "identity";
  if (focus === "issuer" || planIdentity) {
    // Issuer focus: identity + legal research from official documents.
    // No onchain, spot, filings or news fetches — only issuer/legal sections.
    // Plan-driven identity without docs uses the stub (no page fetches at all).
    const backingI = flags.needDocs ? await gatherBacking(asset) : docsStub;
    const identityI = buildIdentity(clean, { lang });
    const evI: AnyObj[] = Array.isArray(backingI.evidence) ? backingI.evidence : [];
    const registerI = buildSourceRegister(evI, [], {
      okxUsed: false, tokenlistUrl: TOKENLIST_RAW, tokenlistListed: false, spotSource: null, ts: now(),
    });
    const unknownsI: string[] = [
      ...(Array.isArray(backingI.unanswered_questions) ? backingI.unanswered_questions : []),
      "Registration details and regulatory licenses — confirm in the issuer's legal documentation.",
      "Security agent (if any) — not confirmed from fetched pages.",
      "Distribution restrictions beyond extracted geo passages — confirm in Final Terms.",
    ];
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    return {
      service: "research",
      found: true, focus, lang,
      ...(fallbackNote ? { lang_note: fallbackNote } : {}),
      asset: { symbol: asset.symbol, name: asset.name, asset_type: asset.asset_type },
      identity: identityI,
      issuer: { name: asset.issuer, legal: asset.issuer_legal ?? null, website: asset.official_website, documents: asset.official_documents },
      underlying: { exposure: asset.underlying_asset, ...(asset.underlying ?? {}) },
      legal_structure: identityI.legal_structure ?? null,
      issuer_claims: {
        backing_claim: backingI.issuer_claim ?? null,
        custodian: backingI.custodian ?? null,
        redemption_excerpts: backingI.redemption_excerpts ?? [],
        geo_excerpts: backingI.geo_excerpts ?? [],
        attestation_links: backingI.attestation_links ?? [],
      },
      independently_verified: [],
      independently_verified_note: "No independent (non-issuer) verification performed in issuer focus — issuer statements below are CLAIMs, not FACTs.",
      unknowns: unknownsI,
      unknowns_mandatory: unknownsI,
      source_register: registerI,
      research_plan: plan,
      note: "Issuer focus: identity + legal/document research only. No onchain, market, filings or news fetches performed.",
      confidence: { overall: "MEDIUM", identity: "HIGH", onchain: "UNKNOWN", backing: backingI.confidence ?? "UNKNOWN" },
      receipt: `${opts?.price ? `${L("rpt_paid")} ${opts.price}` : L("rpt_free")} · issuer focus, ${Array.isArray(backingI.pages_read) ? backingI.pages_read.length : 0} ${L("rpt_pages")} ${L("rpt_in")} ${secs}s · data ${now()}`,
      data_timestamp: now(),
    };
  }
  const skipOnchain = focus === "backing" || (plan !== null && !flags.needOnchain);
  const skipWhy = focus === "backing" ? "skipped_by_focus" : "skipped_by_plan";
  const onchainStub: AnyObj = { found: true, symbol: asset.symbol, name: asset.name, chains: asset.chains, chainIds: asset.chainIds, onchain: null, missing: [skipWhy], confidence: "UNKNOWN", data_timestamp: now() };
  const [onchain, backing] = await Promise.all([
    skipOnchain ? onchainStub : gatherOnchain(clean, asset),
    flags.needDocs ? gatherBacking(asset) : docsStub,
  ]);
  const econ = onchain.trading_activity ?? {};
  // Underlying spot + premium/discount (needs a token price; skipped otherwise).
  // Prefer the registry's explicit ticker; fall back to parsing the old string.
  const underlyingCode = (asset.underlying?.ticker ?? asset.underlying_asset.split(/[\s(]/)[0]).toUpperCase();
  const isEtf = asset.asset_type === "tokenized_etf";
  const tokenPx = Number(econ.price_raw ?? econ.price);
  const codeOk = /^[A-Z][A-Z.]{0,9}$/.test(underlyingCode);
  type Spot = { price: number | null; date: string | null; time: string | null; stale?: boolean; error?: string };
  // Enrichment stages are independent once tokenPx is known — run together.
  // Each is guarded: a throw becomes an unknowns entry, never a lost report.
  const wantRecent = (focus === "full" || focus === "risks") && (!plan || flags.needNews);
  const wantSpot = Number.isFinite(tokenPx) && tokenPx > 0 && codeOk && focus !== "risks" && (!plan || flags.needSpot);
  const wantFilings = focus !== "risks" && !isEtf && !!asset.underlying?.cik && (!plan || flags.needFilings);
  const wantDividend = wantFilings && codeOk && (!plan || flags.needDividend);
  const [recentRes, spotRes, filRes, divRes] = await Promise.all([
    (async (): Promise<{ items: AnyObj[]; note: string }> => {
      if (!wantRecent) return { items: [], note: "Skipped by focus." };
      try {
        return await gatherRecent(asset);
      } catch (e) {
        return { items: [], note: `Skipped: ${e instanceof Error ? e.message : String(e)}` };
      }
    })(),
    (async (): Promise<Spot> => {
      if (!wantSpot) return { price: null, date: null, time: null };
      try {
        return await fetchSpot(underlyingCode);
      } catch {
        return { price: null, date: null, time: null, error: "spot fetch threw" };
      }
    })(),
    (async (): Promise<{ k10: FilingInfo; q10: FilingInfo; error?: string }> => {
      if (!wantFilings) return { k10: null, q10: null };
      try {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return await fetchLatestFilings(asset.underlying!.cik!);
      } catch {
        return { k10: null, q10: null, error: "filings fetch threw" };
      }
    })(),
    (async (): Promise<{ amount: string | null; date: string | null; error?: string }> => {
      if (!wantDividend) return { amount: null, date: null };
      try {
        return await fetchDividend(underlyingCode);
      } catch {
        return { amount: null, date: null, error: "dividend fetch threw" };
      }
    })(),
  ]);
  const recent = recentRes;
  const spot: Spot = spotRes;
  let premiumBps: number | null = null;
  let mktStatus: "open" | "closed" | "unknown" = marketStatus();
  if (spot.price) premiumBps = Math.round(((tokenPx - spot.price) / spot.price) * 10000);
  // SEC filings (stocks only; ETFs link the holdings page instead) + dividends.
  let filings: AnyObj = { skipped: true };
  let dividend: AnyObj = { skipped: true };
  const cik = asset.underlying?.cik ?? null;
  if (wantFilings) {
    const { k10, q10, error } = filRes;
    filings = { cik, latest_10k: k10, latest_10q: q10, filings_url: asset.underlying?.sec_filings ?? null, ...(error ? { error } : {}) };
    dividend = {
      underlying_last_amount: divRes.amount, underlying_last_date: divRes.date,
      ...(divRes.error ? { error: divRes.error } : {}),
      xstock_treatment: "UNKNOWN — whether this xStock passes through dividends must be confirmed in the issuer's Final Terms.",
    };
  } else if (isEtf) {
    filings = { note: "ETF underlying — no single-company 10-K. See holdings page.", holdings_url: asset.underlying?.sec_filings ?? null };
  }
  const contradictions = detectContradictions(asset, onchain);
  const risks = buildRisks(onchain, backing);
  const covD = okxCoverage(Array.isArray(onchain.missing) ? onchain.missing : []);
  // Evidence assembly hoisted here: the dossier sections below need
  // unknowns/evidence/geo/attestation before the report object is built.
  const tlListed = onchain.tokenlist_check?.listed === true && onchain.tokenlist_check?.stale !== true;
  const unknowns: string[] = [
    ...(Array.isArray(backing.unanswered_questions) ? backing.unanswered_questions.filter((q) => tlListed ? !/No independent.*verification/i.test(String(q)) : true) : []),
    ...(Array.isArray(onchain.missing) && onchain.missing.length > 0 ? [`Onchain gaps: ${onchain.missing.join("; ")}`] : []),
    ...(tokenPx > 0 && !codeOk ? [`Premium skipped: underlying code "${underlyingCode}" is not a plain ticker.`] : []),
  ];
  if (premiumBps !== null && mktStatus === "closed") unknowns.push(`Premium/discount (${premiumBps} bps) is measured against a stale reference — Nasdaq was closed at check time (${spot.date ?? ""} ${spot.time ?? ""}).`);
  if (premiumBps !== null && mktStatus === "unknown") unknowns.push(`Premium/discount (${premiumBps} bps) reference freshness unknown — market-hours check failed, treat as potentially stale.`);
  if (spot.error && tokenPx > 0) unknowns.push(`Underlying spot unavailable: ${spot.error}. No premium computed.`);
  if (spot.stale && spot.price) unknowns.push(`Underlying spot is STALE (cached ${spot.date ?? ""} ${spot.time ?? ""}) — premium computed against it, re-check before use.`);
  if (filings.error) unknowns.push(`SEC filings unavailable: ${filings.error}.`);
  if (!filings.skipped && !filings.latest_10k && !filings.latest_10q && !filings.error && !filings.note) unknowns.push("No 10-K/10-Q found in recent SEC submissions.");
  if (dividend.error) unknowns.push(`Underlying dividend history unavailable: ${dividend.error}.`);
  if (!dividend.skipped && !dividend.underlying_last_amount && !dividend.error) unknowns.push("No dividend in the last 12 months of underlying price history (or history unavailable).");
  const geoExcerpts: string[] = Array.isArray(backing.geo_excerpts) ? backing.geo_excerpts : [];
  if (geoExcerpts.length === 0) unknowns.push("No jurisdiction/eligibility list extracted from fetched pages — confirm geo eligibility in issuer terms.");
  const attestLinks: string[] = Array.isArray(backing.attestation_links) ? backing.attestation_links : [];
  const backingQs: string[] = Array.isArray(backing.unanswered_questions) ? backing.unanswered_questions : [];
  if (attestLinks.length === 0 && !backingQs.some((q) => /attest/i.test(String(q)))) {
    unknowns.push("No reserve attestation or proof-of-reserves link found on fetched pages.");
  }
  const evidence: AnyObj[] = [
    ...(Array.isArray(backing.evidence) ? backing.evidence.slice(0, 10) : []),
    ...(onchain.explorer ? [{ claim: "Onchain record for this contract.", source_title: "OKX X Layer explorer", source_url: onchain.explorer, excerpt: `Contract ${Array.isArray(onchain.contracts) ? onchain.contracts[0] : ""} on X Layer (chain 196).`,     basis: "fact", source_type: "blockchain_data" as SourceType, tier: 1, confidence: "MEDIUM", retrieved_at: now() }] : []),
    ...(Array.isArray(onchain.extra_evidence) ? onchain.extra_evidence : []),
  ];
  for (const f of [filings.latest_10k, filings.latest_10q]) {
    if (f) {
      evidence.push({
        claim: `Underlying ${underlyingCode} filed ${f.form} on ${f.date} (SEC EDGAR).`,
        source_title: `SEC EDGAR ${f.form}`, source_url: f.url,
        excerpt: `${underlyingCode} ${f.form} filed ${f.date} — primary source for the underlying company's financials.`,
        basis: "fact", source_type: "legal_document" as SourceType, tier: 1, confidence: itemConfidence("legal_document"), retrieved_at: now(),
      });
    }
  }
  // ---- Dossier sections (additive — legacy keys below stay untouched) ----
  const identity = buildIdentity(clean, { lang });
  const checksVerified = (identity.verification_checks as AnyObj[] ?? []).filter((c) => c.verified).length;
  const checksTotal = (identity.verification_checks as AnyObj[] ?? []).length;
  const conc = onchain.holder_concentration ?? {};
  const topHolders: AnyObj[] = Array.isArray(conc.topHolders) ? conc.topHolders : [];
  const top5 = topHolders.length > 0 ? Number(topHolders.reduce((s: number, h: AnyObj) => s + (Number(h.percent) || 0), 0).toFixed(2)) : null;
  const top10num = toNum(conc.top10HoldPercent);
  const liqRaw = toNum(econ.liquidity_raw);
  const poolRows: AnyObj[] = Array.isArray(onchain.pools?.pools) ? onchain.pools.pools : [];
  const priceImpact = buildPriceImpact(onchain.pools ?? null);
  const tlCheck = onchain.tokenlist_check ?? {};
  const verifiedList: AnyObj[] = [];
  if (tlCheck.checked === true && tlCheck.listed === true) {
    verifiedList.push({ statement: `Independent tokenlist lists this exact contract on X Layer (chain 196) as ${tlCheck.matched_symbol ?? "the symbol"}.`, source: "xStocks token list (Backed)", url: TOKENLIST_RAW });
  }
  const crosscheck = onchain.contract_crosscheck ?? {};
  if (crosscheck.checked === true && crosscheck.agrees === true) {
    verifiedList.push({ statement: "OKX-resolved contract matches the issuer-published contract for this symbol.", source: "xStocks product data + OKX token search (chainIndex 196)", url: asset.product_page ?? null });
  }
  if (onchain.explorer) {
    verifiedList.push({ statement: "Chain explorer record exists for this contract on X Layer (the contract exists on-chain; proves existence, never backing).", source: "OKX X Layer explorer", url: onchain.explorer });
  }
  for (const f of [filings.latest_10k, filings.latest_10q]) {
    if (f) verifiedList.push({ statement: `Underlying ${underlyingCode} filed ${f.form} on ${f.date} (SEC EDGAR) — verifies the UNDERLYING company's disclosures, never the token's backing.`, source: "SEC EDGAR", url: f.url });
  }
  const onchainObs: AnyObj[] = [];
  if (onchain.supply) onchainObs.push({ statement: `Circulating supply observed: ${JSON.stringify(onchain.supply)}.`, source: "OKX price-info" });
  if (Array.isArray(onchain.contracts) && onchain.contracts[0]) onchainObs.push({ statement: `Contract observed on X Layer: ${onchain.contracts[0]}.`, source: "OKX token search (chainIndex 196)" });
  if (onchain.holders_count !== null && onchain.holders_count !== undefined) onchainObs.push({ statement: `Holder count observed: ${onchain.holders_count}.`, source: "OKX price-info" });
  const backingUnknown: string[] = [
    ...(Array.isArray(backing.unanswered_questions) ? backing.unanswered_questions : []),
    "Reserve amount unavailable — no proof-of-reserves figure retrieved, so reserve/supply reconciliation is not possible.",
  ];
  const tokenSupplyRaw = onchain.supply?.circulating ?? null;
  const backingDetail = {
    issuer_claim: backing.issuer_claim ?? null,
    custodian: backing.custodian ?? null,
    independently_verified: verifiedList,
    onchain_observation: onchainObs,
    unknown: backingUnknown,
    reconciliation: {
      reserve_amount: null,
      token_supply: tokenSupplyRaw,
      reconciled: null,
      note: "Cannot reconcile: no reserve amount retrieved from any source. Token supply alone proves nothing about backing.",
    },
    reserve_evidence_date: null,
    attestation_links: attestLinks,
  };
  const refTs = spot.date ? `${spot.date} ${spot.time ?? ""}`.trim() : null;
  const priceRelationship = {
    token_price: econ.price ?? null,
    reference_price: spot.price !== null ? spot.price.toFixed(2) : null,
    difference: premiumBps !== null && spot.price ? (tokenPx - spot.price).toFixed(2) : null,
    difference_bps: premiumBps,
    timestamp: refTs,
    market_status: spot.price !== null ? mktStatus : null,
    limitations: "Tokenized assets trade outside equity market hours against a stale reference; the reference is an unverified third-party quote, never the issuer's redemption value. CALCULATED difference, not a tradable spread.",
  };
  const risksDetailed = buildRisksDetailed({
    base: risks, underlyingCode, exchange: asset.underlying?.exchange ?? null,
    underlyingPrice: spot.price !== null ? spot.price.toFixed(2) : null,
    premiumBps, marketStatus: spot.price !== null ? mktStatus : null,
    liquidityRaw: liqRaw, venueCount: poolRows.length,
    custodianNamed: !!detectNamedCustodian((Array.isArray(backing.evidence) ? backing.evidence : []).map((e: AnyObj) => String(e.excerpt ?? ""))),
    geoCount: geoExcerpts.length,
    tokenDecimals: onchain.token_meta?.decimals ?? null,
    spotSource: spot.price !== null ? "Yahoo Finance quote (unverified third party)" : null,
    okxOk: covD.ok, okxTotal: covD.total,
    redemptionExcerpts: Array.isArray(backing.redemption_excerpts) ? backing.redemption_excerpts.length : 0,
  });
  const sourceRegister = buildSourceRegister(evidence, recent.items, {
    okxUsed: covD.ok > 0, tokenlistUrl: TOKENLIST_RAW, tokenlistListed: !!tlListed,
    spotSource: spot.price !== null ? "yahoo" : null, ts: now(),
  });
  const primaryCount = evidence.filter((e: AnyObj) => e.tier === 1).length;
  const snapshot = {
    symbol: asset.symbol, underlying_asset: asset.underlying_asset, issuer: asset.issuer,
    chain: "X Layer (chainId 196, OKX chainIndex 196)",
    research_timestamp: now(),
    sources: evidence.length + recent.items.length,
    primary_sources: primaryCount,
    onchain_sources: covD.ok,
  };
  const findings = buildFindings({
    symbol: asset.symbol, name: asset.name, checksVerified, checksTotal,
    tokenPrice: econ.price ?? null, underlyingPrice: spot.price !== null ? spot.price.toFixed(2) : null,
    premiumBps, marketStatus: spot.price !== null ? mktStatus : null, refTs,
    top10: top10num, top5, holders: onchain.holders_count ?? null,
    liquidityRaw: liqRaw, venueCount: poolRows.length,
    backingConfidence: backing.confidence ?? "UNKNOWN",
    custodianNamed: !!detectNamedCustodian((Array.isArray(backing.evidence) ? backing.evidence : []).map((e: AnyObj) => String(e.excerpt ?? ""))),
    contradictions: contradictions.length,
    firstContradiction: contradictions.length > 0 ? String(contradictions[0].issue).slice(0, 160) : null,
    unknowns, evidenceCount: evidence.length,
  });
  // HIGH means: at least 4 of 7 OKX endpoints agree + docs present +
  // independent tokenlist confirms the contract (fresh, not stale) + no
  // contradictions. Issuer claims alone can never produce HIGH, and neither
  // can a thin or stale source set.
  // (covGate kept for the overall-grade gate below; covD above feeds the dossier.)
  const covGate = covD;
  const overall =
    onchain.onchain === null ? "LOW"
    : covGate.ok >= 4 && onchain.confidence !== "LOW" && backing.confidence !== "UNKNOWN" && tlListed && contradictions.length === 0 ? "HIGH"
    : backing.confidence === "UNKNOWN" && onchain.confidence === "LOW" ? "LOW"
    : "MEDIUM";
  const report: AnyObj = {
    found: true, focus, lang,
    ...(fallbackNote ? { lang_note: fallbackNote } : {}),
    asset: { symbol: asset.symbol, name: asset.name, asset_type: asset.asset_type },
    issuer: { name: asset.issuer, legal: asset.issuer_legal ?? null, website: asset.official_website, documents: asset.official_documents },
    underlying: { exposure: asset.underlying_asset, ...(asset.underlying ?? {}) },
    backing: {
      issuer_claim: backing.issuer_claim, custodian: backing.custodian,
      confidence: backing.confidence, pages_read: backing.pages_read,
    },
    redemption: {
      note: "Confirm who can redeem, minimums, fees and settlement time in the issuer's current terms.",
      excerpts: backing.redemption_excerpts ?? [],
      geo_excerpts: geoExcerpts,
      attestation_links: attestLinks,
      who_can_redeem: "UNKNOWN — not confirmed from fetched pages; see excerpts and issuer terms.",
      confidence: backing.confidence,
    },
    underlying_detail: {
      ticker: underlyingCode,
      exchange: asset.underlying?.exchange ?? null,
      filings,
      dividend,
    },
    economics: {
      price: econ.price ?? null, marketCap: econ.marketCap ?? null, liquidity: econ.liquidity ?? null, supply: onchain.supply ?? null,
      turnover_24h: econ.turnover_24h ?? null, liquidity_to_mcap: econ.liquidity_to_mcap ?? null, avg_trade_size: econ.avg_trade_size ?? null,
      range_30d: onchain.price_history ?? null,
      underlying_price: spot.price !== null ? spot.price.toFixed(2) : null,
      underlying_source: spot.price !== null ? "Yahoo Finance quote (unverified third party)" : null,
      ...(spot.stale ? { spot_stale: true } : {}),
      premium_discount_bps: premiumBps,
      underlying_market_status: spot.price !== null ? mktStatus : null,
      reference_price_timestamp: spot.date ? `${spot.date} ${spot.time ?? ""}`.trim() : null,
    },
    onchain: {
      chains: onchain.chains, contracts: onchain.contracts ?? [], holders_count: onchain.holders_count ?? null,
      holder_concentration: onchain.holder_concentration ?? {}, trading_activity: econ,
      price_history: onchain.price_history ?? null,
      recent_trades: onchain.recent_trades ?? null,
      pools: onchain.pools ?? null,
      token_meta: onchain.token_meta ?? null,
      tokenlist_check: onchain.tokenlist_check ?? null,
      contract_crosscheck: onchain.contract_crosscheck ?? null,
      observations: onchain.observations ?? [], missing: onchain.missing ?? [],
    },
    risks,
    recent_developments: recent.items,
    ...(recent.note ? { recent_note: recent.note } : {}),
    contradictions,
    unknowns, evidence,
    // ---- Dossier product sections (Service 2) ----
    service: "research",
    research_plan: plan,
    research_snapshot: snapshot,
    executive_findings: findings,
    identity,
    backing_detail: backingDetail,
    onchain_analysis: {
      supply: onchain.supply ?? null,
      holders_count: onchain.holders_count ?? null,
      top_holders: topHolders,
      top10_percent: top10num,
      top5_percent: top5,
      largest_holder_percent: topHolders.length > 0 ? Number(topHolders[0].percent) : null,
      known_issuer_treasury_addresses: null,
      holder_history: null,
      holder_history_note: "Historical holder concentration unavailable — no time-series holder source in this version.",
      transfer_count_24h: econ.txs24H ?? null,
      transfer_activity: onchain.recent_trades ?? null,
      contracts: onchain.contracts ?? [],
      explorer: onchain.explorer ?? null,
      contract_crosscheck: onchain.contract_crosscheck ?? null,
      tokenlist_check: onchain.tokenlist_check ?? null,
      observations: onchain.observations ?? [],
      missing: onchain.missing ?? [],
    },
    liquidity_detail: {
      venues: poolRows.map((p: AnyObj) => ({ venue: String(p.label ?? "Pool"), liquidity_usd: p.liquidity_usd ?? null })),
      volume_24h: econ.volume24H ?? null,
      volume_7d: null,
      volume_7d_note: "7d volume unavailable — no 7d volume source in this version.",
      price_impact: priceImpact,
      venue_count: poolRows.length,
    },
    price_relationship: priceRelationship,
    risks_detailed: risksDetailed,
    unknowns_mandatory: unknowns,
    source_register: sourceRegister,
    confidence: { overall, identity: "HIGH", onchain: onchain.confidence ?? "UNKNOWN", backing: backing.confidence ?? "UNKNOWN" },
    data_timestamp: now(),
  };
  // Receipt: prove the work — segments appear only for sources that ran.
  const missingList: string[] = Array.isArray(onchain.missing) ? onchain.missing : [];
  const cov = okxCoverage(missingList);
  const pages = Array.isArray(backing.pages_read) ? backing.pages_read.length : 0;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const ranTokenlist = onchain.tokenlist_check?.checked === true;
  const ranSpot = spot.price !== null || spot.error !== undefined;
  const ranNews = focus === "full" || focus === "risks";
  const segs = [
    `${cov.ok}/${cov.total} ${L("rpt_endpoints")}`,
    `${pages} ${L("rpt_pages")}`,
    ...(ranTokenlist ? ["tokenlist"] : []),
    ...(ranSpot ? ["spot"] : []),
    ...(ranNews ? ["news"] : []),
  ];
  report.receipt = `${opts?.price ? `${L("rpt_paid")} ${opts.price}` : L("rpt_free")} · ${segs.join(" + ")} ${L("rpt_in")} ${secs}s · data ${report.data_timestamp}`;
  report.summary = summarizeResearch(report);
  if (focus === "backing") {
    // Backing focus: collateral evidence only — no market sections returned.
    return {
      service: "research",
      found: true, focus, lang,
      ...(fallbackNote ? { lang_note: fallbackNote } : {}),
      asset: report.asset,
      identity,
      underlying_security: asset.underlying_asset,
      backing_detail: backingDetail,
      evidence: report.evidence,
      unknowns: report.unknowns,
      unknowns_mandatory: unknowns,
      source_register: sourceRegister,
      research_plan: plan,
      confidence: report.confidence,
      summary: `## ${asset.symbol} — backing evidence\n- Issuer claim: ${cutWords(String(backing.issuer_claim ?? "none extracted"), 220)}\n- Independently verified: ${verifiedList.length} item(s) · On-chain observations: ${onchainObs.length}\n- Reserve amount: UNKNOWN — reconciliation not possible (see reconciliation note).`,
      receipt: report.receipt,
      note: "Backing focus: onchain skipped by focus (supply null for that reason); collateral evidence only.",
      data_timestamp: report.data_timestamp,
    };
  }
  if (focus === "risks") {
    return {
      service: "research",
      found: true, focus, lang,
      ...(fallbackNote ? { lang_note: fallbackNote } : {}),
      asset: report.asset,
      risks: report.risks, risks_detailed: risksDetailed,
      unknowns: report.unknowns, unknowns_mandatory: unknowns,
      source_register: sourceRegister, evidence_count: evidence.length,
      research_plan: plan,
      confidence: report.confidence,
      summary: `## ${report.asset.symbol} — top risks\n` + (report.risks as Risk[]).map((x) => `- **${x.category}** (${x.severity}): ${x.reason}`).join("\n"),
      receipt: report.receipt,
      note: "Risks focus: full data gathered, only risk sections returned.",
      data_timestamp: report.data_timestamp,
    };
  }
  return report;
}

// ---- Service 3: compare — normalized side-by-side table ----
// One row per metric, one column per asset; every cell carries value,
// timestamp and source. Observations only — never a winner.
export function buildComparisonTable(reports: AnyObj[]): AnyObj[] {
  const cell = (r: AnyObj, value: unknown, source: string): AnyObj => ({
    value: value ?? null, timestamp: r.data_timestamp ?? null, source,
  });
  const specs: { category: string; metric: string; get: (r: AnyObj) => AnyObj }[] = [
    { category: "identity", metric: "underlying", get: (r) => cell(r, r.asset?.name?.replace(/ xStock$/i, "") ?? r.identity?.identity?.underlying_asset ?? null, "uzam registry") },
    { category: "identity", metric: "issuer", get: (r) => cell(r, r.issuer?.name ?? null, "uzam registry") },
    { category: "identity", metric: "network", get: (r) => cell(r, "X Layer (chainId 196)", "uzam registry") },
    { category: "identity", metric: "contract", get: (r) => cell(r, r.identity?.identity?.contract_address ?? null, "xStocks product data (issuer-published)") },
    { category: "legal", metric: "instrument_type", get: (r) => cell(r, r.asset?.asset_type ?? null, "uzam registry") },
    { category: "legal", metric: "shareholder_rights", get: (r) => cell(r, "UNKNOWN — confirm in Final Terms", "uzam identify") },
    { category: "legal", metric: "official_docs", get: (r) => cell(r, `${(r.issuer?.documents ?? []).length} link(s) on file`, "uzam registry") },
    { category: "backing", metric: "model", get: (r) => cell(r, "tokenized-equity claim per issuer (claim, not verified)", "uzam backing focus") },
    { category: "backing", metric: "reserve_evidence", get: (r) => cell(r, ((r.backing_detail?.attestation_links ?? []).length > 0 ? `${(r.backing_detail.attestation_links as unknown[]).length} attestation link(s)` : "none found"), "uzam backing focus") },
    { category: "backing", metric: "custodian", get: (r) => cell(r, r.backing_detail?.custodian ?? null, "uzam backing focus") },
    { category: "backing", metric: "verification_status", get: (r) => cell(r, r.confidence?.backing ?? null, "uzam report confidence") },
    { category: "onchain", metric: "supply", get: (r) => cell(r, r.onchain_analysis?.supply?.circulating ?? null, "OKX price-info") },
    { category: "onchain", metric: "holders", get: (r) => cell(r, r.onchain_analysis?.holders_count ?? null, "OKX price-info") },
    { category: "onchain", metric: "top10_pct", get: (r) => cell(r, r.onchain_analysis?.top10_percent ?? null, "OKX advanced-info") },
    { category: "onchain", metric: "top5_pct", get: (r) => cell(r, r.onchain_analysis?.top5_percent ?? null, "OKX holder list (calculated)") },
    { category: "onchain", metric: "transfers_24h", get: (r) => cell(r, r.onchain_analysis?.transfer_count_24h ?? null, "OKX price-info") },
    { category: "liquidity", metric: "venues", get: (r) => cell(r, r.liquidity_detail?.venue_count ?? null, "OKX top-liquidity") },
    { category: "liquidity", metric: "liquidity_usd", get: (r) => cell(r, r.economics?.liquidity ?? null, "OKX price-info") },
    { category: "liquidity", metric: "volume_24h_usd", get: (r) => cell(r, r.economics?.volume24H ?? null, "OKX price-info") },
    { category: "liquidity", metric: "impact_usd_10k", get: (r) => cell(r, r.liquidity_detail?.price_impact?.venues?.[0]?.estimates?.usd_10000 ?? null, "uzam calculation") },
    { category: "price", metric: "token_price", get: (r) => cell(r, r.economics?.price ?? null, "OKX market/price") },
    { category: "price", metric: "reference_price", get: (r) => cell(r, r.price_relationship?.reference_price ?? null, "Yahoo quote (unverified)") },
    { category: "price", metric: "diff_bps", get: (r) => cell(r, r.price_relationship?.difference_bps ?? null, "uzam calculation") },
    { category: "documentation", metric: "proof_of_reserves", get: (r) => cell(r, ((r.backing_detail?.attestation_links ?? []).length > 0 ? "link(s) found" : "none found"), "uzam backing focus") },
    { category: "documentation", metric: "onchain_verified", get: (r) => cell(r, r.onchain_analysis?.tokenlist_check?.listed === true ? "contract listed on tokenlist" : "not confirmed", "xStocks tokenlist") },
    { category: "unknown", metric: "open_questions", get: (r) => cell(r, (r.unknowns as unknown[] | undefined)?.length ?? null, "uzam report") },
  ];
  return specs.map((s) => {
    const values: Record<string, AnyObj> = {};
    for (const r of reports) values[r.asset.symbol] = s.get(r);
    return { category: s.category, metric: s.metric, values };
  });
}

// ---- compare_assets: structured multi-asset comparison, evidence per row ----
const CONF_RANK: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

export async function compareAssets(symbols: string[], opts?: { price?: string; lang?: string }): Promise<AnyObj> {
  const t0 = Date.now();
  const lang = normalizeLang(opts?.lang);
  const L = (k: string): string => t(lang, k);
  const fallbackNote = langFallbackNote(opts?.lang, lang);
  const rawList = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const requested = [...new Set(rawList)];
  const duplicates_dropped = rawList.length - requested.length;
  const dropped = requested.slice(4);
  const list = requested.slice(0, 4);
  if (list.length === 0) {
    return { compared: [], error: "Provide 1-4 symbols, e.g. [\"AAPLx\", \"TSLAx\"].", supported_symbols: supportedSymbols() };
  }
  // Parallel: independent reports share nothing except read-only caches.
  const reports: AnyObj[] = await Promise.all(
    list.map(async (s) => {
      try {
        return await researchAsset(s, "full", { lang });
      } catch (e) {
        return { found: false, symbol: s, error: `research failed: ${e instanceof Error ? e.message : String(e)}`, data_timestamp: now() };
      }
    })
  );
  const found = reports.filter((r) => r.found === true);
  const notFound = reports.filter((r) => r.found !== true).map((r) => r.symbol);
  const rows = found.map((r) => ({
    symbol: r.asset.symbol, name: r.asset.name, issuer: r.issuer.name,
    underlying: r.underlying.exposure,
    price: r.economics.price, marketCap: r.economics.marketCap, liquidity: r.economics.liquidity,
    holders: r.onchain.holders_count,
    top10HoldPercent: r.onchain.holder_concentration?.top10HoldPercent ?? null,
    top3Percent: r.onchain.holder_concentration?.top3Percent ?? null,
    remainder_after_top3: r.onchain.holder_concentration?.remainder_after_top3 ?? null,
    turnover_24h: r.economics.turnover_24h ?? null,
    premium_discount_bps: r.economics.premium_discount_bps ?? null,
    range_30d: r.economics.range_30d ?? null,
    top_holders: (r.onchain.holder_concentration?.topHolders ?? []).slice(0, 3),
    backing_confidence: r.confidence.backing, onchain_confidence: r.confidence.onchain,
    overall_confidence: r.confidence.overall,
    open_risks: ((r.risks as Risk[] | undefined) ?? []).filter((x) => x.severity === "high" || x.severity === "moderate").map((x) => `${x.category} (${x.severity}): ${x.reason}`),
    unknowns_count: ((r.unknowns as string[] | undefined) ?? []).length, evidence_count: ((r.evidence as AnyObj[] | undefined) ?? []).length,
  }));
  const leaders: AnyObj[] = [];
  if (rows.length > 1) {
    const confs = new Set(rows.map((r) => String(r.backing_confidence)));
    const counts = new Set(rows.map((r) => Number(r.evidence_count)));
    if (confs.size === 1 && counts.size === 1) {
      leaders.push({ category: "backing_evidence", leader: null, reason: `Tie — every compared asset scores ${rows[0].backing_confidence} with ${rows[0].evidence_count} evidence items. No leader; documentation depth is identical.` });
    } else {
      const byEvidence = [...rows].sort((a, b) => (CONF_RANK[String(b.backing_confidence)] - CONF_RANK[String(a.backing_confidence)]) || (b.evidence_count - a.evidence_count));
      const topConf = CONF_RANK[String(byEvidence[0].backing_confidence)];
      const topCount = byEvidence[0].evidence_count;
      const tiedTop = byEvidence.filter((r) => CONF_RANK[String(r.backing_confidence)] === topConf && r.evidence_count === topCount);
      if (tiedTop.length > 1) {
        leaders.push({ category: "backing_evidence", leader: null, reason: `Tie at the top — ${tiedTop.map((r) => r.symbol).join(", ")} each score ${byEvidence[0].backing_confidence} with ${topCount} evidence items. No single leader.` });
      } else {
        leaders.push({ category: "backing_evidence", leader: byEvidence[0].symbol, reason: `${byEvidence[0].symbol} has backing confidence ${byEvidence[0].backing_confidence} with ${byEvidence[0].evidence_count} evidence items vs ${byEvidence.slice(1).map((r) => `${r.symbol} (${r.backing_confidence}, ${r.evidence_count})`).join(", ")}. Stronger here means better-documented, not safer.` });
      }
    }
    const withLiq = rows.filter((r) => hasNum(r.liquidity));
    if (withLiq.length > 1) {
      const byLiq = [...withLiq].sort((a, b) => Number(b.liquidity) - Number(a.liquidity));
      if (new Set(byLiq.map((r) => Number(r.liquidity))).size === 1) {
        leaders.push({ category: "liquidity", leader: null, reason: `Tie — all observed liquidities identical (${byLiq[0].liquidity}). No leader.` });
      } else {
        const withTurn = rows.filter((r) => hasNum(r.turnover_24h));
        const turnBest = withTurn.length > 0 ? [...withTurn].sort((a, b) => Number(b.turnover_24h) - Number(a.turnover_24h))[0] : null;
        leaders.push({ category: "liquidity", leader: byLiq[0].symbol, reason: `${byLiq[0].symbol} shows higher observed liquidity (${byLiq[0].liquidity}) than ${byLiq.slice(1).map((r) => `${r.symbol} (${r.liquidity})`).join(", ")}. Thinner books can mean larger price impact.${turnBest ? ` Highest 24h turnover though: ${turnBest.symbol} at ${turnBest.turnover_24h}x — biggest pool is not always the most-traded one.` : ""}` });
      }
    }
    const withConc = rows.filter((r) => hasNum(r.top10HoldPercent));
    if (withConc.length > 1) {
      const sorted10 = [...withConc].sort((a, b) => Number(a.top10HoldPercent) - Number(b.top10HoldPercent));
      const withTop3 = rows.filter((r) => hasNum(r.top3Percent));
      if (withTop3.length <= 1) {
        if (new Set(sorted10.map((r) => Number(r.top10HoldPercent))).size === 1) {
          leaders.push({ category: "holder_dispersion", leader: null, reason: "Tie on top-10 concentration across all compared assets. No leader." });
        } else {
          leaders.push({ category: "holder_dispersion", leader: sorted10[0].symbol, reason: `${sorted10[0].symbol} is least concentrated by top-10 (${sorted10[0].top10HoldPercent}%). Top-3 slice unavailable — leader from top-10 only.` });
        }
      } else {
        const sorted3 = [...withTop3].sort((a, b) => Number(a.top3Percent) - Number(b.top3Percent));
        const by10 = sorted10[0].symbol;
        const by3 = sorted3[0].symbol;
        const tie10 = Number(sorted10[0].top10HoldPercent) === Number(sorted10[1].top10HoldPercent);
        const tie3 = Number(sorted3[0].top3Percent) === Number(sorted3[1].top3Percent);
        if (tie10 && tie3) {
          leaders.push({ category: "holder_dispersion", leader: null, reason: "Tie on both concentration slices. No leader." });
        } else if (by10 === by3) {
          leaders.push({ category: "holder_dispersion", leader: by10, reason: `${by10} is least concentrated on both slices (top 10: ${sorted10[0].top10HoldPercent}%, top 3: ${sorted3[0].top3Percent}%) — slices agree.` });
        } else {
          leaders.push({ category: "holder_dispersion", leader: null, reason: `Slices disagree: top-10 says ${by10} (${sorted10[0].top10HoldPercent}%) is least concentrated, top-3 says ${by3} (${sorted3[0].top3Percent}%). No single leader — concentration depends on which slice you weight.` });
        }
      }
    }
  }
  // Whale recurrence: top-holder addresses appearing across several tokens.
  // Pattern is consistent with issuer/venue wallets — identities NOT verified.
  // Map (not a plain object): holder addresses are attacker-influenced keys
  // and "__proto__" must never repoint a prototype.
  const addrMap = new Map<string, { symbols: string[]; maxPercent: number }>();
  for (const r of rows) {
    for (const h of ((r.top_holders as AnyObj[] | undefined) ?? [])) {
      const a = String(h.address ?? "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(a)) continue;
      const cur = addrMap.get(a) ?? { symbols: [], maxPercent: 0 };
      if (!cur.symbols.includes(r.symbol)) cur.symbols.push(r.symbol);
      const n = Number(h.percent);
      if (Number.isFinite(n)) cur.maxPercent = Math.max(cur.maxPercent, n);
      addrMap.set(a, cur);
    }
  }
  const shared_holders = [...addrMap.entries()]
    .filter(([, v]) => v.symbols.length > 1)
    .map(([address, v]) => ({ address, tokens: v.symbols, max_percent: Number(v.maxPercent.toFixed(2)), note: "Recurs as a top holder across tokens — pattern consistent with issuer/venue wallets. Identity NOT verified; do not treat as fact." }))
    .sort((a, b) => b.tokens.length - a.tokens.length || b.max_percent - a.max_percent);
  const out: AnyObj = {
    compared: rows.map((r) => r.symbol), rows, leaders, shared_holders, lang,
    service: "compare",
    comparison_table: buildComparisonTable(found),
    ...(fallbackNote ? { lang_note: fallbackNote } : {}),
    ...(duplicates_dropped > 0 ? { duplicates_dropped, duplicates_note: `${duplicates_dropped} duplicate input(s) collapsed (case-insensitive).` } : {}),
    ...(dropped.length > 0 ? { dropped_symbols: dropped, dropped_note: `Only the first 4 were compared; ignored: ${dropped.join(", ")}.` } : {}),
    not_found: notFound, supported_symbols: supportedSymbols(),
    note: "Leaders are per-category and evidence-based. A leader in one category is not an overall recommendation.",
    data_timestamp: now(),
  };
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  out.receipt = `${opts?.price ? `${L("rpt_paid")} ${opts.price}` : L("rpt_free")} · ${rows.length} ${L("rpt_reports")} ${L("rpt_in")} ${secs}s · data ${out.data_timestamp}`;
  out.summary = summarizeCompare(out);
  return out;
}
