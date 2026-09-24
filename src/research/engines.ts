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
import { normalizeLang, t, sev } from "./i18n.js";
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
  official_website: string;
  official_documents: string[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyObj = Record<string, any>;

const registry = registryJson as {
  chain: { name: string; chainId: number; chainIndex: number };
  tokenlist: string;
  assets: RegistryAsset[];
};

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
const TOKENLIST_RAW = "https://raw.githubusercontent.com/backed-fi/cowswap-xstocks-tokenlist/main/tokenlist.json";
let tlCache: { at: number; tokens: AnyObj[] } | null = null;
let tlInflight: Promise<AnyObj[]> | null = null;

function lookupTokenlist(contract: string): { listed: boolean; matched_symbol: string | null } {
  const hit = tlCache?.tokens.find(
    (t) => Number(t.chainId) === 196 && String(t.address ?? "").toLowerCase() === contract.toLowerCase()
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
  try {
    await fetchTokenlist();
    return lookupTokenlist(contract);
  } catch (e) {
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
  if (contract && !/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    missing.push("contract_on_xlayer: search returned a non-EVM address; refusing to query further");
  }
  const lc = (contract ?? "").toLowerCase();
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
  let candles: AnyObj[] = [];
  let trades: AnyObj[] = [];
  let pools: AnyObj[] = [];
  const [candleRes, tradeRes, poolRes] = await Promise.all([
    okx.getCandles(XLAYER_CHAIN_INDEX, lc, "1Dutc", "30"),
    okx.getTrades(XLAYER_CHAIN_INDEX, lc, "20"),
    okx.getTopLiquidity(XLAYER_CHAIN_INDEX, lc),
  ]);
  if (candleRes.ok && Array.isArray(candleRes.data)) candles = candleRes.data as AnyObj[];
  else missing.push(`candles: ${candleRes.error ?? "no data"}`);
  if (tradeRes.ok && Array.isArray(tradeRes.data)) trades = tradeRes.data as AnyObj[];
  else missing.push(`trades: ${tradeRes.error ?? "no data"}`);
  if (poolRes.ok && Array.isArray(poolRes.data)) pools = poolRes.data as AnyObj[];
  else missing.push(`pools: ${poolRes.error ?? "no data"}`);

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
    tokenlist_check = { checked: true, listed: true, matched_symbol: tl.matched_symbol };
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

  const top = holders
    .map((h) => ({ address: String(h.holderWalletAddress ?? ""), percent: Number(h.holdPercent ?? 0) }))
    .filter((h) => h.address && Number.isFinite(h.percent))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 5);
  const top3 = top.slice(0, 3).reduce((s, h) => s + h.percent, 0);
  const observations: string[] = [];
  if (priceHistory) observations.push(`30d range: low ${priceHistory.low} / high ${priceHistory.high} (${priceHistory.points} daily candles, ${priceHistory.change_pct ?? "n/a"}% change).`);
  if (tradeFeed && (tradeFeed.buys + tradeFeed.sells) > 0) observations.push(`Recent trades: ${tradeFeed.buys} buys / ${tradeFeed.sells} sells in last ${tradeFeed.sampled} swaps.`);
  if (poolBreakdown && poolBreakdown.pools.length > 0) observations.push(`Liquidity sits in ${poolBreakdown.pools.length} pool(s), top: ${poolBreakdown.pools[0].label}.`);
  if (advanced?.top10HoldPercent !== null && advanced?.top10HoldPercent !== undefined && advanced?.top10HoldPercent !== "") observations.push(`Top 10 holders control ${advanced.top10HoldPercent}% of supply (OKX advanced-info).`);
  if (top.length > 0) observations.push(`Largest holder: ${top[0].address.slice(0, 10)}… at ${top[0].percent}%. Top 3 combined: ${top3.toFixed(2)}%.`);
  if (advanced?.stockProfile) observations.push(`OKX reports underlying stock profile: ${advanced.stockProfile.companyName ?? ""} (${advanced.stockProfile.stockCode ?? ""}, ${advanced.stockProfile.exchange ?? ""}). Exchange data, not issuer verification.`);
  if (missing.length > 0) observations.push(`Partial data: ${missing.length} source(s) unavailable. See missing[].`);
  if (tokenlist_check.listed) observations.push(`Independent tokenlist confirms this contract as ${tokenlist_check.matched_symbol} on X Layer — agrees with OKX.`);
  const ratios = tradeRatios(info?.volume24H, info?.liquidity ?? hit?.liquidity, info?.marketCap ?? hit?.marketCap, info?.txs24H);
  const sourcesAgree = (price ? 1 : 0) + (info ? 1 : 0) + (advanced ? 1 : 0) >= 2;
  return {
    found: true, symbol: asset.symbol, name: asset.name,
    chains: ["X Layer"], contracts: [contract],
    explorer: hit?.explorerUrl ?? `https://www.okx.com/web3/explorer/xlayer/token/${contract}`,
    search_price: hit?.price ?? null,
    stock_profile: advanced?.stockProfile ?? null,
    tokenlist_check,
    extra_evidence,
    supply: info?.circSupply ? { circulating: info.circSupply } : {},
    holders_count: info?.holders ?? hit?.holders ?? null,
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
    evidence, pages_read: fetched,
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
  const top10 = toNum(onchain?.holder_concentration?.top10HoldPercent);
  const liq = toNum(onchain?.trading_activity?.liquidity);
  const missing: string[] = Array.isArray(onchain?.missing) ? onchain.missing : [];
  const risks: Risk[] = [
    {
      category: "concentration",
      severity: top10 === null ? "unknown" : top10 > 80 ? "high" : top10 > 50 ? "moderate" : "low",
      reason: top10 === null ? "No holder distribution data available." : `Top 10 holders control ${top10}% of supply.`,
      evidence: top10 === null ? [] : ["okx:advanced-info:top10HoldPercent"],
    },
    {
      category: "liquidity",
      severity: liq === null ? "unknown" : liq < 50000 ? "high" : liq < 500000 ? "moderate" : "low",
      reason: liq === null ? "No liquidity figure available." : `Observed pool liquidity ${liq} (OKX). Thin books can mean large price impact.`,
      evidence: liq === null ? [] : ["okx:price-info:liquidity"],
    },
    {
      category: "backing",
      severity: backing?.confidence === "UNKNOWN" ? "high" : backing?.confidence === "LOW" ? "moderate" : "low",
      reason: `Backing evidence confidence is ${backing?.confidence ?? "UNKNOWN"}. Issuer statements are claims until independently verified.`,
      evidence: ["uzam:analyze_backing"],
    },
    {
      category: "redemption",
      severity: String(backing?.unanswered_questions ?? []).match(/redemption mechanics/i) ? "moderate" : "low",
      reason: "Redemption eligibility, minimums and settlement must be confirmed in issuer terms before assuming exit is available.",
      evidence: ["uzam:analyze_backing"],
    },
    {
      category: "issuer",
      severity: "low",
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
      severity: "moderate",
      reason: "Tokenized equities typically carry geo and eligibility restrictions (e.g. xStocks excludes several jurisdictions). Confirm eligibility in issuer terms.",
      evidence: ["issuer:terms"],
    },
    {
      category: "information",
      severity: missing.length > 2 ? "moderate" : "low",
      reason: missing.length === 0 ? "Full MVP source coverage." : `Gaps in this report: ${missing.join("; ")}.`,
      evidence: [],
    },
  ];
  return risks;
}

// ---- Contradiction detection (PDF section 18): never silently pick a side ----
export function detectContradictions(asset: RegistryAsset, onchain: AnyObj): AnyObj[] {
  const out: AnyObj[] = [];
  // Check 1: underlying code — registry ("AAPL (Apple ...)") vs OKX stockProfile.
  const expected = asset.underlying_asset.split(/[\s(]/)[0].toUpperCase();
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
  // Check 2: price consistency — OKX search quote vs price endpoint.
  const a = Number(onchain?.search_price);
  const b = Number(onchain?.trading_activity?.price);
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

function toNum(v: unknown): number | null {
  if (isBlank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function hasNum(v: unknown): boolean {
  return toNum(v) !== null;
}

export function pct(v: unknown): string {
  const n = toNum(v);
  return n === null ? "n/a" : `${n}%`;
}

// Money for display: 2 decimals. Raw strings stay in *_raw fields.
export function fmtMoney(v: unknown): string | null {
  const n = toNum(v);
  return n === null ? null : n.toFixed(2);
}

// ---- Shared OKX coverage counter: ONE definition, used by receipt,
// verdict box and unknowns alike so the numbers can never disagree.
// The 7 counted endpoints are the data calls; token_search/tokenlist are
// resolution steps and are reported separately in missing[], not here.
const OKX_CORE = ["price", "price_info", "advanced_info", "holders", "candles", "trades", "pools"];

export function okxCoverage(missing: unknown): { ok: number; total: number } {
  const total = OKX_CORE.length;
  if (!Array.isArray(missing)) return { ok: total, total };
  // No credentials, no identity, or no contract = no data call was possible.
  if (missing.includes("skipped_by_focus") || missing.includes("okx_credentials") || missing.includes("asset_identity") || missing.includes("contract_on_xlayer")) return { ok: 0, total };
  const failed = new Set(missing.map((m) => String(m).split(":")[0].trim()));
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
  const rows = pools.slice(0, 5).map((p) => {
    const liq = toNum(p.liquidityUsd ?? p.liquidity ?? p.tvl ?? p.tvlUsd);
    const label = `${String(p.protocol ?? p.dex ?? p.exchange ?? "pool")} ${p.fee ?? p.feeRate ?? ""}`.trim();
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

export async function fetchSpot(code: string): Promise<Spot & { stale?: boolean }> {
  const key = code.toUpperCase();
  const cached = spotCache[key];
  if (cached && Date.now() - cached.at < 60_000) return cached.spot;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${key}?interval=1d&range=5d`;
  const fail = (error: string): Spot & { stale?: boolean } =>
    cached ? { ...cached.spot, stale: true } : { price: null, date: null, time: null, error };
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return fail(`spot HTTP ${res.status}`);
    const json = (await res.json()) as AnyObj;
    const meta = json?.chart?.result?.[0]?.meta;
    const px = Number(meta?.regularMarketPrice);
    const t = Number(meta?.regularMarketTime);
    if (!Number.isFinite(px) || px <= 0) return fail("spot quote unparseable");
    const spot: Spot = {
      price: px,
      date: t ? new Date(t * 1000).toISOString().slice(0, 10) : null,
      time: t ? new Date(t * 1000).toISOString().slice(11, 16) + " UTC" : null,
    };
    spotCache[key] = { at: Date.now(), spot };
    if (Object.keys(spotCache).length > 50) spotCache = { [key]: spotCache[key] };
    return spot;
  } catch (e) {
    return fail(`spot fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---- SEC EDGAR filings recency (keyless, UA header required) + dividends ----
export type FilingInfo = { form: string; date: string; url: string } | null;

export async function fetchLatestFilings(cik: string): Promise<{ k10: FilingInfo; q10: FilingInfo; error?: string }> {
  const padded = cik.padStart(10, "0");
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "uzam-mvp/0.1 (+research)", "Accept": "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { k10: null, q10: null, error: `SEC HTTP ${res.status}` };
    const json = (await res.json()) as AnyObj;
    const recent = json?.filings?.recent;
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
    return { k10: null, q10: null, error: `SEC fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function fetchDividend(code: string): Promise<{ amount: string | null; date: string | null; error?: string }> {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${code}?range=1y&interval=1mo&events=div`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { amount: null, date: null, error: `dividend HTTP ${res.status}` };
    const json = (await res.json()) as AnyObj;
    const divs = json?.chart?.result?.[0]?.events?.dividends;
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
    return { amount: null, date: null, error: `dividend fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Nasdaq hours in America/New_York: Mon–Fri 09:30–16:00. Else closed.
export function marketStatus(at = new Date()): "open" | "closed" {
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
    return "closed";
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
  const conc = r.onchain.holder_concentration ?? {};
  // Verdict box: numbers first, one screen.
  lines.push(`## ${r.asset.symbol} — ${r.asset.name} (X Layer)`);
  const prem = r.economics?.premium_discount_bps;
  const premTxt = prem === null || prem === undefined
    ? "premium n/a (no underlying reference)"
    : `${prem >= 0 ? "+" : ""}${prem} bps (≈ ${(prem / 100).toFixed(2)}%) vs ${r.economics?.underlying_market_status === "closed" ? "CLOSED" : "open"} reference`;
  lines.push(`> Token **${ta.price ?? "n/a"}** vs underlying **${r.economics?.underlying_price ?? "n/a"}** (${premTxt})`);
  lines.push(`> ${L("lbl_holders")} **${r.onchain.holders_count ?? "n/a"}** · Top-10 **${pct(conc.top10HoldPercent)}** · ${L("lbl_liquidity")} **${ta.liquidity ?? "n/a"}**`);
  lines.push(`> ${L("lbl_backing")}: **${r.backing.confidence}** — ${r.backing.custodian ?? "custodian UNKNOWN"}`);
  lines.push(`> ${L("lbl_overall")}: **${r.confidence.overall}** — ${confidenceReceipt(r)}`);
  lines.push(`> ${L("scale")}`);
  const premFormula = prem !== null && prem !== undefined && r.economics?.underlying_price
    ? `Premium = (token − underlying) / underlying, token ${ta.price_raw ?? ta.price} vs spot ${r.economics.underlying_price} (${r.economics.reference_price_timestamp ?? "no timestamp"}).${r.economics.underlying_market_status === "closed" ? " Nasdaq was CLOSED — treat as stale, re-check when open." : ""}`
    : `No premium computed (${!r.economics?.underlying_price ? "underlying spot unavailable" : "no token price"}).`;
  lines.push(`### ${L("sec_premium")}`);
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
      lines.push(`- Turnover 24h: **${ta.turnover_24h ?? "n/a"}x** · Liquidity/mcap: **${ta.liquidity_to_mcap ?? "n/a"}** · Avg trade: **${ta.avg_trade_size ? `$${ta.avg_trade_size}` : "n/a"}** · Txs 24h: **${ta.txs24H ?? "n/a"}** · Volume 24h: **$${ta.volume24H_raw ?? "n/a"}** · Mcap: **$${ta.marketCap_raw ?? "n/a"}**.`);
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
  // All 9 risks, ranked — the buyer pays to see the hidden ones too.
  const risks = [...((r.risks as Risk[] | undefined) ?? [])].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  lines.push(`### ${L("sec_risks")}`);
  for (const x of risks) lines.push(`- **${x.category}** (${sev(lang, x.severity)}): ${x.reason}`);
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
  // Evidence as linked bullets with tier badges.
  const ev = ((r.evidence as AnyObj[] | undefined) ?? []).slice(0, 8);
  lines.push(`### ${L("sec_evidence")} ${L("ev_original")}`);
  if (ev.length === 0) lines.push(`- None captured — see unknowns.`);
  for (const e of ev) {
    const excerpt = String(e.excerpt ?? "").slice(0, 200);
    lines.push(`- [${e.source_title ?? "source"}](${e.source_url ?? "#"}) [Tier-${e.tier ?? "?"} ${e.source_type ?? ""}] — "${excerpt}"`);
  }
  const recent = ((r.recent_developments as AnyObj[] | undefined) ?? []).slice(0, 3);
  lines.push(`### ${L("sec_recent")}`);
  if (recent.length === 0) lines.push(`- None found${r.recent_note ? ` (${r.recent_note})` : ""}.`);
  for (const n of recent) lines.push(`- [${n.title}](${n.url ?? "#"}) (${n.source ?? "news"}${n.published_at ? `, ${n.published_at}` : ""})`);
  const contra = (r.contradictions as AnyObj[]) ?? [];
  lines.push(`### ${L("sec_contradictions")}`);
  if (contra.length === 0) lines.push(`- No contradictions in the 3 automated checks (underlying code, OKX price drift >10%, tokenlist symbol). Limited coverage — see unknowns.`);
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
  if (r.receipt) lines.push(`\n---\n${r.receipt}`);
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
  if (!c.rows || c.rows.length === 0) return `**No assets compared.** ${c.error ?? ""}`;
  const lang = normalizeLang(c.lang);
  const L = (k: string): string => t(lang, k);
  const lines: string[] = [];
  lines.push(`## ${L("cmp_title")}: ${(c.compared as string[]).join(" vs ")}`);
  lines.push(`| Asset | Price | Premium | Holders | Top 10 | Liquidity | Backing | Overall |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of c.rows as AnyObj[]) {
    const prem = r.premium_discount_bps === null || r.premium_discount_bps === undefined ? "n/a" : `${r.premium_discount_bps >= 0 ? "+" : ""}${r.premium_discount_bps}bps`;
    lines.push(`| ${r.symbol} | ${r.price ?? "n/a"} | ${prem} | ${r.holders ?? "n/a"} | ${r.top10HoldPercent ?? "n/a"}% | ${r.liquidity ?? "n/a"} | ${r.backing_confidence} | ${r.overall_confidence} |`);
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
      lines.push(`- ${L("cmp_liquid")}: ${sorted[0].symbol} (${sorted[0].liquidity}) vs ${sorted[sorted.length - 1].symbol} (${sorted[sorted.length - 1].liquidity}, ${(Number(sorted[0].liquidity) / Math.max(1, Number(sorted[sorted.length - 1].liquidity))).toFixed(1)}x).`);
    }
    const withConc = rows.filter((r) => hasNum(r.top10HoldPercent));
    if (withConc.length > 1) {
      const sorted = [...withConc].sort((a, b) => Number(a.top10HoldPercent) - Number(b.top10HoldPercent));
      lines.push(`- ${L("cmp_dispersed")}: ${sorted[0].symbol} (top-10 ${sorted[0].top10HoldPercent}%) vs ${sorted[sorted.length - 1].symbol} (${sorted[sorted.length - 1].top10HoldPercent}%).`);
    }
  }
  lines.push(`### ${L("sec_leaders")}`);
  for (const l of (c.leaders as AnyObj[])) lines.push(`- **${l.category}: ${l.leader ?? "tie"}** — ${l.reason}`);
  const withRange = rows.filter((r) => r.range_30d && r.range_30d.low);
  if (withRange.length > 0) {
    lines.push(`### ${L("sec_activity")}`);
    for (const r of withRange) {
      lines.push(`- ${r.symbol} 30d: low **${r.range_30d.low}** / high **${r.range_30d.high}** (${r.range_30d.change_pct ?? "n/a"}% change) · turnover **${r.turnover_24h ?? "n/a"}x**.`);
    }
  }
  const shared = ((c.shared_holders as AnyObj[] | undefined) ?? []).slice(0, 3);
  if (shared.length > 0) {
    lines.push(`### ${L("sec_whales")}`);
    for (const h of shared) lines.push(`- \`${String(h.address).slice(0, 12)}…\` in ${h.tokens.join(", ")} (max ${h.max_percent}%) — consistent with issuer/venue wallets, UNVERIFIED.`);
  }
  const nf = ((c.not_found as string[] | undefined) ?? []);
  if (nf.length > 0) lines.push(`Not found: ${nf.join(", ")}.`);
  if (c.receipt) lines.push(`\n---\n${c.receipt}`);
  return lines.join("\n");
}

// ---- research_asset: one-call full report ----
export async function researchAsset(symbol: string, focus: "full" | "issuer" | "backing" | "risks" = "full", opts?: { price?: string; lang?: string }): Promise<AnyObj> {
  const t0 = Date.now();
  const lang = normalizeLang(opts?.lang);
  const L = (k: string): string => t(lang, k);
  const clean = symbol.trim().toUpperCase();
  const asset = findAsset(clean);
  if (!asset) {
    return {
      found: false, symbol: clean, lang,
      uncertainty: L("id_unknown"),
      supported_symbols: supportedSymbols(), confidence: "UNKNOWN", data_timestamp: now(),
    };
  }
  if (focus === "issuer") {
    return {
      found: true, focus, lang,
      asset: { symbol: asset.symbol, name: asset.name, asset_type: asset.asset_type },
      issuer: { name: asset.issuer, legal: asset.issuer_legal ?? null, website: asset.official_website, documents: asset.official_documents },
      underlying: { exposure: asset.underlying_asset, ...(asset.underlying ?? {}) },
      note: "Issuer focus: identity only, no onchain or document fetches performed.",
      confidence: { overall: "MEDIUM", identity: "HIGH", onchain: "UNKNOWN", backing: "UNKNOWN" },
      data_timestamp: now(),
    };
  }
  const skipOnchain = focus === "backing";
  const onchainStub: AnyObj = { found: true, symbol: asset.symbol, name: asset.name, chains: asset.chains, chainIds: asset.chainIds, onchain: null, missing: ["skipped_by_focus"], confidence: "UNKNOWN", data_timestamp: now() };
  const [onchain, backing] = await Promise.all([
    skipOnchain ? onchainStub : gatherOnchain(clean, asset),
    gatherBacking(asset),
  ]);
  const recent = focus === "full" || focus === "risks" ? await gatherRecent(asset) : { items: [], note: "Skipped by focus." };
  const contradictions = detectContradictions(asset, onchain);
  const risks = buildRisks(onchain, backing);
  const econ = onchain.trading_activity ?? {};
  // Underlying spot + premium/discount (needs a token price; skipped otherwise).
  // Prefer the registry's explicit ticker; fall back to parsing the old string.
  const underlyingCode = (asset.underlying?.ticker ?? asset.underlying_asset.split(/[\s(]/)[0]).toUpperCase();
  const isEtf = asset.asset_type === "tokenized_etf";
  let spot: { price: number | null; date: string | null; time: string | null; error?: string } = { price: null, date: null, time: null };
  let premiumBps: number | null = null;
  let mktStatus: "open" | "closed" = "closed";
  const tokenPx = Number(econ.price_raw ?? econ.price);
  const codeOk = /^[A-Z][A-Z.]{0,9}$/.test(underlyingCode);
  if (Number.isFinite(tokenPx) && tokenPx > 0 && codeOk && focus !== "risks") {
    spot = await fetchSpot(underlyingCode);
    mktStatus = marketStatus();
    if (spot.price) premiumBps = Math.round(((tokenPx - spot.price) / spot.price) * 10000);
  }
  // SEC filings (stocks only; ETFs link the issuer page instead) + dividends.
  let filings: AnyObj = { skipped: true };
  let dividend: AnyObj = { skipped: true };
  const cik = asset.underlying?.cik ?? null;
  if (focus !== "risks" && !isEtf && cik) {
    const { k10, q10, error } = await fetchLatestFilings(cik);
    filings = { cik, latest_10k: k10, latest_10q: q10, filings_url: asset.underlying?.sec_filings ?? null, ...(error ? { error } : {}) };
    const div = await fetchDividend(underlyingCode);
    dividend = {
      underlying_last_amount: div.amount, underlying_last_date: div.date,
      ...(div.error ? { error: div.error } : {}),
      xstock_treatment: "UNKNOWN — whether this xStock passes through dividends must be confirmed in the issuer's Final Terms.",
    };
  } else if (isEtf) {
    filings = { note: "ETF underlying — no single-company 10-K. See holdings page.", holdings_url: asset.underlying?.sec_filings ?? null };
  }
  const tlListed = onchain.tokenlist_check?.listed === true;
  const unknowns: string[] = [
    ...(Array.isArray(backing.unanswered_questions) ? backing.unanswered_questions.filter((q) => tlListed ? !/No independent.*verification/i.test(String(q)) : true) : []),
    ...(Array.isArray(onchain.missing) && onchain.missing.length > 0 ? [`Onchain gaps: ${onchain.missing.join("; ")}`] : []),
    ...(tokenPx > 0 && !codeOk ? [`Premium skipped: underlying code "${underlyingCode}" is not a plain ticker.`] : []),
  ];
  if (premiumBps !== null && mktStatus === "closed") unknowns.push(`Premium/discount (${premiumBps} bps) is measured against a stale reference — Nasdaq was closed at check time (${spot.date ?? ""} ${spot.time ?? ""}).`);
  if (spot.error && tokenPx > 0) unknowns.push(`Underlying spot unavailable: ${spot.error}. No premium computed.`);
  if (filings.error) unknowns.push(`SEC filings unavailable: ${filings.error}.`);
  if (!filings.skipped && !filings.latest_10k && !filings.latest_10q && !filings.error && !filings.note) unknowns.push("No 10-K/10-Q found in recent SEC submissions.");
  if (dividend.error) unknowns.push(`Underlying dividend history unavailable: ${dividend.error}.`);
  if (!dividend.skipped && !dividend.underlying_last_amount && !dividend.error) unknowns.push("No dividend in the last 12 months of underlying price history (or history unavailable).");
  const geoExcerpts: string[] = Array.isArray(backing.geo_excerpts) ? backing.geo_excerpts : [];
  if (geoExcerpts.length === 0) unknowns.push("No jurisdiction/eligibility list extracted from fetched pages — confirm geo eligibility in issuer terms.");
  const attestLinks: string[] = Array.isArray(backing.attestation_links) ? backing.attestation_links : [];
  if (attestLinks.length === 0) unknowns.push("No reserve attestation or proof-of-reserves link found on fetched pages.");
  const evidence: AnyObj[] = [
    ...(Array.isArray(backing.evidence) ? backing.evidence.slice(0, 10) : []),
    ...(onchain.explorer ? [{ claim: "Onchain record for this contract.", source_title: "OKX X Layer explorer", source_url: onchain.explorer, excerpt: `Contract ${Array.isArray(onchain.contracts) ? onchain.contracts[0] : ""} on X Layer (chain 196).`,     basis: "fact", source_type: "market_data" as SourceType, tier: 2, confidence: "MEDIUM", retrieved_at: now() }] : []),
    ...(Array.isArray(onchain.extra_evidence) ? onchain.extra_evidence : []),
  ];
  // SEC filings as Tier-1 legal evidence (underlying company, not the token).
  for (const f of [filings.latest_10k, filings.latest_10q]) {
    if (f) {
      evidence.push({
        claim: `Underlying ${underlyingCode} filed ${f.form} on ${f.date} (SEC EDGAR).`,
        source_title: `SEC EDGAR ${f.form}`, source_url: f.url,
        excerpt: `${underlyingCode} ${f.form} filed ${f.date} — primary source for the underlying company's financials.`,
        basis: "fact", source_type: "legal_document" as SourceType, tier: 1, confidence: "HIGH", retrieved_at: now(),
      });
    }
  }
  // HIGH means: multiple OKX endpoints agree + docs present + independent
  // tokenlist confirms the contract + no contradictions. Issuer claims alone
  // can never produce HIGH, and neither can a single data source.
  const overall =
    onchain.onchain === null ? "LOW"
    : onchain.confidence === "HIGH" && backing.confidence !== "UNKNOWN" && tlListed && contradictions.length === 0 ? "HIGH"
    : backing.confidence === "UNKNOWN" && onchain.confidence === "LOW" ? "LOW"
    : "MEDIUM";
  const report: AnyObj = {
    found: true, focus, lang,
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
      price: econ.price ?? null, marketCap: econ.marketCap ?? null, liquidity: econ.liquidity ?? null, supply: onchain.supply ?? {},
      turnover_24h: econ.turnover_24h ?? null, liquidity_to_mcap: econ.liquidity_to_mcap ?? null, avg_trade_size: econ.avg_trade_size ?? null,
      range_30d: onchain.price_history ?? null,
      underlying_price: spot.price !== null ? spot.price.toFixed(2) : null,
      underlying_source: spot.price !== null ? "Yahoo Finance quote (unverified third party)" : null,
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
      tokenlist_check: onchain.tokenlist_check ?? null,
      observations: onchain.observations ?? [], missing: onchain.missing ?? [],
    },
    risks,
    recent_developments: recent.items,
    ...(recent.note ? { recent_note: recent.note } : {}),
    contradictions,
    unknowns, evidence,
    confidence: { overall, identity: "HIGH", onchain: onchain.confidence ?? "UNKNOWN", backing: backing.confidence ?? "UNKNOWN" },
    data_timestamp: now(),
  };
  // Receipt footer: prove the work. Sources counted from what actually ran.
  const missingList: string[] = Array.isArray(onchain.missing) ? onchain.missing : [];
  const cov = okxCoverage(missingList);
  const pages = Array.isArray(backing.pages_read) ? backing.pages_read.length : 0;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  report.receipt = `${opts?.price ? `${L("rpt_paid")} ${opts.price}` : L("rpt_free")} · ${cov.ok}/${cov.total} ${L("rpt_endpoints")} + ${pages} ${L("rpt_pages")} + tokenlist + spot + news ${L("rpt_in")} ${secs}s · data ${report.data_timestamp}`;
  report.summary = summarizeResearch(report);
  if (focus === "risks") {
    return {
      found: true, focus, asset: report.asset,
      risks: report.risks, unknowns: report.unknowns, confidence: report.confidence,
      summary: `## ${report.asset.symbol} — top risks\n` + (report.risks as Risk[]).map((x) => `- **${x.category}** (${x.severity}): ${x.reason}`).join("\n"),
      note: "Risks focus: full data gathered, only risk sections returned.",
      data_timestamp: report.data_timestamp,
    };
  }
  return report;
}

// ---- compare_assets: structured multi-asset comparison, evidence per row ----
const CONF_RANK: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

export async function compareAssets(symbols: string[], opts?: { price?: string; lang?: string }): Promise<AnyObj> {
  const t0 = Date.now();
  const lang = normalizeLang(opts?.lang);
  const L = (k: string): string => t(lang, k);
  const requested = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const dropped = requested.slice(4);
  const list = requested.slice(0, 4);
  if (list.length === 0) {
    return { compared: [], error: "Provide 1-4 symbols, e.g. [\"AAPLx\", \"TSLAx\"].", supported_symbols: supportedSymbols() };
  }
  const reports: AnyObj[] = [];
  for (const s of list) {
    try {
      reports.push(await researchAsset(s, "full", { lang }));
    } catch (e) {
      reports.push({ found: false, symbol: s, error: `research failed: ${e instanceof Error ? e.message : String(e)}`, data_timestamp: now() });
    }
  }
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
      leaders.push({ category: "backing_evidence", leader: byEvidence[0].symbol, reason: `${byEvidence[0].symbol} has backing confidence ${byEvidence[0].backing_confidence} with ${byEvidence[0].evidence_count} evidence items vs ${byEvidence.slice(1).map((r) => `${r.symbol} (${r.backing_confidence}, ${r.evidence_count})`).join(", ")}. Stronger here means better-documented, not safer.` });
    }
    const withLiq = rows.filter((r) => hasNum(r.liquidity));
    if (withLiq.length > 1) {
      const byLiq = [...withLiq].sort((a, b) => Number(b.liquidity) - Number(a.liquidity));
      if (Number(byLiq[0].liquidity) === Number(byLiq[1].liquidity)) {
        leaders.push({ category: "liquidity", leader: null, reason: `Tie — top liquidities identical (${byLiq[0].liquidity}). No leader.` });
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
        leaders.push({ category: "holder_dispersion", leader: sorted10[0].symbol, reason: `${sorted10[0].symbol} is least concentrated by top-10 (${sorted10[0].top10HoldPercent}%). Top-3 slice unavailable — leader from top-10 only.` });
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
  const addrMap: Record<string, { symbols: string[]; maxPercent: number }> = {};
  for (const r of rows) {
    for (const h of ((r.top_holders as AnyObj[] | undefined) ?? [])) {
      const a = String(h.address ?? "");
      if (!a) continue;
      const cur = addrMap[a] ?? { symbols: [], maxPercent: 0 };
      if (!cur.symbols.includes(r.symbol)) cur.symbols.push(r.symbol);
      cur.maxPercent = Math.max(cur.maxPercent, Number(h.percent) || 0);
      addrMap[a] = cur;
    }
  }
  const shared_holders = Object.entries(addrMap)
    .filter(([, v]) => v.symbols.length > 1)
    .map(([address, v]) => ({ address, tokens: v.symbols, max_percent: Number(v.maxPercent.toFixed(2)), note: "Recurs as a top holder across tokens — pattern consistent with issuer/venue wallets. Identity NOT verified; do not treat as fact." }))
    .sort((a, b) => b.tokens.length - a.tokens.length || b.max_percent - a.max_percent);
  const out: AnyObj = {
    compared: rows.map((r) => r.symbol), rows, leaders, shared_holders, lang,
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
