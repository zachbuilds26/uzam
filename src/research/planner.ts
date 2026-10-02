// Research planner — depth routing for research_asset (roadmap item 1).
// Rule-based first: question keywords map to the evidence the question needs,
// everything else is skipped WITH a recorded reason (shown in-report).
// An explicit focus always wins over the plan; unknown/empty questions fall
// back to the full dossier (today's behavior — never less evidence by default).
// The planner never fetches and never guesses: it only selects gather flags.

export type EvidenceKind =
  | "identity" | "issuer_docs" | "backing" | "redemption"
  | "onchain" | "holders" | "liquidity" | "market"
  | "reference" | "filings" | "dividend" | "news";

export const ALL_EVIDENCE: EvidenceKind[] = [
  "identity", "issuer_docs", "backing", "redemption",
  "onchain", "holders", "liquidity", "market",
  "reference", "filings", "dividend", "news",
];

export type Depth = "identity" | "targeted" | "full";

export type Skipped = { evidence: EvidenceKind; reason: string };

export type ResearchPlan = {
  question: string;
  matched_topics: string[];
  evidence_needed: EvidenceKind[];
  skipped: Skipped[];
  depth: Depth;
  note: string;
};

// Topic rules: keyword groups → evidence. Order matters only for reporting;
// every matching topic contributes its evidence (union, never intersection).
const TOPICS: { topic: string; keys: string[]; evidence: EvidenceKind[] }[] = [
  { topic: "issuer", keys: ["issuer", "who issues", "issued by", "legal entity", "jurisdiction", "registered", "license", "backed by whom", "backed finance"], evidence: ["identity", "issuer_docs"] },
  { topic: "backing", keys: ["back", "collateral", "custod", "reserve", "attest", "segregat", "proof of"], evidence: ["identity", "issuer_docs", "backing"] },
  { topic: "redemption", keys: ["redeem", "redemption", "withdraw", "exit", "sell back", "minimum", "kyc", "eligible", "who can"], evidence: ["identity", "issuer_docs", "backing", "redemption"] },
  { topic: "price", keys: ["price", "premium", "discount", "deviat", "track", "peg", "worth", "cost"], evidence: ["identity", "onchain", "market", "reference"] },
  { topic: "holders", keys: ["holder", "concentration", "whale", "distribution", "supply", "top 10", "top10", "top 5", "top5"], evidence: ["identity", "onchain", "holders"] },
  { topic: "liquidity", keys: ["liquid", "volume", "pool", "slippage", "impact", "trade", "trading", "turnover", "market cap", "marketcap"], evidence: ["identity", "onchain", "liquidity", "market"] },
  { topic: "contract", keys: ["contract", "address", "chain", "network", "explorer", "standard", "decimals", "erc"], evidence: ["identity"] },
  // "underlying" fires inside price questions ("underlying price"), so this
  // topic stays market-side; filings need an explicit filings/dividend ask.
  { topic: "underlying", keys: ["underlying", "company", "business", "stock ", "equity", "apple", "nvidia", "tesla", "etf", "index"], evidence: ["identity", "market", "reference"] },
  { topic: "filings", keys: ["filing", "10-k", "10k", "10-q", "10q", "annual report", "edgar", "insider"], evidence: ["identity", "filings"] },
  { topic: "dividend", keys: ["dividend", "payout", "distribution", "yield"], evidence: ["identity", "filings", "dividend"] },
  { topic: "news", keys: ["news", "event", "recent", "latest", "develop", "announce", "earnings", "lawsuit"], evidence: ["identity", "news"] },
  { topic: "risks", keys: ["risk", "risks", "risky", "danger", "downside", "red flag", "concern", "worried", "should i worry"], evidence: [...ALL_EVIDENCE] },
];

const SKIP_REASON = "Not needed for this question — excluded by the research plan to avoid unnecessary calls.";

function normalizeQuestion(q: unknown): string {
  if (typeof q !== "string") return "";
  return q.trim().replace(/\s+/g, " ").slice(0, 500);
}

/** Build the evidence plan for a free-text question. Pure + deterministic. */
export function planResearch(question: unknown): ResearchPlan {
  const clean = normalizeQuestion(question);
  if (!clean) {
    return {
      question: clean, matched_topics: [],
      evidence_needed: [...ALL_EVIDENCE], skipped: [],
      depth: "full",
      note: "No question provided — full dossier (every source consulted).",
    };
  }
  const lowered = ` ${clean.toLowerCase()} `;
  const matched = TOPICS.filter((t) => t.keys.some((k) => lowered.includes(k)));
  if (matched.length === 0) {
    return {
      question: clean, matched_topics: [],
      evidence_needed: [...ALL_EVIDENCE], skipped: [],
      depth: "full",
      note: "No known topics detected — full dossier rather than risk missing evidence.",
    };
  }
  const needed = [...new Set(matched.flatMap((t) => t.evidence))];
  const full = matched.some((t) => t.topic === "risks");
  const identityOnly =
    needed.every((e) => e === "identity" || e === "issuer_docs") && needed.includes("identity");
  const depth: Depth = full ? "full" : identityOnly ? "identity" : "targeted";
  const skipped: Skipped[] = ALL_EVIDENCE.filter((e) => !needed.includes(e)).map((evidence) => ({
    evidence, reason: SKIP_REASON,
  }));
  return {
    question: clean,
    matched_topics: matched.map((t) => t.topic),
    evidence_needed: needed,
    skipped,
    depth,
    note: full
      ? "Risk question — full evidence matrix (identity, backing, market, holders, liquidity, docs, events)."
      : `Targeted research on: ${matched.map((t) => t.topic).join(", ")}.`,
  };
}

/** Gather flags derived from a plan. Backing/docs fetch only when needed. */
export function planFlags(plan: ResearchPlan | null): {
  needOnchain: boolean; needDocs: boolean; needSpot: boolean;
  needFilings: boolean; needDividend: boolean; needNews: boolean;
} {
  if (!plan) {
    return { needOnchain: true, needDocs: true, needSpot: true, needFilings: true, needDividend: true, needNews: true };
  }
  const has = (...kinds: EvidenceKind[]): boolean => kinds.some((k) => plan.evidence_needed.includes(k));
  const needFilings = has("filings", "dividend");
  return {
    needOnchain: has("onchain", "holders", "liquidity", "market"),
    needDocs: has("issuer_docs", "backing", "redemption"),
    needSpot: has("reference", "market"),
    needFilings,
    needDividend: has("dividend") && needFilings,
    needNews: has("news"),
  };
}
