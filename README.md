# Uzam — RWA Intelligence MCP for AI Agents

Uzam gives AI agents the ability to investigate tokenized assets on **X Layer**
using onchain data, official documents, issuer information and evidence-backed
research. The product is the MCP server: an agent connects over Streamable HTTP
and calls research tools. Uzam gathers and cites — the agent reasons.

- **Live MCP:** `https://uzam.onrender.com/mcp`
- **Health:** `https://uzam.onrender.com/health`
- **Hackathon:** OKX Dev Day 2026 — primary track OKX AI (Agents), secondary X Layer RWA
- **Assets:** xStocks tokenized equities on X Layer (chain 196): AAPLx, TSLAx, NVDAx, SPYx

## Tools

| Tool | What it does |
|---|---|
| `identify_asset` | Resolve symbol → name, issuer, underlying, chain, official docs. Never guesses. |
| `analyze_onchain` | Contract resolution + price, supply, holders, concentration, volume, liquidity via OKX Onchain OS. Partial + `missing[]` when unavailable. |
| `analyze_backing` | Reads issuer pages live, quotes backing passages with Tier-1 evidence, separates CLAIM from FACT. |
| `research_asset` | Full report: identity, backing, onchain, 9-category risks, news, contradictions, unknowns, confidence. Optional `focus`: `full` / `issuer` / `backing` / `risks`. |
| `compare_assets` | 2–4 asset table + per-category leaders with reasons. Never a bald verdict. |

## Research philosophy

Question → Plan → Gather → Cross-check → Analyze → Cite → Conclude.
Every claim carries evidence (`source_type`, tier, excerpt, confidence).
Tiers: 1 = issuer docs / legal / blockchain, 2 = market data / news.
Uzam states what is UNKNOWN instead of guessing, and never calls an asset "safe".

## Try it

```bash
curl -X POST https://uzam.onrender.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Local dev

```bash
npm install
cp .env.example .env   # fill OKX_ACCESS_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE
npm run dev            # or: npm run build && npm start
```

`GET /health` for liveness, `POST /mcp` for the MCP endpoint.
Set `ALLOWED_HOSTS` to your public hostname when deploying (see `render.yaml`).

## Layout

- `src/server.ts` — MCP tools + HTTP app
- `src/okx/adapter.ts` — all OKX-specific code lives here only
- `src/research/provider.ts` — page fetch, passage extraction, source tiers, news RSS
- `src/research/engines.ts` — backing/onchain gathers, risk engine, contradictions, compare
- `src/data/xlayer-assets.json` — X Layer asset registry (no hardcoded contracts)
- `PROJECT.md` — full build plan
