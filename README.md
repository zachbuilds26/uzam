# Uzam — RWA Intelligence MCP for AI Agents

- **Deployment:** Railway, connected to the `master` branch with auto deploy enabled.

Uzam gives AI agents the ability to investigate tokenized assets on **X Layer**
using onchain data, official documents, issuer information and evidence-backed
research. The product is the MCP server: an agent connects over Streamable HTTP
and calls research tools. Uzam gathers and cites — the agent reasons.

- **Live MCP:** `https://uzam-production-95f9.up.railway.app/mcp`
- **Health:** `https://uzam-production-95f9.up.railway.app/health`
- **Hackathon:** OKX Dev Day 2026 — primary track OKX AI (Agents), secondary X Layer RWA
- **Assets:** xStocks tokenized equities on X Layer (chain 196): AAPLx, TSLAx, NVDAx, SPYx, GOOGLx, MSFTx, AMZNx, METAx, NFLXx, AMDx, COINx, HOODx, AVGOx, JPMx, Vx, PLTRx

## Paid REST API (x402, USDT0 on X Layer)

| Route | Price | What it does |
|---|---|---|
| `POST /api/identify` | $0.08 | 60-second identity check: identity, verification checks, official sources, unknowns. No market data. |
| `GET /api/research/preview?symbol=AAPLx` | $0.08 | Identity only, zero fetches. |
| `POST /api/research` | $0.25 | Evidence dossier: snapshot, findings, backing (claim vs verified vs on-chain vs unknown), liquidity + calculated impact, 10 risks, source register (focus: full/issuer/backing/risks, lang: en/zh/es/fr). |
| `POST /api/compare` | $0.50 | Side-by-side table for up to 4 assets, every cell with value + timestamp + source. Never a winner. |

Unpaid calls get `402 Payment Required`. Without `PAY_TO_ADDRESS` + OKX creds the routes run free (never half-enforced). Discovery: `GET /.well-known/x402`, `GET /openapi.json`, `GET /llms.txt`, `GET /install`, `GET /api/receipts`, `GET /info`., NFLXx, AMDx, COINx, HOODx, AVGOx, JPMx, Vx, PLTRx

## Tools

| Tool | What it does |
|---|---|
| `identify_asset` | 60-second identity check: identity, verification checks, official sources, unknowns. No market data. Use before deeper research. |
| `analyze_onchain` | Contract resolution + price, supply, holders, concentration, volume, liquidity via OKX Onchain OS. Partial + `missing[]` when unavailable. |
| `analyze_backing` | Reads issuer pages live, quotes backing passages with Tier-1 evidence, separates CLAIM from FACT. |
| `research_asset` | Evidence dossier: snapshot, findings, backing split, on-chain, liquidity + calculated impact, 10 risks, source register. Optional `focus`: `full` / `issuer` / `backing` / `risks`. |
| `compare_assets` | Side-by-side table for 1–4 assets, every cell with value + timestamp + source. Observations only, never a winner. |

## Research philosophy

Question → Plan → Gather → Cross-check → Analyze → Cite → Conclude.
Every claim carries evidence (`source_type`, tier, excerpt, confidence).
Tiers: 1 = issuer docs / legal / blockchain, 2 = market data / news.
Uzam states what is UNKNOWN instead of guessing, and never calls an asset "safe".

## Try it

```bash
curl -X POST https://uzam-production-95f9.up.railway.app/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Local dev

```bash
npm install
cp .env.example .env   # fill OKX_ACCESS_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE (plus OKX_PROJECT_ID if shown, ALLOWED_HOSTS on Railway)
npm run dev            # or: npm run build && npm start
```

`GET /health` for liveness, `POST /mcp` for the MCP endpoint.
Set `ALLOWED_HOSTS` to your public hostname when deploying (Railway: service Variables).

## Layout

- `src/server.ts` — MCP tools + HTTP app + landing page route
- `src/site/index.html` — landing page (try-widget, pricing, setup, guardrails)
- `src/payments/x402.ts` — paid REST routes + x402 paywall + discovery files
- `src/okx/adapter.ts` — all OKX-specific code lives here only
- `src/research/provider.ts` — page fetch, passage extraction, source tiers, news RSS
- `src/research/engines.ts` — backing/onchain gathers, risk engine, contradictions, compare
- `src/data/xlayer-assets.json` — X Layer asset registry (no hardcoded contracts)
- `PROJECT.md` — full build plan
