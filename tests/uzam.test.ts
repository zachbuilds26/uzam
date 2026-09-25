// Uzam honesty tests — every case asserts a "never invents" guarantee.
// Run: npm test (tsx + node:test, no new dependencies).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fmtMoney,
  fmtNum,
  pct,
  hasNum,
  tradeRatios,
  okxCoverage,
  summarizeCandles,
  summarizeTrades,
  summarizePools,
  detectNamedCustodian,
  cutWords,
} from "../src/research/engines.js";
import { extractPassages, BACKING_KEYWORDS } from "../src/research/provider.js";
import { normalizeLang, t, sev, SUPPORTED_LANGS } from "../src/research/i18n.js";

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
  it("no credentials / no contract is 0/7, never inflated", () => {
    assert.deepEqual(okxCoverage(["okx_credentials"]), { ok: 0, total: 7 });
    assert.deepEqual(okxCoverage(["token_search: boom", "contract_on_xlayer"]), { ok: 0, total: 7 });
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

describe("detectNamedCustodian: no generic-word custodians", () => {
  it("rejects 'them' style generics, accepts real names", () => {
    assert.equal(detectNamedCustodian(["custody by them is standard practice here"]), null);
    assert.equal(
      detectNamedCustodian(["assets are held in custody by First National Trust Company for clients"]),
      "First National Trust Company for clients"
    );
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
