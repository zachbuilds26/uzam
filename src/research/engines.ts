// Research engines — composition layer for research_asset + compare_assets.
// The single-asset tools in server.ts stay as they are; this module composes
// the same primitives (registry, OKX adapter, page fetcher) into full reports.
// Future refactor: make server.ts tools thin wrappers around these gathers.

import registryJson from "../data/xlayer-assets.json" with { type: "json" };
import { OKXOnchainAdapter, loadOkxConfig, XLAYER_CHAIN_INDEX } from "../okx/adapter.js";
import {
  fetchPage, extractPassages, BACKING_KEYWORDS, fetchNews,
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

export async function verifyTokenlist(contract: string): Promise<{ listed: boolean; matched_symbol: string | null; error?: string }> {
  try {
    if (!tlCache || Date.now() - tlCache.at > 3600_000) {
      const res = await fetch(TOKENLIST_RAW, {
        headers: { "User-Agent": "uzam-mvp/0.1 (+research)" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) return { listed: false, matched_symbol: null, error: `tokenlist HTTP ${res.status}` };
      const json = (await res.json()) as AnyObj;
      tlCache = { at: Date.now(), tokens: Array.isArray(json.tokens) ? json.tokens : [] };
    }
    const hit = tlCache.tokens.find(
      (t) => Number(t.chainId) === 196 && String(t.address ?? "").toLowerCase() === contract.toLowerCase()
    );
    return { listed: !!hit, matched_symbol: hit ? String(hit.symbol ?? "") : null };
  } catch (e) {
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
    hit = onX.find((t) => String(t.tokenSymbol ?? "").toUpperCase() === clean) ?? onX[0] ?? null;
    if (hit?.tokenContractAddress) contract = String(hit.tokenContractAddress);
  } else {
    missing.push(`token_search: ${search.error ?? "unknown error"}`);
  }
  if (!contract) {
    missing.push("contract_on_xlayer");
    return {
      found: true, symbol: asset.symbol, name: asset.name,
      chains: asset.chains, chainIds: asset.chainIds, contracts: [],
      onchain: null, missing, confidence: "LOW", data_timestamp: dataTimestamp,
    };
  }
  const item = { chainIndex: XLAYER_CHAIN_INDEX, tokenContractAddress: contract.toLowerCase() };
  let price: AnyObj | null = null;
  let info: AnyObj | null = null;
  let advanced: AnyObj | null = null;
  let holders: AnyObj[] = [];
  const priceRes = await okx.getPrice([item]);
  if (priceRes.ok && Array.isArray(priceRes.data) && priceRes.data[0]) price = priceRes.data[0];
  else missing.push(`price: ${priceRes.error ?? "no data"}`);
  const infoRes = await okx.getPriceInfo([item]);
  if (infoRes.ok && Array.isArray(infoRes.data) && infoRes.data[0]) info = infoRes.data[0];
  else missing.push(`price_info: ${infoRes.error ?? "no data (Premium tier?)"}`);
  const advRes = await okx.getAdvancedInfo(XLAYER_CHAIN_INDEX, contract);
  if (advRes.ok && advRes.data) advanced = advRes.data as AnyObj;
  else missing.push(`advanced_info: ${advRes.error ?? "no data (Premium tier?)"}`);
  const holdRes = await okx.getHolders(XLAYER_CHAIN_INDEX, contract, "20");
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
  if (advanced?.top10HoldPercent) observations.push(`Top 10 holders control ${advanced.top10HoldPercent}% of supply (OKX advanced-info).`);
  if (top.length > 0) observations.push(`Largest holder: ${top[0].address.slice(0, 10)}… at ${top[0].percent}%. Top 3 combined: ${top3.toFixed(2)}%.`);
  if (advanced?.stockProfile) observations.push(`OKX reports underlying stock profile: ${advanced.stockProfile.companyName ?? ""} (${advanced.stockProfile.stockCode ?? ""}, ${advanced.stockProfile.exchange ?? ""}). Exchange data, not issuer verification.`);
  if (missing.length > 0) observations.push(`Partial data: ${missing.length} source(s) unavailable. See missing[].`);
  if (tokenlist_check.listed) observations.push(`Independent tokenlist confirms this contract as ${tokenlist_check.matched_symbol} on X Layer — agrees with OKX.`);
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
      topHolders: top,
    },
    trading_activity: {
      price: price?.price ?? info?.price ?? hit?.price ?? null,
      priceChange24H: info?.priceChange24H ?? hit?.change ?? null,
      volume24H: info?.volume24H ?? null,
      txs24H: info?.txs24H ?? null,
      liquidity: info?.liquidity ?? hit?.liquidity ?? null,
      marketCap: info?.marketCap ?? hit?.marketCap ?? null,
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
    (u, i, arr) => u.startsWith("http") && arr.indexOf(u) === i
  );
  const evidence: AnyObj[] = [];
  const fetched: string[] = [];
  const failed: string[] = [];
  for (const url of urls.slice(0, 4)) {
    const doc = await fetchPage(url);
    if (doc.ok && doc.text) {
      fetched.push(url);
      const st: SourceType = "official_issuer";
      for (const p of extractPassages(doc.text, BACKING_KEYWORDS)) {
        evidence.push({
          claim: "Issuer describes backing/custody/redemption on its official site.",
          source_title: doc.title, source_url: url, excerpt: p, basis: "claim",
          source_type: st, tier: tierOf(st), confidence: itemConfidence(st), retrieved_at: now(),
        });
      }
    } else {
      failed.push(`${url} (${doc.error ?? `HTTP ${doc.status}`})`);
    }
  }
  const unanswered: string[] = [];
  if (!evidence.some((e) => /custod/i.test(String(e.excerpt)))) unanswered.push("No custodian named on the fetched official pages.");
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
    custodian: evidence.some((e) => /custod/i.test(String(e.excerpt))) ? "Named in evidence excerpts." : "UNKNOWN — not stated on fetched pages.",
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
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const top10 = num(onchain?.holder_concentration?.top10HoldPercent);
  const liq = num(onchain?.trading_activity?.liquidity);
  const missing: string[] = Array.isArray(onchain?.missing) ? onchain.missing : [];
  const risks: Risk[] = [
    {
      category: "concentration",
      severity: top10 === null ? "unknown" : top10 > 80 ? "high" : top10 > 50 ? "moderate" : "low",
      reason: top10 === null ? "No holder distribution data available." : `Top 10 holders control ${top10}% of supply.`,
      evidence: ["okx:advanced-info:top10HoldPercent"],
    },
    {
      category: "liquidity",
      severity: liq === null ? "unknown" : liq < 50000 ? "high" : liq < 500000 ? "moderate" : "low",
      reason: liq === null ? "No liquidity figure available." : `Observed pool liquidity ${liq} (OKX). Thin books can mean large price impact.`,
      evidence: ["okx:price-info:liquidity"],
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
  const unknowns: string[] = [
    ...(Array.isArray(backing.unanswered_questions) ? backing.unanswered_questions : []),
    ...(Array.isArray(onchain.missing) && onchain.missing.length > 0 ? [`Onchain gaps: ${onchain.missing.join("; ")}`] : []),
  ];
  const evidence: AnyObj[] = [
    ...(Array.isArray(backing.evidence) ? backing.evidence.slice(0, 10) : []),
    ...(onchain.explorer ? [{ claim: "Onchain record for this contract.", source_title: "OKX X Layer explorer", source_url: onchain.explorer, excerpt: `Contract ${Array.isArray(onchain.contracts) ? onchain.contracts[0] : ""} on X Layer (chain 196).`,     basis: "fact", source_type: "blockchain_data" as SourceType, tier: 1, confidence: "HIGH", retrieved_at: now() }] : []),
    ...(Array.isArray(onchain.extra_evidence) ? onchain.extra_evidence : []),
  ];
  const econ = onchain.trading_activity ?? {};
  const tier1Count = evidence.filter((e) => e.tier === 1).length;
  const overall =
    onchain.onchain === null ? "LOW"
    : onchain.confidence === "HIGH" && backing.confidence !== "UNKNOWN" && tier1Count >= 3 ? "HIGH"
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
      confidence: backing.confidence,
    },
    economics: { price: econ.price ?? null, marketCap: econ.marketCap ?? null, liquidity: econ.liquidity ?? null, supply: onchain.supply ?? {} },
    onchain: {
      chains: onchain.chains, contracts: onchain.contracts ?? [], holders_count: onchain.holders_count ?? null,
      holder_concentration: onchain.holder_concentration ?? {}, trading_activity: econ,
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
  if (focus === "risks") {
    return {
      found: true, focus, asset: report.asset,
      risks: report.risks, unknowns: report.unknowns, confidence: report.confidence,
      note: "Risks focus: full data gathered, only risk sections returned.",
      data_timestamp: report.data_timestamp,
    };
  }
  return report;
}

// ---- compare_assets: structured multi-asset comparison, evidence per row ----
const CONF_RANK: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

export async function compareAssets(symbols: string[]): Promise<AnyObj> {
  const list = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 4);
  if (list.length === 0) {
    return { compared: [], error: "Provide 1-4 symbols, e.g. [\"AAPLx\", \"TSLAx\"].", supported_symbols: supportedSymbols() };
  }
  const reports = await Promise.all(list.map((s) => researchAsset(s)));
  const found = reports.filter((r) => r.found === true);
  const notFound = reports.filter((r) => r.found !== true).map((r) => r.symbol);
  const rows = found.map((r) => ({
    symbol: r.asset.symbol, name: r.asset.name, issuer: r.issuer.name,
    underlying: r.underlying.exposure,
    price: r.economics.price, marketCap: r.economics.marketCap, liquidity: r.economics.liquidity,
    holders: r.onchain.holders_count,
    top10HoldPercent: r.onchain.holder_concentration?.top10HoldPercent ?? null,
    backing_confidence: r.confidence.backing, onchain_confidence: r.confidence.onchain,
    overall_confidence: r.confidence.overall,
    open_risks: (r.risks as Risk[]).filter((x) => x.severity === "high" || x.severity === "moderate").map((x) => `${x.category} (${x.severity}): ${x.reason}`),
    unknowns_count: (r.unknowns as string[]).length, evidence_count: (r.evidence as AnyObj[]).length,
  }));
  const leaders: AnyObj[] = [];
  if (rows.length > 1) {
    const byEvidence = [...rows].sort((a, b) => (CONF_RANK[String(b.backing_confidence)] - CONF_RANK[String(a.backing_confidence)]) || (b.evidence_count - a.evidence_count));
    leaders.push({ category: "backing_evidence", leader: byEvidence[0].symbol, reason: `${byEvidence[0].symbol} has backing confidence ${byEvidence[0].backing_confidence} with ${byEvidence[0].evidence_count} evidence items vs ${byEvidence.slice(1).map((r) => `${r.symbol} (${r.backing_confidence}, ${r.evidence_count})`).join(", ")}. Stronger here means better-documented, not safer.` });
    const withLiq = rows.filter((r) => Number.isFinite(Number(r.liquidity)));
    if (withLiq.length > 1) {
      const byLiq = [...withLiq].sort((a, b) => Number(b.liquidity) - Number(a.liquidity));
      leaders.push({ category: "liquidity", leader: byLiq[0].symbol, reason: `${byLiq[0].symbol} shows higher observed liquidity (${byLiq[0].liquidity}) than ${byLiq.slice(1).map((r) => `${r.symbol} (${r.liquidity})`).join(", ")}. Thinner books can mean larger price impact.` });
    }
    const withConc = rows.filter((r) => Number.isFinite(Number(r.top10HoldPercent)));
    if (withConc.length > 1) {
      const byConc = [...withConc].sort((a, b) => Number(a.top10HoldPercent) - Number(b.top10HoldPercent));
      leaders.push({ category: "holder_dispersion", leader: byConc[0].symbol, reason: `${byConc[0].symbol} is less concentrated (top 10: ${byConc[0].top10HoldPercent}%) than ${byConc.slice(1).map((r) => `${r.symbol} (${r.top10HoldPercent}%)`).join(", ")}.` });
    }
  }
  return {
    compared: rows.map((r) => r.symbol), rows, leaders,
    not_found: notFound, supported_symbols: supportedSymbols(),
    note: "Leaders are per-category and evidence-based. A leader in one category is not an overall recommendation.",
    data_timestamp: now(),
  };
}
