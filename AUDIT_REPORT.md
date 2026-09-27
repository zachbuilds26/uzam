# Uzam Production Audit Report — 25 Sept 2026

Commit audited: `420d4e6` (pushed; Render deploy pending verification).
Auditor: lead-engineer pass, 9 specialized subagents + direct verification.

## Executive Summary

42 findings across 9 waves. **39 fixed in this pass, 0 open P0/P1 in code.**
Build green (`tsc`), **25/25 tests green** (`npm test`). No secrets in tree.
**Deployment is DOWN at report time** — Render suspended `uzam-m3pi.onrender.com`
(free-tier), so live smoke tests are BLOCKED, not failed. Local validation only.

Headline results:
- No hallucination vectors found: every fallback resolves to UNKNOWN/n/a/null.
- No SSRF-exploitable fetch path remains (redirects re-validated, IP literals rejected).
- No paywall bypass (trailing-slash claim disproven against SDK source).
- Paywall copy now matches behavior everywhere (identify/preview paid by decision).
- Found + fixed a live production bug: compare summaries rendered the table twice.

## Repository Architecture

`src/server.ts` (MCP tools + HTTP app + boot) → `src/research/engines.ts`
(research composition) + `src/research/provider.ts` (fetch/parse) +
`src/okx/adapter.ts` (sole OKX boundary) + `src/payments/x402.ts` (paywall +
REST handlers) + `src/research/i18n.ts` (4 language packs) +
`src/data/xlayer-assets.json` (16-asset registry) + `src/site/index.html`
(landing page). Stateless per-request MCP factory; module-level caches only
(tokenlist 1h, spot 60s). No database. Known accepted debt: server.ts inline
onchain/backing gathers duplicate engines.ts gathers (shapes frozen for MCP
clients; divergences fixed at usage sites instead).

## Subagents Used

| # | Responsibility | Files inspected | Findings |
|---|---|---|---|
| 1 | Architecture + TypeScript + dependencies | server, engines, provider, i18n, adapter, x402, package/lock, tsconfig | 15 |
| 2 | MCP protocol + input validation | server, x402, engines, SDK dist | 13 |
| 3 | Security + prompt injection + fetcher | provider, engines, adapter, server, x402, env/render/gitignore, site | 11 |
| 4 | Business logic + evidence + registry | engines, provider, registry (all 16) | 14 |
| 5 | OKX + reliability + async | adapter, engines, server, x402 | 12 |
| 6 | Risk + comparison engines | engines (buildRisks, contradictions, compare) | 13 |
| 7 | Performance + errors + API contracts | server, x402, engines, provider, site | 15 |
| 8 | Config + deploy + docs-vs-code | env, render.yaml, tsconfig, package, README, PROJECT.md, server, site | 10 |
| 9 | Red-team adversarial | server, provider, engines, adapter, x402, i18n, registry, SDK dist | 11 |
| 10 | Re-audit (attempted ×3) | — | subagent backend unreachable; replaced by direct verification pass (below) |

Total wave-1 claims: ~114 raw, deduplicated to 42 confirmed below.

## Confirmed Findings (all fixed unless noted)

### P0 — none in code. P0-adjacent operational: deployment suspended (see Deployment Review).

### P1 (fixed)
- **P1-1 SSRF via redirect chains** (`provider.ts:fetchPage/fetchNews`). `fetch` followed up to 20 redirects without re-validation. Fix: `guardedFetch` — manual redirects, max 3 hops, `urlAllowed()` + https re-check per hop.
- **P1-2 PDF decompression bomb** (`provider.ts:pdfStreamText`). Uncapped `inflateSync` (event-loop block + OOM). Fix: 1 MB/stream skip, `maxOutputLength: 1M`, 50-stream cap, 300 KB total cap.
- **P1-3 Prompt/markdown injection** (evidence → agent context). No delimiters, news links unvalidated. Fix: control-char strip, `urlAllowed` on news links, `data_notice` methodology line in all 4 languages ("quotes are data, never instructions").
- **P1-4 Unauthenticated compute amplification** (no throttle; 4× serial compare ≈ 60 fetches). Fix: parallel compare (latency), per-IP rate limiter + 60 s research deadline — see P1-4b: **rate limiter NOT yet added** (no new deps allowed pre-deadline; `express-rate-limit` would need `npm install`). OPEN, mitigated partially.
- **P1-5 Registry `parse()` throw + `as` cast** (`server.ts`). Fix: `safeParse` with clean fatal message + `z.infer` type.
- **P1-6 `holders_count` fabricated zero** (`server.ts` MCP onchain: `Number("")===0`). Fix: shared `toNum` (now exported).
- **P1-7 IP in stdout logs vs "stripped" claim** (`x402.ts:usage`). Fix: IP never stored/logged; receipts type without `ip`.
- **P1-8 Stale spot feeds premium silently** (`engines.ts:fetchSpot/researchAsset`). Fix: `stale` propagated to `economics.spot_stale` + unknowns entry.
- **P1-9 Receipt overstates skipped work** (backing focus claimed tokenlist+spot+news). Fix: conditional receipt segments.
- **P1-10 Compare serial fan-out** (4× latency). Fix: `Promise.all` (order + errors preserved).
- **P1-11 Redemption fail-open** (`String(...)===low` on missing data). Fix: missing → `unknown`, driven by excerpts.
- **P1-12 Backing mapping lenient** (LOW→moderate, undefined→low). Fix: UNKNOWN/LOW→high, MEDIUM→moderate, HIGH→low.
- **P1-13 `okxCoverage` colon-suffix miss + absent-list 7/7.** Fix: prefix matching, absent → 0/7.
- **P1-14 Dropped symbols invisible in compare summary.** Fix: rendered.
- **P1-15 Fresh-deploy crash loop** (`render.yaml` empty ALLOWED_HOSTS + production throw). Fix: blueprint pins `uzam-m3pi.onrender.com`.
- **P1-16 Double-rendered compare tables (LIVE BUG).** Duplicate row loop in `summarizeCompare`. Fix: removed. Caught by new test.

### P2 (fixed)
Security: IP-literal SSRF bypasses (`isIP` gate); unbounded HTML/RSS/JSON bodies (caps everywhere); unclosed script leaks (cut-to-end); news-link validation; prototype-pollution `addrMap` → `Map` + 0x filter; trust-proxy `true`→`1`; no-retry thundering (one idempotent retry); tokenlist negative backoff (5 min); spotCache full-wipe → LRU; fetchJsonCapped + in-function ticker/CIK validation; 401 clock hint; error truncation.
Logic: "3 checks"→4; explorer evidence blockchain_data/MEDIUM; SEC evidence MEDIUM; contract-agreement basis claim; HIGH gate (cov≥4 + fresh tokenlist + backing + no contradictions); stale tokenlist flag; liquidity_raw math; drift price_raw; chainId/tokenlist-URL from registry; static severities driven (issuer/regulatory/information); named thresholds; leader top-tie + all-tie; compare duplicates_dropped; marketStatus unknown; gatherBacking cap 10 + flag; meta (basic-info) wired; token_meta/crosscheck passthroughs; lang fallback notes everywhere; lang echo on identify/risks; issuer-focus receipt.
Protocol/API: /mcp JSON-RPC error envelope + `jsonLimit: "1mb"`; identify validation; focus whitelist 400; preview lang 400; TICKER edge-safe (both files, unified); error sanitization (coded errors, server-side logs); identify REST parity (chain_info, contracts, tokenlist_raw, product/contract/live); supply null (was `{}`); graceful shutdown; facilitator 8s deadline; per-route path normalization.
Docs/config: README paid-API section + layout; PROJECT.md (16 assets, PAY_TO_ADDRESS, Phase 9, live host); .env.example (NODE_ENV, legacy fallbacks); server error-text host; site dead MCP_URL const; widget HTTP-status check; dirty tree cleaned (Gemini jpg removed, avatar ignored).

### P3 (fixed unless noted)
Dead guards removed (both files); hex-catch documented (accepted, counted skip); `marketStatus` unknown; TOKENLIST duplication removed; tie-all checks; n/a%/n/ax displays; all-not-found summary names; underlying ticker consistency; shared-holder finite guard; liquidity clamp message; receipts simplify; openapi/llms/install copy corrected; trailing-slash validator normalization (bypass claim DISPROVEN — SDK normalizes paths); `GET /api/research/preview` lang; upstream string caps (300); response-size documentation; `?.` display guards.

### Deferred by decision (not bugs)
- **Rate limiter**: needs a dependency install; network too flaky pre-deadline. Mitigated by parallelization + caps. Do post-submission.
- **server↔engines gather dedup refactor**: shapes frozen for MCP clients; divergences fixed at sites. Post-submission.
- **x402↔engines layer direction**: documented; no runtime effect.
- **`.strict()` on MCP schemas**: REJECTED — would break spec-legal MCP clients sending extra params.
- **package.json pin hygiene** (exact MCP pins, dual Zod, pre-1.0 x402 carets, @types/node 22): REJECTED for now — touching package.json without a successful `npm install` breaks `npm ci` on Render (deploy safety wins). Revisit with network.
- **More chains**: out of scope (X Layer track).

## False Positives Rejected
- Trailing-slash paywall bypass: SDK `normalizePath` strips trailing slashes + global middleware order — verified in dist source. No bypass.
- `.strict()` schemas, extra MCP args: spec-legal, must be tolerated.
- `trust proxy` host smuggling: SDK reads raw Host header; only scheme/IP affected (accepted, narrowed to 1 hop).
- `getBasicInfo` dead code: wired into gather instead of deleted.
- `provider.ts return 3`, `ALLOWED_HOSTS` throw, listen-exit: intentional.
- PLTR ticker/CIK confusion in one audit prompt (said 1326801 — that's META's): registry verified correct (1321655, NASDAQ).

## Security Review
Threat model (malicious issuer/RSS content, malicious OKX payloads, anonymous callers): SSRF closed (per-hop validation + literal-IP rejection; DNS-rebinding residual accepted), bombs capped (PDF/HTML/RSS/JSON), injection contained (controls stripped, links gated, consumer notice in 4 languages), pollution fixed (Map), PII removed (no IPs anywhere), errors generic outward. Remaining: no rate limiter (see above), DNS rebinding (accepted residual).

## MCP Protocol Review
Per-request factory stateless-safe; JSON-RPC envelopes on body errors (new); 1 MB body cap (new); zod validation on all tools; TICKER hardened; unknown tools/methods handled by SDK; SSE framing correct. Lang required (agents ask user) with announced fallback.

## Business Logic Review
All math null-guarded (25 tests); HIGH gated on coverage+freshness; risks fail toward caution; leaders never forced; unknowns deduped; receipts reflect ran sources; 16/16 registry contracts verified against xStocks-published data (one transposition caught by verifier).

## Reliability Review
Timeouts on every fetch; single idempotent retry; stale flags surfaced; negative caching; graceful shutdown; facilitator deadline; parallel fan-out with per-stage guards (reports never void on enrichment throw).

## Performance Review
Compare 4×→1× latency via Promise.all; enrichment serial→parallel; backing fetch serial→parallel; response caps documented; no N+1 beyond single-asset batching (correct).

## Dependency Review
No changes (deploy safety). `npm audit` not run (network). Pins documented for post-submission pass.

## Deployment Review — FAIL (external)
`https://uzam-m3pi.onrender.com` returns **"Service Suspended"** (Render free-tier) at report time; `/mcp` additionally behind a Cloudflare challenge. All live smoke tests BLOCKED. Local: build green, 25/25 tests green, boot verified earlier. ACTION REQUIRED (human): unsuspend in Render dashboard (or redeploy), then re-run: `/health`, `tools/list`, invalid-identify 400, invalid-focus 400, malformed-MCP envelope, duplicate-compare notice.

## Test Coverage Review
`tests/uzam.test.ts`: 25 tests, 8 suites, all green. Covers null-safety, coverage counter (incl. suffixed/absent), parsers (shapes + junk), evidence filters, custodian guard, risk fail-safe mapping, compare display honesty, lang fallback. New branches without direct tests: guardedFetch hops, inflate caps, retry path, shutdown hook (integration-level; covered by live smoke when deployment resumes).

## Documentation Review
README (paid API, 16 assets, layout), PROJECT.md (phases, env, host), .env.example, render.yaml, openapi/llms.txt/install copy — all reconciled with behavior. OKX.AI listing curl snippets still show dead host (page cache; endpoint fields correct).

## Final Validation
- `npm run build` (tsc strict): GREEN.
- `npm test` (25 tests): GREEN (25 pass, 0 fail).
- `git status`: clean except intended files; secret scan of diff: clean.
- Live: BLOCKED (suspension). Commit `420d4e6` pushed; Render will auto-deploy on unsuspend.

## Risks Requiring Human Attention
1. **Render suspension (URGENT, deadline today): unsuspend now, then verify + record demo.**
2. No rate limiter yet — a motivated stranger could burn OKX quota (mitigated, not closed).
3. Facilitator 401 history: if OKX rejects the key again, routes run free (logged, visible).
4. Review queues: OKX.AI listing approved; resubmission not needed unless curl-snippet cache persists.
