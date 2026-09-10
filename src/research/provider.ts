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
  error?: string;
};

function stripHtml(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 200) : null;
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { title, text };
}

export async function fetchPage(url: string, timeoutMs = 15000, maxChars = 20000): Promise<FetchedDoc> {
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
  const html = await res.text();
  const { title, text } = stripHtml(html);
  return { url, ok: true, status: res.status, title, text: text.slice(0, maxChars) };
}

// Keep sentences containing any keyword (substring match, case-insensitive).
// Returns up to maxPassages short excerpts — these become quoted evidence.
export function extractPassages(text: string, keywords: string[], maxPassages = 6): string[] {
  const lower = keywords.map((k) => k.toLowerCase());
  const sentences = text.split(/(?<=[.!?])\s+/);
  const hits: string[] = [];
  for (const s of sentences) {
    const clean = s.trim();
    if (clean.length < 40 || clean.length > 600) continue;
    const l = clean.toLowerCase();
    if (lower.some((k) => l.includes(k))) {
      if (!hits.includes(clean)) hits.push(clean);
      if (hits.length >= maxPassages) break;
    }
  }
  return hits;
}

export const BACKING_KEYWORDS = [  "back",
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

// ---- Source hierarchy (PDF section 12): Tier 1 preferred, Tier 3 last resort ----
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

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

export async function fetchNews(query: string, maxItems = 5): Promise<{ items: NewsItem[]; error?: string }> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "uzam-mvp/0.1 (+research)" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return { items: [], error: `news fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) return { items: [], error: `news HTTP ${res.status}` };
  const xml = await res.text();
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = m[1];
    const pick = (tag: string): string | null => {
      const r = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return r ? decodeEntities(r[1]).slice(0, 300) : null;
    };
    const title = pick("title");
    const link = pick("link");
    if (!title || !link) continue;
    items.push({ title, url: link, source: pick("source"), published_at: pick("pubDate") });
    if (items.length >= maxItems) break;
  }
  return { items };
}
