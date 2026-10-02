# Uzam research study — what strong research agents do, and what Uzam should adapt

Date: 2026-10-02. Status: research only — no code copied, no repos forked, no trading added.
Scope: Uzam stays an autonomous RWA / tokenized-equity RESEARCH agent. No execution, no wallet trading.

## Studied (shallow read-only clones)

1. `Schadenfreunde/fin-research-agent` (note the 'n' — the link without it 404s): pipeline discipline.
2. `Agentic-Analyst/stock-analyst`: trustworthiness (reproducibility, citation checks, fail-closed).
3. `ashbix23/Stock-Analyst-Agent`: minimal agent loop (floor, not model).
4. `assafelovic/gpt-researcher`: autonomy mechanics (planning, decomposition, tool selection, provenance).
5. `TauricResearch/TradingAgents` (research parts only): disagreement mechanics. Trader/execution ignored.

## Uzam baseline at study time

Deterministic gather layer (on-chain, backing docs, spot, filings, dividends, news) in parallel
with per-source failure capture; claim/verified/observed/unknown split; tiered evidence with quotes;
4 contradiction checks; mandatory unknowns; source register; calculation labeling; 3 differentiated
products (identify check, evidence dossier, compare table); 34 honesty tests.

## Distilled principles (synthesis, not copied content)

- fin-research-agent: pre-gather structured data in code before reasoning; analysts own fixed sections
  and run parallel; gap-filling pass with strict tool budget; compiler adds no analysis; fact-check +
  review loop with capped retries; coverage gate; strong models verify, cheap models gather;
  tools return error-as-data.
- stock-analyst: reproducibility manifest (hash prompts+deps+config+model per run); citation-support
  validation (every citation must support its sentence); fail-closed filtering (uncertain items excluded
  with logged reason); deterministic compute separated from narration; security decisions as
  test-enforced versioned exceptions.
- simple agent: explicit completion gate (report only once required evidence set is satisfied).
  Warnings: requires every tool always; zero citations/verification.
- gpt-researcher: plan from initial results (decompose grounded in what exists); tool selection is an
  explicit capped decision; visited-URL dedup across passes; snippets are never sources until fetched;
  source curation before synthesis; cost tracking; sub-researchers merged upward.
- TradingAgents: fixed tool rounds then forced wrap-up naming unretrieved data; bull/bear debate rounds;
  adjudicator commits to stronger case with explicit rules (conflict alone is not abstention; abstain
  only when balanced-or-thin); full debate history carried in state.

## Gaps found in Uzam

1. No planner/depth-router — focus is a manual switch; within a focus everything runs.
2. No verification or second pass on the finished product (no citation-support check, no consistency pass).
3. Single-shot retrieval — no gap-driven second pass, no "I need more info" loop.
4. Report does not show its own plan (what was asked, needed, deliberately skipped and why).
5. Snippet-vs-page provenance is practice but not a stated tested invariant.
6. Contradiction detection without recorded adjudication rules.

## Adaptations (approved direction)

1. Rule-based research planner + depth routing (no LLM in common case).
2. Plan-in-report with skip reasons.
3. Deterministic citation-support + label-consistency checks.
4. Capped gap-driven second retrieval pass with forced wrap-up.
5. Snippet-vs-page invariant + test.
6. Contradiction adjudication rules recorded in-report.
7. Run manifest in receipt (code + registry + template versions).
8. Fail-closed filter logging.
9. Security: instruction-laundering stance for future prose synthesis; registry-URL similarity check;
   metadata display-only invariant; stale flags for cached content; dependency VEX file + test.
10. Multi-agent verdict: NO specialist agents — single pipeline with specialist lenses (already the case).

## Non-goals (reaffirmed)

No execution, no wallet trading, no buy/sell, no PnL optimization, no recommendation-implying
valuation models, no copying of any repo's code, prompts, UI, or architecture.
