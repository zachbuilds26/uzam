// Uzam honesty tests — every case asserts a "never invents" guarantee.
// Run: npm test (tsx + node:test, no new dependencies).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fmtMoney,
  fmtNum,
  pct,
  hasNum,
  toNum,
  tradeRatios,
  okxCoverage,
  summarizeCandles,
  summarizeTrades,
  summarizePools,
  detectNamedCustodian,
  cutWords,
  buildRisks,
  summarizeCompare,
  buildIdentity,
  buildPriceImpact,
  buildComparisonTable,
  buildFindings,
  buildRisksDetailed,
} from "../src/research/engines.js";
import { extractPassages, BACKING_KEYWORDS } from "../src/research/provider.js";
import { normalizeLang, t, sev, langFallbackNote, SUPPORTED_LANGS } from "../src/research/i18n.js";
import { planResearch, planFlags, ALL_EVIDENCE } from "../src/research/planner.js";

describe("null-safety: gaps stay null, never become 0", () => {
  it("fmtMoney(null) is null, not 0.00", () => {
    assert.equal(fmtMoney(null), null);
    assert.equal(fmtMoney(""), null);
    assert.equal(fmtMoney("abc"), null);
    assert.equal(fmtMoney("12.5"), "12.50");
  });
  it("pct(null) is n/a", () => {
    assert.equal(pct(null), "n/a");
    assert.equal(pct(72.9823), "72.98%");
  });
  it("hasNum rejects blanks and booleans", () => {
    assert.equal(hasNum(null), false);
    assert.equal(hasNum(""), false);
    assert.equal(hasNum(true), false);
    assert.equal(hasNum("0"), true);
    assert.equal(hasNum(0), true);
  });
  it("tradeRatios never divides by zero", () => {
    const r = tradeRatios("100", "0", "1000", "5");
    assert.equal(r.turnover_24h, null);
    assert.equal(r.avg_trade_size, "20.00");
    const empty = tradeRatios(null, null, null, null);
    assert.deepEqual(empty, { turnover_24h: null, liquidity_to_mcap: null, avg_trade_size: null });
  });
  it("fmtNum groups thousands, keeps nulls", () => {
    assert.equal(fmtNum("1788502.8506"), "1,788,502.85");
    assert.equal(fmtNum(null), null);
  });
  it("cutWords never cuts mid-word", () => {
    assert.equal(cutWords("short", 200), "short");
    const cut = cutWords("word ".repeat(100), 200);
    assert.ok(cut.length <= 201);
    assert.ok(!cut.endsWith("wor"));
  });
});

describe("okxCoverage: one counter, every path", () => {
  it("full success is 7/7", () => {
    assert.deepEqual(okxCoverage([]), { ok: 7, total: 7 });
  });
  it("absent list proves nothing (0/7, never 7/7)", () => {
    assert.deepEqual(okxCoverage(undefined), { ok: 0, total: 7 });
    assert.deepEqual(okxCoverage(null), { ok: 0, total: 7 });
  });
  it("no credentials / no contract is 0/7, including suffixed variants", () => {
    assert.deepEqual(okxCoverage(["okx_credentials"]), { ok: 0, total: 7 });
    assert.deepEqual(okxCoverage(["token_search: boom", "contract_on_xlayer"]), { ok: 0, total: 7 });
    assert.deepEqual(okxCoverage(["contract_on_xlayer: search returned a non-EVM address; refusing"]), { ok: 0, total: 7 });
    assert.deepEqual(okxCoverage(["skipped_by_focus"]), { ok: 0, total: 7 });
  });
  it("partial failure counts only real endpoints", () => {
    // token_search/tokenlist are resolution steps, not counted endpoints
    assert.deepEqual(okxCoverage(["price: no data", "token_search: x"]), { ok: 6, total: 7 });
  });
});

describe("candle/trade/pool parsers: garbage in, null out", () => {
  it("summarizeCandles handles array rows and rejects junk", () => {
    const h = summarizeCandles([
      [1, "100", "110", "90", "105", "1", "2", true],
      [2, "105", "115", "95", "110", "1", "2", true],
    ]);
    assert.equal(h?.high, "115.00");
    assert.equal(h?.low, "90.00");
    assert.equal(summarizeCandles([]), null);
    assert.equal(summarizeCandles([{ nope: 1 }]), null);
  });
  it("summarizeTrades counts sides, caps latest at 5", () => {
    const f = summarizeTrades([
      { side: "buy", amount: "1.5", price: "100" },
      { side: "SELL", amount: "2", price: "101" },
      { direction: "up" },
    ]);
    assert.equal(f?.buys, 1);
    assert.equal(f?.sells, 1);
    assert.equal(f?.sampled, 3);
    assert.equal(summarizeTrades([]), null);
  });
  it("summarizePools labels numbered pools, totals honestly", () => {
    const p = summarizePools([{ liquidity: "100" }, { liquidity: "50", protocol: "Pancake" }]);
    assert.equal(p?.pools[0].label, "Pool 1");
    assert.ok(p?.pools[1].label.startsWith("Pancake Pool 2"));
    assert.equal(p?.total_liquidity_usd, "150.00");
    assert.equal(summarizePools([]), null);
  });
});

describe("evidence filters: marketing never becomes evidence", () => {
  it("extractPassages drops nav blobs but keeps real claims", () => {
    const text =
      "Access xStocks Integrate xStocks the largest network with 1:1 backed tokens. " +
      "Each xStock is backed 1:1 by the underlying equity held with regulated custodians in segregated accounts. " +
      "More Wallets hold xStocks backed by custody arrangements today.";
    const hits = extractPassages(text, BACKING_KEYWORDS);
    assert.ok(hits.some((h) => h.includes("segregated accounts")));
    assert.ok(!hits.some((h) => h.startsWith("Access")));
    assert.ok(!hits.some((h) => h.startsWith("More Wallets")));
  });
  it("extractPassages drops testimonials, emails and nav salad", () => {
    const text =
      '" Jane Doe COO, Jupiter " TradFi and redemption are merging fast and now. ' +
      "Contact us at team@example.com for custody and redemption questions daily. " +
      "Trading Kraken Kraken Pro NinjaTrader Breakout VIP API Trading Services Payward Services backed 1:1 today ok.";
    const hits = extractPassages(text, BACKING_KEYWORDS);
    assert.equal(hits.length, 0);
  });
});


describe("i18n: fallback never breaks, quotes never translated", () => {
  it("unknown codes fall back to English", () => {
    assert.equal(normalizeLang("german"), "en");
    assert.equal(normalizeLang(""), "en");
    assert.equal(normalizeLang("ZH"), "zh");
    assert.equal(normalizeLang("es-MX"), "es");
  });
  it("every pack covers the critical keys (no raw keys leak)", () => {
    const keys = [
      "sec_backing", "sec_risks", "sec_method", "sec_activity", "sec_exit",
      "lbl_holders", "sev_high", "rpt_paid", "ev_original", "id_unknown", "leaders_none",
    ];
    for (const lang of SUPPORTED_LANGS) {
      for (const k of keys) assert.notEqual(t(lang, k), k, `${lang}:${k}`);
    }
  });
  it("severity translates, grades stay codes", () => {
    assert.equal(sev("zh", "high"), "高");
    assert.equal(sev("es", "unknown"), "desconocido");
  });
});

describe("buildRisks: missing data fails toward caution, never safety", () => {
  const onchainFull = {
    holder_concentration: { top10HoldPercent: "30" },
    trading_activity: { liquidity_raw: "1000000", liquidity: "1000000.00" },
    missing: [],
  };
  const backingMed = { confidence: "MEDIUM", unanswered_questions: ["q"], redemption_excerpts: ["redeem freely"], pages_read: ["u"], geo_excerpts: ["US excluded"] };
  it("weak backing reads high risk, strong reads low", () => {
    const byConf = (c) => buildRisks(onchainFull, { ...backingMed, confidence: c }).find((r) => r.category === "backing").severity;
    assert.equal(byConf("UNKNOWN"), "high");
    assert.equal(byConf("LOW"), "high");
    assert.equal(byConf("MEDIUM"), "moderate");
    assert.equal(byConf("HIGH"), "low");
  });
  it("redemption without data is unknown, never low", () => {
    const r = buildRisks(onchainFull, {}).find((x) => x.category === "redemption");
    assert.equal(r.severity, "unknown");
  });
  it("information follows endpoint coverage", () => {
    const sevFor = (missing) => buildRisks({ ...onchainFull, missing }, backingMed).find((x) => x.category === "information").severity;
    assert.equal(sevFor([]), "low");
    assert.equal(sevFor(["price: x", "holders: x"]), "moderate");
    assert.equal(sevFor(["okx_credentials"]), "high");
  });
  it("toNum never returns 0 for blanks", () => {
    assert.equal(toNum(""), null);
    assert.equal(toNum(null), null);
    assert.equal(toNum("0"), 0);
  });
});

describe("summarizeCompare: honest tables and notices", () => {
  it("nulls render n/a without fake suffixes", () => {
    const s = summarizeCompare({
      lang: "en",
      compared: ["A", "B"],
      rows: [
        { symbol: "A", price: "1", premium_discount_bps: 5, holders: 10, top10HoldPercent: null, liquidity: "100", backing_confidence: "MEDIUM", overall_confidence: "MEDIUM" },
        { symbol: "B", price: "2", premium_discount_bps: 6, holders: 20, top10HoldPercent: "40", liquidity: "200", backing_confidence: "MEDIUM", overall_confidence: "MEDIUM" },
      ],
      leaders: [],
      not_found: [],
    });
    assert.ok(s.includes("| n/a |"), "null top-10 must be bare n/a");
    assert.ok(!s.includes("n/a%"), "no n/a% fabrication");
  });
  it("all-not-found names the failures", () => {
    const s = summarizeCompare({ rows: [], not_found: ["ZZZ"], supported_symbols: ["AAPLx"] });
    assert.ok(s.includes("ZZZ") && s.includes("AAPLx"));
  });
});

describe("langFallbackNote: unsupported languages are announced", () => {
  it("notes fallback, stays silent otherwise", () => {
    assert.ok((langFallbackNote("german", "en") ?? "").includes("german"));
    assert.equal(langFallbackNote("zh", "zh"), null);
    assert.equal(langFallbackNote(undefined, "en"), null);
    assert.equal(langFallbackNote("", "en"), null);
  });
});

describe("identify: verification checks, unknowns, no market data", () => {
  it("returns 5 explicit checks with verified flags", async () => {
    const id = await buildIdentity("AAPLx", { lang: "en" });
    assert.equal(id.service, "identify");
    assert.equal(id.found, true);
    assert.equal(id.verification_checks.length, 5);
    for (const c of id.verification_checks) {
      assert.equal(typeof c.verified, "boolean");
      assert.ok(c.detail.length > 0);
    }
    assert.ok(id.verification_checks.every((c) => c.verified), "registry AAPLx verifies all 5");
  });
  it("never guesses standard/decimals/rights; decimals resolve or stay unknown consistently", async () => {
    const id = await buildIdentity("AAPLx", { lang: "en" });
    assert.equal(id.identity.token_standard, null);
    assert.ok(id.unknown.some((u) => /standard/i.test(u)));
    assert.equal(id.legal_structure.direct_shareholder_rights, null);
    assert.ok(id.unknown.some((u) => /shareholder/i.test(u)));
    const d = id.identity.decimals;
    if (d === null) {
      assert.ok(id.unknown.some((u) => /decimals/i.test(u)), "unresolved decimals must be listed unknown");
      assert.equal(id.identity.decimals_source, null);
    } else {
      assert.ok(Number.isInteger(d) && d >= 0, "resolved decimals must be a real integer, never invented");
      assert.equal(id.identity.decimals_source, "xStocks token list (Backed)");
      assert.ok(!id.unknown.some((u) => /decimals/i.test(u)), "resolved decimals must clear the unknown line");
    }
    assert.ok(!("live" in id) && !("trading_activity" in id), "no market data in identify");
  });
  it("not-found names supported symbols", async () => {
    const id = await buildIdentity("ZZZ", { lang: "en" });
    assert.equal(id.found, false);
    assert.ok(id.supported_symbols.includes("AAPLx"));
  });
});

describe("price impact: calculations labeled, gaps stay unknown", () => {
  it("estimates $100/$1k/$10k per venue with method stated", () => {
    const pi = buildPriceImpact({ pools: [{ label: "P1", liquidity_usd: "50000.00" }] });
    assert.equal(pi.venues[0].estimates.usd_100, "0.20%");
    assert.equal(pi.venues[0].estimates.usd_10000, "16.67%");
    assert.ok(pi.assumption.includes("CALCULATION"));
  });
  it("no liquidity means no estimate, never zero", () => {
    const pi = buildPriceImpact(null);
    assert.deepEqual(pi.venues, []);
    assert.ok(/unknown/i.test(pi.note));
  });
});

describe("dossier: 10 risks, 3-7 findings, side-by-side cells", () => {
  const base = buildRisks(
    { holder_concentration: { top10HoldPercent: "30" }, trading_activity: { liquidity_raw: "1000000" }, missing: [] },
    { confidence: "MEDIUM", unanswered_questions: [], redemption_excerpts: ["x"], pages_read: ["u"], geo_excerpts: ["g"] }
  );
  const det = () => buildRisksDetailed({
    base, underlyingCode: "AAPL", exchange: "NASDAQ", underlyingPrice: "200.00",
    premiumBps: 50, marketStatus: "open", liquidityRaw: 1000000, venueCount: 2,
    custodianNamed: false, geoCount: 1, tokenDecimals: null, spotSource: "y",
    okxOk: 7, okxTotal: 7, redemptionExcerpts: 1,
  });
  it("covers all 10 categories with 5 fields each", () => {
    const cats = det().map((r) => r.category);
    for (const want of ["underlying_equity", "tracking_pricing", "liquidity", "issuer_counterparty", "custody", "legal_regulatory", "smart_contract", "blockchain_network", "oracle_data", "operational"]) {
      assert.ok(cats.includes(want), `missing ${want}`);
    }
    for (const r of det()) {
      assert.ok(r.risk.length > 0 && r.current_observation.length > 0 && r.what_it_means.length > 0 && r.unknown_limitation.length > 0);
    }
  });
  it("findings are 3-7 factual lines with evidence refs", () => {
    const f = buildFindings({
      symbol: "AAPLx", name: "Apple xStock", checksVerified: 5, checksTotal: 5,
      tokenPrice: "200.00", underlyingPrice: "199.00", premiumBps: 50, marketStatus: "open", refTs: "t",
      top10: 30, top5: 20, holders: 100, liquidityRaw: 1000000, venueCount: 2,
      backingConfidence: "MEDIUM", custodianNamed: false, contradictions: 0, firstContradiction: null,
      unknowns: ["u1"], evidenceCount: 5,
    });
    assert.ok(f.length >= 3 && f.length <= 7);
    assert.ok(f.every((x) => x.finding.length > 0 && x.evidence_ref.length > 0));
    assert.ok(!f.some((x) => /safe|good investment|recommend/i.test(x.finding)));
  });
  it("comparison table cells carry value, timestamp and source", () => {
    const table = buildComparisonTable([{
      asset: { symbol: "AAPLx", name: "Apple xStock", asset_type: "tokenized_stock" },
      issuer: { name: "xStocks", documents: ["a", "b"] },
      identity: { identity: { contract_address: "0xabc", underlying_asset: "AAPL" }, legal_structure: {} },
      backing_detail: { attestation_links: [], custodian: null },
      onchain_analysis: { supply: { circulating: "10" }, holders_count: 5, top10_percent: 30, top5_percent: 20, transfer_count_24h: 3, tokenlist_check: { listed: true } },
      liquidity_detail: { venue_count: 1, price_impact: { venues: [{ estimates: { usd_10000: "1.00%" } }] } },
      economics: { price: "200", liquidity: "50000", volume24H: "1000" },
      price_relationship: { reference_price: "199", difference_bps: 50 },
      confidence: { backing: "MEDIUM" },
      unknowns: ["u1", "u2"],
      data_timestamp: "2026-01-01T00:00:00.000Z",
    }]);
    const cats = new Set(table.map((r) => r.category));
    for (const want of ["identity", "legal", "backing", "onchain", "liquidity", "price", "documentation", "unknown"]) {
      assert.ok(cats.has(want), `missing ${want}`);
    }
    for (const row of table) {
      const v = row.values.AAPLx;
      assert.ok("value" in v && "timestamp" in v && "source" in v);
      assert.equal(v.timestamp, "2026-01-01T00:00:00.000Z");
    }
  });
  it("new i18n keys exist in every pack", () => {
    for (const lang of SUPPORTED_LANGS) {
      for (const k of ["sec_snapshot", "sec_plan", "sec_findings", "sec_sources", "lbl_claim", "lbl_verified_fact", "lbl_onchain_obs", "lbl_calc", "id_verified"]) {
        assert.notEqual(t(lang, k), k, `${lang}:${k}`);
      }
    }
  });
});

describe("planner: question determines depth, skips carry reasons", () => {
  it("issuer question routes to identity depth without market fetches", () => {
    const p = planResearch("Who is the issuer?");
    assert.equal(p.depth, "identity");
    assert.ok(p.evidence_needed.includes("issuer_docs"));
    assert.ok(!p.evidence_needed.includes("market"));
    const f = planFlags(p);
    assert.equal(f.needOnchain, false);
    assert.equal(f.needDocs, true);
    assert.equal(f.needNews, false);
  });
  it("risk question pulls the full matrix", () => {
    const p = planResearch("Research the risks of this tokenized stock");
    assert.equal(p.depth, "full");
    assert.deepEqual([...p.evidence_needed].sort(), [...ALL_EVIDENCE].sort());
    assert.deepEqual(p.skipped, []);
  });
  it("price question needs market+reference, skips filings/news with reasons", () => {
    const p = planResearch("What is the premium vs the underlying price?");
    assert.equal(p.depth, "targeted");
    assert.ok(p.evidence_needed.includes("market") && p.evidence_needed.includes("reference"));
    assert.ok(!p.evidence_needed.includes("filings") && !p.evidence_needed.includes("news"));
    assert.ok(p.skipped.every((s) => s.reason.length > 0));
    const f = planFlags(p);
    assert.equal(f.needSpot, true);
    assert.equal(f.needFilings, false);
  });
  it("empty and unknown questions default to full dossier, never less", () => {
    for (const q of ["", "   ", "asdfgh qwerty zzz", undefined, null]) {
      const p = planResearch(q);
      assert.equal(p.depth, "full");
      assert.deepEqual(p.skipped, []);
    }
  });
  it("null plan means all gathers on (backwards compatible)", () => {
    const f = planFlags(null);
    assert.ok(f.needOnchain && f.needDocs && f.needSpot && f.needFilings && f.needDividend && f.needNews);
  });
  it("skipped_by_plan counts as zero coverage, never full", () => {
    assert.deepEqual(okxCoverage(["skipped_by_plan"]), { ok: 0, total: 7 });
    assert.deepEqual(okxCoverage(["skipped_by_plan: onchain not needed"]), { ok: 0, total: 7 });
  });
});
