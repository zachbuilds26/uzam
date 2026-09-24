// WebResearchProvider — Uzam's eyes for reading official pages.
// MVP rule: fetch ONLY known official URLs (from the registry), extract the
// text, and pull out passages matching finance keywords. No search API key
// needed, no vector database. Whatever the page says becomes quoted evidence —
// Uzam never invents backing details.
// PDFs (prospectuses, Final Terms, attestations) are parsed with a tiny
// built-in extractor (node:zlib inflate + text-object scan) — no native deps,
// Render-safe. Scanned/image-only PDFs yield no text and are reported honestly.

import { inflateSync } from "node:zlib";

export type FetchedDoc = {
  url: string;
  ok: boolean;
  status: number;
  title: string | null;
  text: string | null;
  truncated?: boolean;
  error?: string;
};

// Defense in depth: Uzam only ever fetches registry/news URLs, but enforce it
// here too — https only, no loopback/private/link-local targets.
function urlAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h === "[::1]" || h === "::1") return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;|&#160;|&#x[Aa]0;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ""; }
    })
    .replace(/&#[Xx]([0-9A-Fa-f]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
    })
    .replace(/&(rsquo|rdquo|ldquo|middot|copy|ndash|mdash);/g, (m) => (
      { "&rsquo;": "'", "&rdquo;": '"', "&ldquo;": '"', "&middot;": "·", "&copy;": "©", "&ndash;": "–", "&mdash;": "—" } as Record<string, string>
    )[m] ?? m);
}

function stripHtml(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim().slice(0, 200) : null;
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text).replace(/\s+/g, " ").trim();
  return { title, text };
}

export async function fetchPage(url: string, timeoutMs = 15000, maxChars = 20000): Promise<FetchedDoc> {
  if (!urlAllowed(url)) return { url, ok: false, status: 0, title: null, text: null, error: "URL blocked (https + public hosts only)" };
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "uzam-mvp/0.1 (+research)" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { url, ok: false, status: 0, title: null, text: null, error: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) return { url, ok: false, status: res.status, title: null, text: null, error: `HTTP ${res.status}` };
  const contentType = res.headers.get("content-type") ?? "";
  const isPdf = contentType.includes("application/pdf") || /\.pdf(\?|#|$)/i.test(url);
  if (isPdf) return fetchPdf(url, res, maxChars);
  if (!contentType.includes("text/html") && !contentType.includes("text/")) {
    return { url, ok: false, status: res.status, title: null, text: null, error: `unsupported content-type: ${contentType}` };
  }
  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 2_000_000) {
    return { url, ok: false, status: res.status, title: null, text: null, error: `page too large (${contentLength} bytes)` };
  }
  let html: string;
  try {
    html = await res.text();
  } catch (e) {
    return { url, ok: false, status: res.status, title: null, text: null, error: `page body unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const { title, text } = stripHtml(html);
  if (text.length <= maxChars) return { url, ok: true, status: res.status, title, text, truncated: false };
  const cut = text.lastIndexOf(". ", maxChars);
  return { url, ok: true, status: res.status, title, text: text.slice(0, cut > maxChars * 0.5 ? cut + 1 : maxChars), truncated: true };
}

// ---- PDF text extraction (zero dependencies) ----
// Most prospectuses are text-based PDFs with FlateDecode streams.
// We inflate each stream and scan for PDF text objects: (literal) and <hex>.
// Image-only (scanned) PDFs yield nothing — reported honestly, never faked.
function pdfStreamText(raw: Buffer): string {
  const parts: string[] = [];
  const push = (s: string): void => {
    const clean = s.replace(/\s+/g, " ").trim();
    if (clean.length > 2) parts.push(clean);
  };
  const scanText = (chunk: string): void => {
    // Literal strings: ( ... ) with \( \) \\ escapes. Skip font-encoding junk.
    for (const m of chunk.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
      const inner = m[0].slice(1, -1)
        .replace(/\\([nrtbf()\\])/g, (_, c: string) => ({ n: "\n", r: " ", t: " ", b: " ", f: " ", "(": "(", ")": ")", "\\": "\\" }[c] ?? " "))
        .replace(/\\[0-7]{1,3}/g, " ");
      if (/[a-zA-Z0-9]{3,}/.test(inner)) push(decodeEntities(inner));
    }
    // Hex strings: <48656c6c6f> — only plausible text runs (has spaces 0x20).
    for (const m of chunk.matchAll(/<([0-9A-Fa-f\s]{8,400})>/g)) {
      const hex = m[1].replace(/\s+/g, "");
      if (hex.length % 2 !== 0 || !/20/.test(hex)) continue;
      try {
        const buf = Buffer.from(hex, "hex");
        if (buf.includes(0)) continue; // likely UTF-16 without BOM handling — skip
        const s = buf.toString("latin1");
        if (/[a-zA-Z0-9]{3,}/.test(s) && /^[\x20-\x7E\s]+$/.test(s)) push(s);
      } catch { /* ignore malformed hex */ }
    }
  };
  const bin = raw.toString("latin1");
  const streams = [...bin.matchAll(/stream\r?\n([\s\S]*?)endstream/g)];
  if (streams.length === 0) {
    scanText(bin);
  } else {
    for (const s of streams) {
      const bytes = Buffer.from(s[1], "latin1");
      try {
        scanText(inflateSync(bytes).toString("latin1"));
      } catch {
        scanText(s[1]); // uncompressed stream — scan raw
      }
      if (parts.join(" ").length > 60000) break;
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

async function fetchPdf(url: string, res: Response, maxChars: number): Promise<FetchedDoc> {
  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 8_000_000) {
    return { url, ok: false, status: res.status, title: null, text: null, error: `PDF too large (${contentLength} bytes)` };
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { url, ok: false, status: res.status, title: null, text: null, error: `PDF body unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (buf.length > 8_000_000) {
    return { url, ok: false, status: res.status, title: null, text: null, error: `PDF too large (${buf.length} bytes)` };
  }
  if (buf.subarray(0, 5).toString() !== "%PDF-") {
    return { url, ok: false, status: res.status, title: null, text: null, error: "not a PDF file" };
  }
  const text = pdfStreamText(buf);
  if (text.length < 200) {
    return { url, ok: false, status: res.status, title: "PDF", text: null, error: "PDF has no extractable text (likely scanned images)" };
  }
  const title = url.split("/").pop()?.replace(/[-_+.]+/g, " ").slice(0, 200) ?? "PDF document";
  if (text.length <= maxChars) return { url, ok: true, status: res.status, title, text, truncated: false };
  const cut = text.lastIndexOf(". ", maxChars);
  return { url, ok: true, status: res.status, title, text: text.slice(0, cut > maxChars * 0.5 ? cut + 1 : maxChars), truncated: true };
}

// Keep sentences containing any keyword (substring match, case-insensitive).
// Returns up to maxPassages short excerpts — these become quoted evidence.
export function extractPassages(text: string, keywords: string[], maxPassages = 6): string[] {
  const lower = keywords.map((k) => k.toLowerCase());
  const sentences = text.split(/(?<=[.!?])\s+/);
  const hits: string[] = [];
  for (const s of sentences) {
    const clean = s.trim();
    if (clean.length < 25 || clean.length > 600) continue;
    const l = clean.toLowerCase();
    if (lower.some((k) => l.includes(k))) {
      if (!hits.includes(clean)) hits.push(clean);
      if (hits.length >= maxPassages) break;
    }
  }
  return hits;
}
export const BACKING_KEYWORDS = [
  "backed",
  "backing",
  "backs",
  "collateral",
  "custod",
  "reserve",
  "redeem",
  "redemption",
  "1:1",
  "segregat",
  "bankrupt",
  "attest",
  "audit",
];

export const REDEMPTION_KEYWORDS = ["redeem", "redemption", "withdraw", "sell", "cash value", "eligible", "KYC", "fee"];

// ---- Source hierarchy: Tier 1 preferred, Tier 3 last resort ----
// Tier 3 (blogs / aggregators / social) has no producer in this codebase yet —
// the unreachable `return 3` below is intentional for when one is added.
export type SourceType =
  | "official_issuer"
  | "official_documentation"
  | "legal_document"
  | "reserve_report"
  | "blockchain_data"
  | "market_data"
  | "reputable_news"
  | "third_party";

export function tierOf(sourceType: SourceType): 1 | 2 | 3 {
  if (
    sourceType === "official_issuer" ||
    sourceType === "official_documentation" ||
    sourceType === "legal_document" ||
    sourceType === "reserve_report" ||
    sourceType === "blockchain_data"
  ) return 1;
  if (sourceType === "market_data" || sourceType === "reputable_news" || sourceType === "third_party") return 2;
  return 3;
}

// Per-item confidence from source tier (PDF section 17):
// issuer-only claim without independent backing -> MEDIUM at best.
export function itemConfidence(sourceType: SourceType): "HIGH" | "MEDIUM" | "LOW" {
  if (sourceType === "blockchain_data") return "HIGH";
  if (sourceType === "official_issuer" || sourceType === "official_documentation" || sourceType === "legal_document" || sourceType === "reserve_report") return "MEDIUM";
  return "LOW";
}

// ---- Recent developments via Google News RSS (no API key needed) ----
export type NewsItem = {
  title: string;
  url: string;
  source: string | null;
  published_at: string | null;
};

export async function fetchNews(query: string, maxItems = 5, timeoutMs = 15000): Promise<{ items: NewsItem[]; error?: string }> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  if (!urlAllowed(url)) return { items: [], error: "news URL blocked" };
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "uzam-mvp/0.1 (+research)", "Accept": "application/rss+xml" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { items: [], error: `news fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) return { items: [], error: `news HTTP ${res.status}` };
  let xml: string;
  try {
    xml = await res.text();
  } catch (e) {
    return { items: [], error: `news body unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!/<rss|<feed/i.test(xml)) return { items: [], error: "news response is not a feed" };
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
    const body = m[1];
    if (!body) continue;
    const pick = (tag: string, cap: number): string | null => {
      const r = body.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i"));
      if (!r || !r[1]) return null;
      return decodeEntities(r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim().slice(0, cap) || null;
    };
    const title = pick("title", 300);
    const link = pick("link", 2000);
    if (!title || !link) continue;
    items.push({ title, url: link, source: pick("source", 120), published_at: pick("pubDate", 120) });
    if (items.length >= maxItems) break;
  }
  if (items.length === 0) return { items, error: "no news items parsed" };
  return { items };
}
