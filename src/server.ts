import "dotenv/config";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import registryJson from "./data/xlayer-assets.json" with { type: "json" };
import { OKXOnchainAdapter, loadOkxConfig, XLAYER_CHAIN_INDEX } from "./okx/adapter.js";
import { fetchPage, extractPassages, BACKING_KEYWORDS } from "./research/provider.js";
import { researchAsset, compareAssets, detectNamedCustodian, fmtMoney, tradeRatios } from "./research/engines.js";

// Bounded inputs: symbols are short tickers, never free text.
const SymbolInput = z.object({ symbol: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9.\-]{1,20}$/) });

// ---- Fridge stock: static X Layer registry (no fake contracts, no guessing) ----
type RegistryAsset = {
  symbol: string;
  name: string;
  asset_type: string;
  issuer: string;
  underlying_asset: string;
  chains: string[];
  chainIds: number[];
  contract_addresses: string[];
  official_website: string;
  official_documents: string[];
};

const registry = z.object({
  chain: z.object({ name: z.string(), chainId: z.number(), chainIndex: z.number() }),
  tokenlist: z.string(),
  tokenlist_raw: z.string().optional(),
  issuer_docs: z.string().optional(),
  assets: z.array(z.object({
    symbol: z.string(), name: z.string(), asset_type: z.string(),
    issuer: z.string(), underlying_asset: z.string(),
    chains: z.array(z.string()), chainIds: z.array(z.number()),
    contract_addresses: z.array(z.string()),
    official_website: z.string(), official_documents: z.array(z.string()),
  })),
}).parse(registryJson) as { chain: { name: string; chainId: number; chainIndex: number }; tokenlist: string; assets: RegistryAsset[] };

function findAsset(symbol: unknown): RegistryAsset | undefined {
  if (typeof symbol !== "string") return undefined;
  const clean = symbol.trim().toUpperCase();
  return registry.assets.find((a) => typeof a.symbol === "string" && a.symbol.toUpperCase() === clean);
}

type SearchHit = {
  chainIndex?: unknown; tokenSymbol?: unknown; tokenContractAddress?: unknown;
  explorerUrl?: unknown; price?: unknown; holders?: unknown;
  liquidity?: unknown; marketCap?: unknown; change?: unknown;
};

// ---- MCP factory: fresh server per request (stateless, Render-friendly) ----
const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "uzam", version: "0.1.0" });

  server.registerTool(
    "identify_asset",
    {
      description:
        "Identify an X Layer tokenized stock/ETF (e.g. AAPLx, TSLAx, NVDAx, SPYx). Returns issuer, underlying asset, chain 196 info, official website and documents. Use this before any deeper research.",
      inputSchema: SymbolInput,
    },
    async ({ symbol }) => {
      const asset = findAsset(symbol);
      if (!asset) {
        const supported = registry.assets.map((a) => a.symbol);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  found: false,
                  symbol: symbol.trim().toUpperCase(),
                  uncertainty:
                    "Asset not in Uzam X Layer MVP registry. Do not guess. Resolve via OKX token search on chainIndex 196 or the xStocks tokenlist.",
                  supported_symbols: supported,
                  tokenlist: registry.tokenlist,
                },
                null,
                2
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                found: true,
                name: asset.name,
                symbol: asset.symbol,
                summary: `${asset.symbol} — ${asset.name} (registry lists ${asset.asset_type} by ${asset.issuer} tracking ${asset.underlying_asset}; backing unverified — see analyze_backing). Chain ${asset.chains.join(", ")} (${asset.chainIds.join(", ")}). Official docs: ${asset.official_website}`,
                asset_type: asset.asset_type,
                issuer: asset.issuer,
                underlying_asset: asset.underlying_asset,
                chains: asset.chains,
                chainIds: asset.chainIds,
                contract_addresses: asset.contract_addresses,
                contracts_note:
                  asset.contract_addresses.length === 0
                    ? "Resolve exact contract via OKX token search (chainIndex 196) or tokenlist. No address hardcoded."
                    : undefined,
                official_website: asset.official_website,
                official_documents: asset.official_documents,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "analyze_onchain",
    {
      description:
        "Analyze the blockchain side of an X Layer tokenized stock/ETF (AAPLx, TSLAx, NVDAx, SPYx) using OKX Onchain OS: contract resolution on chain 196, price, supply, holder count, holder concentration, trading activity and liquidity. Returns partial data with an explicit missing[] list when OKX is unconfigured or unreachable. Never guesses.",
      inputSchema: SymbolInput,
    },
    async ({ symbol }: { symbol: string }) => {
      const clean = symbol.trim().toUpperCase();
      const asset = findAsset(clean);
      const dataTimestamp = new Date().toISOString();
      if (!asset) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  found: false,
                  symbol: clean,
                  uncertainty:
                    "Asset not in Uzam X Layer MVP registry, so no contract to look up. Do not guess.",
                  supported_symbols: registry.assets.map((a) => a.symbol),
                  onchain: null,
                  missing: ["asset_identity"],
                  confidence: "UNKNOWN",
                  data_timestamp: dataTimestamp,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const cfg = loadOkxConfig();
      if (!cfg) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  found: true,
                  symbol: asset.symbol,
                  name: asset.name,
                  chains: asset.chains,
                  chainIds: asset.chainIds,
                  onchain: null,
                  missing: ["okx_credentials"],
                  setup:
                    "Create a project at https://web3.okx.com/onchainos/dev-portal/project and set OKX_ACCESS_KEY, OKX_SECRET_KEY and OKX_PASSPHRASE env vars (see .env.example). Then analyze_onchain can query chainIndex 196.",
                  confidence: "UNKNOWN",
                  data_timestamp: dataTimestamp,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const okx = new OKXOnchainAdapter(cfg);
      const missing: string[] = [];

      // Step 1: resolve the exact contract on X Layer (never hardcode, never fallback).
      const search = await okx.searchToken(XLAYER_CHAIN_INDEX, clean);
      let contract: string | null = null;
      let hit: SearchHit | null = null;
      if (search.ok && Array.isArray(search.data)) {
        const onXLayer = (search.data as SearchHit[]).filter((t) => String(t.chainIndex) === XLAYER_CHAIN_INDEX);
        hit = onXLayer.find((t) => String(t.tokenSymbol ?? "").toUpperCase() === clean) ?? null;
        if (hit?.tokenContractAddress) contract = String(hit.tokenContractAddress);
        if (!hit && onXLayer.length > 0) {
          missing.push(`token_search: no exact ${clean} match on 196 (${onXLayer.length} other token(s) ignored)`);
        }
      } else {
        missing.push(`token_search: ${search.error ?? "unknown error"}`);
      }
      if (!contract || !/^0x[0-9a-fA-F]{40}$/.test(contract)) {
        missing.push(!contract ? "contract_on_xlayer" : "contract_on_xlayer: search returned a non-EVM address; refusing to query further");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  found: true,
                  symbol: asset.symbol,
                  name: asset.name,
                  chains: asset.chains,
                  chainIds: asset.chainIds,
                  contracts: [],
                  onchain: null,
                  missing,
                  note: "No matching token found on X Layer (chainIndex 196) via OKX search. Check the xStocks tokenlist for the current contract.",
                  tokenlist: registry.tokenlist,
                  confidence: "LOW",
                  data_timestamp: dataTimestamp,
                },
                null,
                2
              ),
            },
          ],
        };
      }
      if (contract && !/^0x[0-9a-fA-F]{40}$/.test(contract)) {
        missing.push("contract_on_xlayer: search returned a non-EVM address; refusing to query further");
        contract = null;
      }
      // OKX docs: pass EVM addresses all-lowercase for price endpoints.
      const lc = contract ? contract.toLowerCase() : "";
      const item = { chainIndex: XLAYER_CHAIN_INDEX, tokenContractAddress: lc };

      // Step 2: basic price (Basic tier) + premium endpoints, each optional.
      let price: Record<string, unknown> | null = null;
      let info: Record<string, unknown> | null = null;
      let advanced: Record<string, unknown> | null = null;
      let holders: Record<string, unknown>[] = [];

      const [priceRes, infoRes, advRes, holdRes] = await Promise.all([
        okx.getPrice([item]),
        okx.getPriceInfo([item]),
        okx.getAdvancedInfo(XLAYER_CHAIN_INDEX, lc),
        okx.getHolders(XLAYER_CHAIN_INDEX, lc, "20"),
      ]);
      if (priceRes.ok && Array.isArray(priceRes.data) && priceRes.data[0]) price = priceRes.data[0] as Record<string, unknown>;
      else missing.push(`price: ${priceRes.error ?? "no data"}`);

      if (infoRes.ok && Array.isArray(infoRes.data) && infoRes.data[0]) info = infoRes.data[0] as Record<string, unknown>;
      else missing.push(`price_info: ${infoRes.error ?? "no data (Premium tier?)"}`);

      if (advRes.ok && advRes.data) advanced = advRes.data as Record<string, unknown>;
      else missing.push(`advanced_info: ${advRes.error ?? "no data (Premium tier?)"}`);

      if (holdRes.ok && Array.isArray(holdRes.data)) holders = holdRes.data as Record<string, unknown>[];
      else missing.push(`holders: ${holdRes.error ?? "no data (Premium tier?)"}`);

      // Step 3: concentration math from whatever we got.
      const top = holders
        .map((h) => ({ address: String(h.holderWalletAddress ?? ""), percent: Number(h.holdPercent ?? 0) }))
        .filter((h) => h.address && Number.isFinite(h.percent))
        .sort((a, b) => b.percent - a.percent)
        .slice(0, 5);
      const top3Percent = top.slice(0, 3).reduce((s, h) => s + h.percent, 0);
      const observations: string[] = [];
      const top10v = advanced?.top10HoldPercent;
      if (top10v !== null && top10v !== undefined && top10v !== "") {
        observations.push(`Top 10 holders control ${top10v}% of supply (OKX advanced-info).`);
      }
      if (top.length > 0) {
        observations.push(
          `Largest holder: ${top[0].address.slice(0, 10)}… at ${top[0].percent}%. Top 3 combined: ${top3Percent.toFixed(2)}%.`
        );
      }
      const sp = advanced?.stockProfile as { companyName?: unknown; stockCode?: unknown; exchange?: unknown } | undefined;
      if (sp) {
        observations.push(
          `OKX reports underlying stock profile: ${sp.companyName ?? ""} (${sp.stockCode ?? ""}, ${sp.exchange ?? ""}). Cross-check against issuer docs — this is exchange data, not issuer verification.`
        );
      }
      if (missing.length > 0) {
        observations.push(`Partial data: ${missing.length} source(s) unavailable. See missing[].`);
      }

      const sourcesAgree = (price ? 1 : 0) + (info ? 1 : 0) + (advanced ? 1 : 0) >= 2;
      const confidence = sourcesAgree ? "HIGH" : price || info ? "MEDIUM" : "LOW";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                found: true,
                symbol: asset.symbol,
                name: asset.name,
                chains: ["X Layer"],
                contracts: [contract],
                explorer: typeof hit?.explorerUrl === "string" && hit.explorerUrl.startsWith("https://") ? hit.explorerUrl : `https://www.okx.com/web3/explorer/xlayer/token/${contract}`,
                supply: info?.circSupply != null && info.circSupply !== "" ? { circulating: info.circSupply } : null,
                holders_count: (() => { const n = Number(info?.holders ?? hit?.holders); return Number.isFinite(n) ? n : null; })(),
                holder_concentration: {
                  top10HoldPercent: advanced?.top10HoldPercent ?? null,
                  top3Percent: top.length > 0 ? Number(top3Percent.toFixed(2)) : null,
                  topHolders: top,
                },
                trading_activity: {
                  price: fmtMoney(price?.price ?? info?.price ?? hit?.price),
                  price_raw: price?.price ?? info?.price ?? hit?.price ?? null,
                  priceChange24H: info?.priceChange24H ?? hit?.change ?? null,
                  volume24H: fmtMoney(info?.volume24H),
                  volume24H_raw: info?.volume24H ?? null,
                  txs24H: info?.txs24H ?? null,
                  liquidity: fmtMoney(info?.liquidity ?? hit?.liquidity),
                  liquidity_raw: info?.liquidity ?? hit?.liquidity ?? null,
                  marketCap: fmtMoney(info?.marketCap ?? hit?.marketCap),
                  marketCap_raw: info?.marketCap ?? hit?.marketCap ?? null,
                  ...tradeRatios(info?.volume24H, info?.liquidity ?? hit?.liquidity, info?.marketCap ?? hit?.marketCap, info?.txs24H),
                },
                risk_flags: {
                  riskControlLevel: advanced?.riskControlLevel ?? null,
                  devHoldingPercent: advanced?.devHoldingPercent ?? null,
                  bundleHoldingPercent: advanced?.bundleHoldingPercent ?? null,
                  suspiciousHoldingPercent: advanced?.suspiciousHoldingPercent ?? null,
                },
                summary: `${asset.symbol} onchain (X Layer ${contract}): price ${price?.price ?? info?.price ?? "n/a"}, holders ${info?.holders ?? "n/a"}, top-10 ${advanced?.top10HoldPercent ?? "n/a"}%, liquidity ${info?.liquidity ?? "n/a"} (confidence ${confidence}${missing.length > 0 ? `, ${missing.length} source(s) missing` : ""}).`,
                observations,
                missing,
                confidence,
                data_timestamp: dataTimestamp,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "analyze_backing",
    {
      description:
        "Investigate what backs an X Layer tokenized stock/ETF (AAPLx, TSLAx, NVDAx, SPYx): fetches the issuer's official pages live, quotes backing passages as evidence, and separates issuer CLAIMs from independently verified FACTs. Returns unanswered_questions for anything not found. Never invents custodian or reserve details.",
      inputSchema: SymbolInput,
    },
    async ({ symbol }: { symbol: string }) => {
      const clean = symbol.trim().toUpperCase();
      const asset = findAsset(clean);
      const dataTimestamp = new Date().toISOString();
      if (!asset) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  found: false,
                  symbol: clean,
                  uncertainty: "Asset not in Uzam X Layer MVP registry. Do not guess.",
                  supported_symbols: registry.assets.map((a) => a.symbol),
                  confidence: "UNKNOWN",
                  data_timestamp: dataTimestamp,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Fridge step: read the official pages live, keep backing passages.
      const urls = [asset.official_website, ...asset.official_documents].filter(
        (u, i, arr) => u.startsWith("http") && arr.indexOf(u) === i
      );
      const evidence: { claim: string; source_title: string | null; source_url: string; excerpt: string; basis: string; source_type: string; tier: number; confidence: string; retrieved_at: string }[] = [];
      const fetched: string[] = [];
      const failed: string[] = [];
      for (const url of urls.slice(0, 4)) {
        const doc = await fetchPage(url);
        if (doc.ok && doc.text) {
          fetched.push(url);
          for (const p of extractPassages(doc.text, BACKING_KEYWORDS)) {
            evidence.push({
              claim: "Issuer describes backing/custody/redemption on its official site.",
              source_title: doc.title,
              source_url: url,
              excerpt: p,
              basis: "claim",
              source_type: "official_issuer",
              tier: 1,
              confidence: "MEDIUM",
              retrieved_at: new Date().toISOString(),
            });
          }
        } else {
          failed.push(`${url} (${doc.error ?? `HTTP ${doc.status}`})`);
        }
      }

      const unanswered: string[] = [];
      const namedCustodian = detectNamedCustodian(evidence.map((e) => String(e.excerpt)));
      const hasRedeem = evidence.some((e) => /redeem|redemption|cash value/i.test(e.excerpt));
      const hasReserve = evidence.some((e) => /reserve|attest|audit/i.test(e.excerpt));
      if (!namedCustodian) unanswered.push("No specific custodian named on the fetched official pages (custody arrangements are mentioned in general terms).");
      if (!hasRedeem) unanswered.push("No redemption mechanics found on the fetched official pages.");
      if (!hasReserve) unanswered.push("No reserve report or attestation linked from the fetched official pages.");
      unanswered.push("No independent (non-issuer) verification of backing gathered in MVP — treat issuer statements as CLAIM, not FACT.");
      if (failed.length > 0) unanswered.push(`Could not read: ${failed.join("; ")}`);

      const confidence = evidence.length >= 3 && fetched.length >= 2 ? "MEDIUM" : evidence.length > 0 ? "LOW" : "UNKNOWN";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                found: true,
                symbol: asset.symbol,
                name: asset.name,
                underlying_assets: [asset.underlying_asset],
                issuer_claim:
                  evidence.length > 0
                    ? "Issuer claims the token tracks the underlying 1:1 with backing held in custody — see quoted excerpts. This is the issuer's CLAIM until independently verified."
                    : "No backing statement extracted from official pages (see unanswered_questions).",
                backing_structure: evidence.length > 0 ? "Tokenized-equity claim structure per issuer docs (details in evidence excerpts)." : "UNKNOWN — no backing passage extracted (see unanswered_questions).",
                custodian: namedCustodian
                  ? `${namedCustodian} (as named on the official page — still the issuer's claim, not independent verification).`
                  : "UNKNOWN — pages mention custody arrangements but name no specific custodian.",
                reserve_information: hasReserve ? ["See evidence excerpts."] : [],
                summary: `${asset.symbol} backing: ${evidence.length} quoted excerpt(s) from ${fetched.length} official page(s), confidence ${confidence}. Custodian: ${namedCustodian ?? "UNKNOWN"}. ${unanswered.length} open question(s).`,
                evidence,
                pages_read: fetched,
                confidence,
                unanswered_questions: unanswered,
                data_timestamp: dataTimestamp,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "research_asset",
    {
      description:
        "Full evidence-backed research report on one X Layer tokenized stock/ETF (AAPLx, TSLAx, NVDAx, SPYx): identity, issuer, backing with quoted evidence, onchain data via OKX, 9-category risk analysis, unknowns and confidence. Use this when the user wants to understand an asset beyond basic market data. Set focus to narrow the work: issuer (identity only), backing (documents only), risks (risk sections only), full (everything).",
      inputSchema: z.object({ symbol: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9.\-]{1,20}$/), focus: z.enum(["full", "issuer", "backing", "risks"]).optional() }),
    },
    async ({ symbol, focus }: { symbol: string; focus?: "full" | "issuer" | "backing" | "risks" }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(await researchAsset(symbol, focus ?? "full"), null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `research failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true as const };
      }
    }
  );

  server.registerTool(
    "compare_assets",
    {
      description:
        "Compare 2-4 X Layer tokenized stocks/ETFs (e.g. [\"AAPLx\", \"TSLAx\"]) across backing evidence, liquidity, holder concentration, risks and confidence. Returns a structured table plus per-category leaders with reasons — never a bald recommendation.",
      inputSchema: z.object({ symbols: z.array(z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9.\-]{1,20}$/)).min(1).max(4) }),
    },
    async ({ symbols }: { symbols: string[] }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(await compareAssets(symbols), null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `compare failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true as const };
      }
    }
  );

  return server;
});

// ---- HTTP app ----
const rawHosts = (process.env.ALLOWED_HOSTS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase().replace(/:\d+$/, ""))
  .filter((h) => /^[a-z0-9.-]+$/.test(h));

if (process.env.NODE_ENV === "production" && rawHosts.length === 0) {
  throw new Error("ALLOWED_HOSTS must be set in production (e.g. uzam.onrender.com)");
}

const app = rawHosts.length > 0
  ? createMcpExpressApp({ host: "0.0.0.0", allowedHosts: rawHosts })
  : createMcpExpressApp();
const nodeHandler = toNodeHandler(handler);

app.all("/mcp", (req: Request, res: Response) => {
  Promise.resolve(nodeHandler(req, res, req.body)).catch((err: unknown) => {
    console.error("MCP handler error:", err);
    if (!res.headersSent) {
      const body = req.body as { id?: unknown } | undefined;
      res.status(500).json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32603, message: "Internal error" } });
    }
  });
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "uzam", transport: "streamable-http" });
});

app.get("/", (_req: Request, res: Response) => {
  res.json({
    service: "uzam",
    description:
      "Uzam is an RWA intelligence MCP for X Layer tokenized stocks. Connect an MCP client to POST /mcp.",
    mcp_endpoint: "/mcp",
    health: "/health",
    tools: ["identify_asset", "analyze_onchain", "analyze_backing", "research_asset", "compare_assets"],
  });
});

const rawPort = Number(process.env.PORT ?? 3000);
const PORT = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 3000;
const srv = app.listen(PORT, "0.0.0.0", () => {
  console.log(`uzam listening on port ${PORT} — MCP at /mcp`);
});
srv.on("error", (e) => {
  console.error("listen failed:", e);
  process.exit(1);
});
