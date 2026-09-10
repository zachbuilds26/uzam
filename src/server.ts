import "dotenv/config";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import registryJson from "./data/xlayer-assets.json" with { type: "json" };
import { OKXOnchainAdapter, loadOkxConfig, XLAYER_CHAIN_INDEX } from "./okx/adapter.js";
import { fetchPage, extractPassages, BACKING_KEYWORDS } from "./research/provider.js";

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

const registry = registryJson as {
  chain: { name: string; chainId: number; chainIndex: number };
  tokenlist: string;
  assets: RegistryAsset[];
};

function findAsset(symbol: string): RegistryAsset | undefined {
  const clean = symbol.trim().toUpperCase();
  return registry.assets.find((a) => a.symbol.toUpperCase() === clean);
}

// ---- MCP factory: fresh server per request (stateless, Render-friendly) ----
const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "uzam", version: "0.1.0" });

  server.registerTool(
    "identify_asset",
    {
      description:
        "Identify an X Layer tokenized stock/ETF (e.g. AAPLx, TSLAx, NVDAx, SPYx). Returns issuer, underlying asset, chain 196 info, official website and documents. Use this before any deeper research.",
      inputSchema: z.object({ symbol: z.string() }),
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
      inputSchema: z.object({ symbol: z.string() }),
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

      // Step 1: resolve the exact contract on X Layer (never hardcode).
      const search = await okx.searchToken(XLAYER_CHAIN_INDEX, clean);
      let contract: string | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let hit: any = null;
      if (search.ok && Array.isArray(search.data)) {
        const onXLayer = search.data.filter((t) => String(t.chainIndex) === XLAYER_CHAIN_INDEX);
        hit =
          onXLayer.find((t) => String(t.tokenSymbol ?? "").toUpperCase() === clean) ?? onXLayer[0] ?? null;
        if (hit?.tokenContractAddress) contract = String(hit.tokenContractAddress);
      } else {
        missing.push(`token_search: ${search.error ?? "unknown error"}`);
      }
      if (!contract) {
        missing.push("contract_on_xlayer");
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
      // OKX docs: pass EVM addresses all-lowercase for price endpoints.
      const item = { chainIndex: XLAYER_CHAIN_INDEX, tokenContractAddress: contract.toLowerCase() };

      // Step 2: basic price (Basic tier) + premium endpoints, each optional.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let price: any = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let info: any = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let advanced: any = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let holders: any[] = [];

      const priceRes = await okx.getPrice([item]);
      if (priceRes.ok && Array.isArray(priceRes.data) && priceRes.data[0]) price = priceRes.data[0];
      else missing.push(`price: ${priceRes.error ?? "no data"}`);

      const infoRes = await okx.getPriceInfo([item]);
      if (infoRes.ok && Array.isArray(infoRes.data) && infoRes.data[0]) info = infoRes.data[0];
      else missing.push(`price_info: ${infoRes.error ?? "no data (Premium tier?)"}`);

      const advRes = await okx.getAdvancedInfo(XLAYER_CHAIN_INDEX, contract);
      if (advRes.ok && advRes.data) advanced = advRes.data;
      else missing.push(`advanced_info: ${advRes.error ?? "no data (Premium tier?)"}`);

      const holdRes = await okx.getHolders(XLAYER_CHAIN_INDEX, contract, "20");
      if (holdRes.ok && Array.isArray(holdRes.data)) holders = holdRes.data;
      else missing.push(`holders: ${holdRes.error ?? "no data (Premium tier?)"}`);

      // Step 3: concentration math from whatever we got.
      const top = holders
        .map((h) => ({ address: String(h.holderWalletAddress ?? ""), percent: Number(h.holdPercent ?? 0) }))
        .filter((h) => h.address && Number.isFinite(h.percent))
        .sort((a, b) => b.percent - a.percent)
        .slice(0, 5);
      const top3Percent = top.slice(0, 3).reduce((s, h) => s + h.percent, 0);
      const observations: string[] = [];
      if (advanced?.top10HoldPercent) {
        observations.push(`Top 10 holders control ${advanced.top10HoldPercent}% of supply (OKX advanced-info).`);
      }
      if (top.length > 0) {
        observations.push(
          `Largest holder: ${top[0].address.slice(0, 10)}… at ${top[0].percent}%. Top 3 combined: ${top3Percent.toFixed(2)}%.`
        );
      }
      if (advanced?.stockProfile) {
        observations.push(
          `OKX reports underlying stock profile: ${advanced.stockProfile.companyName ?? ""} (${advanced.stockProfile.stockCode ?? ""}, ${advanced.stockProfile.exchange ?? ""}). Cross-check against issuer docs — this is exchange data, not issuer verification.`
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
                explorer: hit?.explorerUrl ?? `https://www.okx.com/web3/explorer/xlayer/token/${contract}`,
                supply: info?.circSupply ? { circulating: info.circSupply } : {},
                holders_count: info?.holders ?? hit?.holders ?? null,
                holder_concentration: {
                  top10HoldPercent: advanced?.top10HoldPercent ?? null,
                  top3Percent: top.length > 0 ? Number(top3Percent.toFixed(2)) : null,
                  topHolders: top,
                },
                trading_activity: {
                  price: price?.price ?? info?.price ?? hit?.price ?? null,
                  priceChange24H: info?.priceChange24H ?? hit?.change ?? null,
                  volume24H: info?.volume24H ?? null,
                  txs24H: info?.txs24H ?? null,
                  liquidity: info?.liquidity ?? hit?.liquidity ?? null,
                  marketCap: info?.marketCap ?? hit?.marketCap ?? null,
                },
                risk_flags: {
                  riskControlLevel: advanced?.riskControlLevel ?? null,
                  devHoldingPercent: advanced?.devHoldingPercent ?? null,
                  bundleHoldingPercent: advanced?.bundleHoldingPercent ?? null,
                  suspiciousHoldingPercent: advanced?.suspiciousHoldingPercent ?? null,
                },
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
      inputSchema: z.object({ symbol: z.string() }),
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
      const evidence: { claim: string; source_title: string | null; source_url: string; excerpt: string; basis: string }[] = [];
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
            });
          }
        } else {
          failed.push(`${url} (${doc.error ?? `HTTP ${doc.status}`})`);
        }
      }

      const unanswered: string[] = [];
      const hasCustodian = evidence.some((e) => /custod/i.test(e.excerpt));
      const hasRedeem = evidence.some((e) => /redeem|redemption|cash value/i.test(e.excerpt));
      const hasReserve = evidence.some((e) => /reserve|attest|audit/i.test(e.excerpt));
      if (!hasCustodian) unanswered.push("No custodian named on the fetched official pages.");
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
                backing_structure: "Tokenized-equity claim structure per issuer docs (details in evidence excerpts).",
                custodian: hasCustodian ? "Named in evidence excerpts below." : "UNKNOWN — not stated on fetched pages.",
                reserve_information: hasReserve ? "See evidence excerpts." : [],
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

  return server;
});

// ---- HTTP app ----
const rawHosts = (process.env.ALLOWED_HOSTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = createMcpExpressApp(
  rawHosts.length > 0 ? { host: "0.0.0.0", allowedHosts: rawHosts } : undefined
);
const nodeHandler = toNodeHandler(handler);

app.all("/mcp", (req: Request, res: Response) => void nodeHandler(req, res, req.body));

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
    tools: ["identify_asset", "analyze_onchain", "analyze_backing"],
  });
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`uzam listening on port ${PORT} — MCP at /mcp`);
});
