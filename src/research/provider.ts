// WebResearchProvider — Uzam's eyes for reading official pages.
// MVP rule: fetch ONLY known official URLs (from the registry), extract the
// text, and pull out passages matching finance keywords. No search API key
// needed, no vector database. Whatever the page says becomes quoted evidence —
// Uzam never invents backing details.

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
