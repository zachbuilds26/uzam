# UZAM — RWA Intelligence MCP for AI Agents
**Folder:** `C:\Users\Emmanuel\uzam`
**Deploy target:** Render (Web Service, Node 24)
**Hackathon:** OKX Dev Day 2026 — Primary track: OKX AI (Agents), Secondary: X Layer RWA
**Application deadline:** 11 Sept 2026 23:59 UTC

## 1. What Uzam is (one paragraph for application)
Uzam is an RWA intelligence MCP that gives AI agents the ability to investigate tokenized assets on X Layer using onchain data, official documents, issuer information and evidence-backed research. An agent connects to Uzam via MCP and calls tools like `identify_asset`, `research_asset`, `analyze_backing`, `analyze_onchain`, `compare_assets` to research xStocks tokenized equities.

## 2. Where does the thinking happen? (super simple)
Forget the word "reasoning". Think restaurant:

- **You (user)** = customer. You ask: "Is AAPLx safe? What backs it?"
- **Claude / AI agent** = waiter + chef. It talks to you and makes the final answer.
- **Uzam MCP** = fridge. It just holds organized ingredients. It does NOT cook.

Flow:
1. You ask AI a question
2. AI opens Uzam fridge and takes out: official doc link + OKX price/holders + backing note
3. AI cooks those ingredients into a human answer

That is Option B: **Uzam gathers, AI thinks.**

Why? If Uzam tried to think in TypeScript code, you would have to code every rule: "if issuer says X but chain says Y, then...". That's hundreds of rules. Too hard for an 8-day build.

With Option B you only code: "fetch this, return JSON". The AI already knows how to compare and summarize. You build less, it breaks less.

Example:
- AI calls `identify_asset("AAPLx")` -> Uzam returns `{ name: "Apple xStock", chain: "X Layer 196", contract: "0x...", issuer: "xStocks / Backed" }`
- AI calls `analyze_onchain("AAPLx")` -> Uzam calls OKX and returns `{ price, holders, supply }`
- AI writes to user: "AAPLx is Apple stock backed 1:1, here are holders and risks..."

Uzam never writes the final sentence. It just gives clean facts + evidence links + unknowns.

## 3. X Layer pivot (important)
Do NOT use OUSG / BUIDL / USDY as MVP. They live mostly on Ethereum mainnet.

Use **xStocks on X Layer**:
- Chain: X Layer mainnet, Chain ID 196, EVM-compatible, OKB gas
- RPC: https://rpc.xlayer.tech
- OKX Onchain OS Market endpoints used by Uzam (chainIndex 196). Wallet/Trade APIs not used.
- xStocks: 1:1 backed tokenized US stocks/ETFs, issued via Backed Finance network, redeemable for cash value
- Count: ~690 tokens on X Layer per xStocks tokenlist (3512 total; count moves — re-check live)
- Test assets: AAPLx, TSLAx, NVDAx, SPYx, GOOGLx, MSFTx, AMZNx, METAx (8 xStocks)
- Tokenlist source: https://github.com/backed-fi/cowswap-xstocks-tokenlist (Uniswap format, has addresses + decimals + chainId 196)
- Explorer: https://www.okx.com/web3/explorer/xlayer

For application write: "Researches xStocks RWA tokens on X Layer (196) via OKX Onchain OS."

## 4. Architecture (Option B)
```
User
 |
 v
AI Agent (Claude / Cursor)
 |
 v (MCP Streamable HTTP)
UZAM /mcp
 |
 +-- registry (static list of 8 test assets + docs links, src/data/xlayer-assets.json)
 +-- OKXOnchainAdapter (calls OKX Market MCP/API for price/holders/trades)
 +-- WebResearchProvider (search + fetch, interface only for MVP)
 +-- Evidence builder (claim + url + type + confidence)
 |
 v
Structured JSON -> AI turns into answer
```
No DB for MVP. Stateless + `src/data/xlayer-assets.json`. No vector DB. No trading/wallet signing. READ-ONLY.

## 5. MCP Tools (5 only)
1. `identify_asset(symbol)` -> name, issuer, asset_type, chain 196, contract, official_website, official_documents. If not found, return `{ found: false, uncertainty }`. Never guess.
2. `analyze_onchain(symbol)` -> via OKX adapter: price, supply, holders, top holders concentration, trading activity, data_timestamp. If OKX down, return partial + `missing[]` (e.g. `["okx_credentials"]`, `["price: …"]`).
3. `analyze_backing(symbol)` -> return `{ issuer_claim, backing_structure, custodian, evidence[], confidence: HIGH/MEDIUM/LOW/UNKNOWN, unanswered_questions[] }`. Separate FACT vs CLAIM vs UNKNOWN.
4. `research_asset(symbol)` -> orchestrator: calls 1+2+3 + web recent developments + risks[] + unknowns[]. Output keys: asset, issuer, underlying, backing, redemption, economics, onchain, risks, recent_developments, contradictions, unknowns, evidence, confidence.
5. `compare_assets([AAPLx, TSLAx])` -> table across issuer, backing, backing_evidence, redemption, liquidity, holders, risks, docs_quality. Every conclusion needs evidence. Never say "X is better" without "because evidence Y".

Risk categories (fixed list): issuer, backing, redemption, liquidity, smart_contract, counterparty, regulatory_access, concentration, information. Severity: low/moderate/high/unknown. Never say "safe". Say "low observed concern / insufficient evidence".

## 6. Tech stack (Render-friendly)
- Language: TypeScript 5.x (strict)
- Runtime: Node.js 24.15.0 (you already have it)
- MCP: `@modelcontextprotocol/server` + `@modelcontextprotocol/express` + `@modelcontextprotocol/node` (Streamable HTTP, NOT old SSE)
- Server: `express` + `zod` validation + `dotenv`
- Docs fetch: native `fetch` + simple HTML text extract for MVP
- Data: local JSON file, no Postgres for MVP (add later if needed)
- Deploy: Render Web Service, `npm run build && npm start`, health check `/health`, public `https://uzam.onrender.com/mcp`

Env vars (never commit — see .env.example for all six):
```
OKX_ACCESS_KEY=
OKX_SECRET_KEY=
OKX_PASSPHRASE=
OKX_PROJECT_ID=
ALLOWED_HOSTS=
PORT=3000
```

## 7. Tools to install + sizes (checked 10 Sept 2026)
You already have:
- Node v24.15.0 (~350 MB installed), npm 11.12.1, git 2.54.0
- Disk free: ~22.9 GB on C: — enough
- TypeScript NOT installed globally — we install locally per project (correct way)

Already installed (do not re-run):
```
npm i express zod dotenv @modelcontextprotocol/server @modelcontextprotocol/express @modelcontextprotocol/node
npm i -D typescript @types/node @types/express tsx
```
Measured sizes: `node_modules` ~54 MB, `dist` <1 MB.

Render free tier: 512 MB RAM, shared CPU, sleeps after inactivity — fine for read-only MCP demo. Use Node 22+ in Render settings (set `NODE_VERSION=24`).

Other tools (no install size, web only):
- GitHub account (to connect Render)
- Render account (render.com)
- OKX dev portal key for Onchain OS Market (from https://web3.okx.com/onchainos/dev-portal/project) — Market read-only key only

## 8. Build order (for 17-25 Sept online build)
Phase 1: `npm init` + TS + `/health` + `/mcp` hello (Streamable HTTP). Test with MCP Inspector.
Phase 2: `src/data/xlayer-assets.json` with 8 xStocks + `identify_asset`.
Phase 3: `OKXOnchainAdapter` (chainIndex 196) + `analyze_onchain`. Test AAPLx on X Layer.
Phase 4: `WebResearchProvider` interface (search/fetch stub) + doc link return.
Phase 5: `analyze_backing` with FACT/CLAIM/UNKNOWN split.
Phase 6: `research_asset` orchestrator + risks + unknowns + confidence.
Phase 7: `compare_assets`.
Phase 8: Deploy to Render, connect Claude Desktop/Cursor to `https://<your-app>.onrender.com/mcp`, demo: "Compare AAPLx vs TSLAx backing + biggest unanswered risks?"

Do NOT build: dashboard, login, token, trading, wallet connect, Postgres, vector DB, dozens of chains.

## 9. Test checklist
- `identify_asset("AAPLx")` finds X Layer 196 contract
- `identify_asset("FAKE123")` returns not-found, no hallucination
- `analyze_onchain("AAPLx")` returns OKX data with timestamp
- OKX down -> partial JSON + missing flag
- `compare_assets(["AAPLx","TSLAx"])` returns evidence per row
- Two sources disagree -> `contradictions[]` entry

## 10. Demo script (Oct 6 style, 3 min)
1. Connect agent to Uzam MCP live
2. Ask: "Compare AAPLx and TSLAx on X Layer. Which has stronger backing evidence?"
3. Show tool calls: identify -> onchain via OKX -> backing -> compare
4. Ask: "What are biggest unanswered risks?" -> show unknowns + confidence
Value prop slide: "OKX gives raw data. Uzam gives what it means + what we still don't know."

## 11. Setup (already done — kept for record)
```
cd C:\Users\Emmanuel\uzam
npm install   # deps are in package.json; do NOT re-run npm init (would overwrite it)
```
