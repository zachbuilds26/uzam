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
import type { SourceType } from "./provider.js";

type RegistryAsset = {
  symbol: string;
  name: string;
  asset_type: string;
  issuer: string;
  underlying_asset: string;
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
export async function gatherRecent(asset: RegistryAsset): Promise<{ items: AnyObj[]; note: string }> {
  const company = asset.underlying_asset.split("(")[0].trim();
  const { items, error } = await fetchNews(`${asset.symbol} xStocks ${company}`.slice(0, 120));
  if (error) return { items: [], note: `News unavailable: ${error}.` };
  const st: SourceType = "reputable_news";
  return {
    items: items.map((n) => ({
      title: n.title, url: n.url, source: n.source, published_at: n.published_at,
      source_type: st, tier: tierOf(st), confidence: itemConfidence(st), retrieved_at: now(),
    })),
    note: "",
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

// Derived market ratios from fields OKX already returns — pure arithmetic.
export function tradeRatios(volume24H: unknown, liquidity: unknown, marketCap: unknown, txs24H: unknown): { turnover_24h: number | null; liquidity_to_mcap: number | null; avg_trade_size: string | null } {
  const vol = toNum(volume24H);
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
  const lines: string[] = [];
  lines.push(`## ${r.asset.symbol} — ${r.asset.name} (X Layer)`);
  lines.push(`**Confidence: ${r.confidence.overall}** (identity ${r.confidence.identity} · onchain ${r.confidence.onchain} · backing ${r.confidence.backing})`);
  const t = r.onchain.trading_activity ?? {};
  lines.push(`**Price:** ${t.price ?? "n/a"} · **Holders:** ${r.onchain.holders_count ?? "n/a"} · **Top 10:** ${pct(r.onchain.holder_concentration?.top10HoldPercent)} · **Liquidity:** ${t.liquidity ?? "n/a"}`);
  lines.push(`### Backing`);
  lines.push(`${r.backing.issuer_claim ?? "No backing statement."} (confidence ${r.backing.confidence})`);
  lines.push(`Custodian: ${r.backing.custodian ?? "UNKNOWN"}`);
  const risks = [...((r.risks as Risk[] | undefined) ?? [])].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]).slice(0, 3);
  lines.push(`### Top risks`);
  for (const x of risks) lines.push(`- **${x.category}** (${x.severity}): ${x.reason}`);
  const unknowns = ((r.unknowns as string[] | undefined) ?? []).slice(0, 4);
  lines.push(`### Unknowns`);
  for (const u of unknowns) lines.push(`- ${u}`);
  const recent = ((r.recent_developments as AnyObj[] | undefined) ?? []).slice(0, 3);
  lines.push(`### Recent developments`);
  if (recent.length === 0) lines.push(`- None found${r.recent_note ? ` (${r.recent_note})` : ""}.`);
  for (const n of recent) lines.push(`- ${n.title} (${n.source ?? "news"})`);
  const contra = r.contradictions as AnyObj[];
  lines.push(`### Contradictions`);
  if (contra.length === 0) lines.push(`- No contradictions in the 3 automated checks (underlying code, OKX price drift >10%, tokenlist symbol). Limited coverage — see unknowns.`);
  for (const c of contra) lines.push(`- CONFLICT: ${c.issue} See: ${c.recommended_action}`);
  return lines.join("\n");
}

export function summarizeCompare(c: AnyObj): string {
  if (!c.rows || c.rows.length === 0) return `**No assets compared.** ${c.error ?? ""}`;
  const lines: string[] = [];
  lines.push(`## Comparison: ${(c.compared as string[]).join(" vs ")}`);
  lines.push(`| Asset | Price | Holders | Top 10 | Liquidity | Backing | Overall |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const r of c.rows as AnyObj[]) {
    lines.push(`| ${r.symbol} | ${r.price ?? "n/a"} | ${r.holders ?? "n/a"} | ${r.top10HoldPercent ?? "n/a"}% | ${r.liquidity ?? "n/a"} | ${r.backing_confidence} | ${r.overall_confidence} |`);
  }
  lines.push(`### Leaders (per category, evidence-based — not overall recommendations)`);
  for (const l of (c.leaders as AnyObj[])) lines.push(`- **${l.category}: ${l.leader}** — ${l.reason}`);
  const nf = ((c.not_found as string[] | undefined) ?? []);
  if (nf.length > 0) lines.push(`Not found: ${nf.join(", ")}.`);
  return lines.join("\n");
}

// ---- research_asset: one-call full report ----
export async function researchAsset(symbol: string, focus: "full" | "issuer" | "backing" | "risks" = "full"): Promise<AnyObj> {
  const clean = symbol.trim().toUpperCase();
  const asset = findAsset(clean);
  if (!asset) {
    return {
      found: false, symbol: clean,
      uncertainty: "Asset not in Uzam X Layer MVP registry. Do not guess.",
      supported_symbols: supportedSymbols(), confidence: "UNKNOWN", data_timestamp: now(),
    };
  }
  if (focus === "issuer") {
    return {
      found: true, focus,
      asset: { symbol: asset.symbol, name: asset.name, asset_type: asset.asset_type },
      issuer: { name: asset.issuer, website: asset.official_website, documents: asset.official_documents },
      underlying: { exposure: asset.underlying_asset },
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
  const underlyingCode = asset.underlying_asset.split(/[\s(]/)[0].toUpperCase();
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
  const tlListed = onchain.tokenlist_check?.listed === true;
  const unknowns: string[] = [
    ...(Array.isArray(backing.unanswered_questions) ? backing.unanswered_questions.filter((q) => tlListed ? !/No independent.*verification/i.test(String(q)) : true) : []),
    ...(Array.isArray(onchain.missing) && onchain.missing.length > 0 ? [`Onchain gaps: ${onchain.missing.join("; ")}`] : []),
    ...(tokenPx > 0 && !codeOk ? [`Premium skipped: underlying code "${underlyingCode}" is not a plain ticker.`] : []),
  ];
  if (premiumBps !== null && mktStatus === "closed") unknowns.push(`Premium/discount (${premiumBps} bps) is measured against a stale reference — Nasdaq was closed at check time (${spot.date ?? ""} ${spot.time ?? ""}).`);
  if (spot.error && tokenPx > 0) unknowns.push(`Underlying spot unavailable: ${spot.error}. No premium computed.`);
  const evidence: AnyObj[] = [
    ...(Array.isArray(backing.evidence) ? backing.evidence.slice(0, 10) : []),
    ...(onchain.explorer ? [{ claim: "Onchain record for this contract.", source_title: "OKX X Layer explorer", source_url: onchain.explorer, excerpt: `Contract ${Array.isArray(onchain.contracts) ? onchain.contracts[0] : ""} on X Layer (chain 196).`,     basis: "fact", source_type: "market_data" as SourceType, tier: 2, confidence: "MEDIUM", retrieved_at: now() }] : []),
    ...(Array.isArray(onchain.extra_evidence) ? onchain.extra_evidence : []),
  ];
  // HIGH means: multiple OKX endpoints agree + docs present + independent
  // tokenlist confirms the contract + no contradictions. Issuer claims alone
  // can never produce HIGH, and neither can a single data source.
  const overall =
    onchain.onchain === null ? "LOW"
    : onchain.confidence === "HIGH" && backing.confidence !== "UNKNOWN" && tlListed && contradictions.length === 0 ? "HIGH"
    : backing.confidence === "UNKNOWN" && onchain.confidence === "LOW" ? "LOW"
    : "MEDIUM";
  const report: AnyObj = {
    found: true, focus,
    asset: { symbol: asset.symbol, name: asset.name, asset_type: asset.asset_type },
    issuer: { name: asset.issuer, website: asset.official_website, documents: asset.official_documents },
    underlying: { exposure: asset.underlying_asset },
    backing: {
      issuer_claim: backing.issuer_claim, custodian: backing.custodian,
      confidence: backing.confidence, pages_read: backing.pages_read,
    },
    redemption: {
      note: "Confirm who can redeem, minimums, fees and settlement time in the issuer's current terms.",
      excerpts: backing.redemption_excerpts ?? [],
      who_can_redeem: "UNKNOWN — not confirmed from fetched pages; see excerpts and issuer terms.",
      confidence: backing.confidence,
    },
    economics: {
      price: econ.price ?? null, marketCap: econ.marketCap ?? null, liquidity: econ.liquidity ?? null, supply: onchain.supply ?? {},
      turnover_24h: econ.turnover_24h ?? null, liquidity_to_mcap: econ.liquidity_to_mcap ?? null,
      underlying_price: spot.price !== null ? spot.price.toFixed(2) : null,
      underlying_source: spot.price !== null ? "Yahoo Finance quote (unverified third party)" : null,
      premium_discount_bps: premiumBps,
      underlying_market_status: spot.price !== null ? mktStatus : null,
      reference_price_timestamp: spot.date ? `${spot.date} ${spot.time ?? ""}`.trim() : null,
    },
    onchain: {
      chains: onchain.chains, contracts: onchain.contracts ?? [], holders_count: onchain.holders_count ?? null,
      holder_concentration: onchain.holder_concentration ?? {}, trading_activity: econ,
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

export async function compareAssets(symbols: string[]): Promise<AnyObj> {
  const requested = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const dropped = requested.slice(4);
  const list = requested.slice(0, 4);
  if (list.length === 0) {
    return { compared: [], error: "Provide 1-4 symbols, e.g. [\"AAPLx\", \"TSLAx\"].", supported_symbols: supportedSymbols() };
  }
  const reports: AnyObj[] = [];
  for (const s of list) {
    try {
      reports.push(await researchAsset(s));
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
    compared: rows.map((r) => r.symbol), rows, leaders, shared_holders,
    ...(dropped.length > 0 ? { dropped_symbols: dropped, dropped_note: `Only the first 4 were compared; ignored: ${dropped.join(", ")}.` } : {}),
    not_found: notFound, supported_symbols: supportedSymbols(),
    note: "Leaders are per-category and evidence-based. A leader in one category is not an overall recommendation.",
    data_timestamp: now(),
  };
  out.summary = summarizeCompare(out);
  return out;
}
