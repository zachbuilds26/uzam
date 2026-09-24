// x402 paid routes — the cash register.
// Discovery (identify) is FREE — it's the funnel. Depth is paid:
// research (full report) $0.25, compare (up to 4 assets) $0.50 —
// flat per route because the paywall allows one fixed price per path.
// $0.25 anchors to comparable agent research APIs (Messari AI $0.25);
// compare at $0.50 covers 2-4x the compute of one research call.
// Paid in USDT0 on X Layer via OKX's payment middleware: unpaid calls get
// HTTP 402 + PAYMENT-REQUIRED, paid calls run the engines.
// Without PAY_TO_ADDRESS (or without OKX facilitator creds) the routes stay
// free and log a warning — never half-enforced.

import type { Express, Request, Response, RequestHandler } from "express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { loadOkxConfig } from "../okx/adapter.js";
import { researchAsset, compareAssets, findAsset, supportedSymbols } from "../research/engines.js";

const NETWORK = "eip155:196";
export const PRICE_RESEARCH = "$0.25";
export const PRICE_COMPARE = "$0.50";
// Public receipts log: last 50 paid-route calls (IPs stripped on read,
// no wallet addresses — just route, detail, timestamp, settled flag).
const receipts: { ts: string; paid_route: string; detail: string; settled: boolean; ip: unknown }[] = [];

function usage(route: string, detail: string, req: Request): void {
  const x402 = (req as unknown as Record<string, unknown>).x402 as
    | { settleResult?: unknown; payment?: unknown }
    | undefined;
  const entry = {
    ts: new Date().toISOString(),
    paid_route: route,
    detail,
    settled: !!x402,
    ip: req.ip ?? null,
  };
  receipts.unshift(entry);
  if (receipts.length > 50) receipts.length = 50;
  console.log(JSON.stringify(entry));
}

export async function mountPaidRoutes(app: Express): Promise<{ paid: boolean; reason: string }> {
  const payTo = (process.env.PAY_TO_ADDRESS ?? "").trim();
  const okx = loadOkxConfig();

  let paywall: RequestHandler | null = null;
  if (!payTo || !okx) {
    console.warn("[x402] PAY_TO_ADDRESS or OKX facilitator creds missing — paid routes running FREE.");
  } else {
    try {
      const facilitator = new OKXFacilitatorClient({
        apiKey: okx.key,
        secretKey: okx.secret,
        passphrase: okx.passphrase,
      });
      const resourceServer = new x402ResourceServer(facilitator);
      resourceServer.register(NETWORK, new ExactEvmScheme());
      // Handshake FIRST: if the facilitator is unreachable we stay free instead
      // of mounting a paywall whose background sync would crash the process.
      await resourceServer.initialize();
      paywall = paymentMiddleware(
        {
          "POST /api/research": {
            accepts: [{ scheme: "exact", network: NETWORK, payTo, price: PRICE_RESEARCH }],
            description: "Uzam full RWA research report on one X Layer tokenized stock (identity, backing evidence, onchain, risks, unknowns).",
            mimeType: "application/json",
          },
          "POST /api/compare": {
            accepts: [{ scheme: "exact", network: NETWORK, payTo, price: PRICE_COMPARE }],
            description: "Uzam side-by-side comparison of up to 4 X Layer tokenized stocks with per-category leaders.",
            mimeType: "application/json",
          },
        },
        resourceServer
      ) as unknown as RequestHandler;
      console.log(`[x402] paywall ON — research ${PRICE_RESEARCH}, compare ${PRICE_COMPARE} -> ${payTo} (identify free)`);
    } catch (e: unknown) {
      console.error("[x402] facilitator unreachable — paid routes running FREE:", e instanceof Error ? e.message : String(e));
    }
  }

  // Parameter validation runs BEFORE the paywall: buyers must get a 400 for
// bad input without ever seeing a payment challenge. (Review rejects services
// that charge first and validate later.)
const TICKER = /^[A-Za-z0-9.\-]{1,20}$/;

function validatePaidBody(req: Request, res: Response, next: () => void): void {
  if (req.method === "POST" && req.path === "/api/research") {
    const s: unknown = req.body?.symbol;
    if (typeof s !== "string" || s.trim().length < 1 || !TICKER.test(s.trim())) {
      res.status(400).json({ ok: false, error: "invalid symbol: 1-20 ticker characters" });
      return;
    }
  }
  if (req.method === "POST" && req.path === "/api/compare") {
    const arr: unknown = req.body?.symbols;
    const ok =
      Array.isArray(arr) && arr.length >= 1 && arr.length <= 4 &&
      arr.every((x: unknown) => typeof x === "string" && x.trim().length >= 1 && TICKER.test(x.trim()));
    if (!ok) {
      res.status(400).json({ ok: false, error: "invalid symbols: array of 1-4 ticker strings" });
      return;
    }
  }
  next();
}

  // Validation first, then paywall, then handlers — in that order.
  app.use(validatePaidBody);
  if (paywall) app.use(paywall);

  // Handlers: identify is FREE (funnel — discovery costs nothing).
  // research/compare go through the paywall above when configured.

  const runResearch = async (req: Request, res: Response): Promise<void> => {
    const symbol = typeof req.body?.symbol === "string" ? req.body.symbol : "";
    const focus = typeof req.body?.focus === "string" ? req.body.focus : "full";
    usage("research", symbol, req);
    const result = await researchAsset(symbol, focus === "issuer" || focus === "backing" || focus === "risks" ? focus : "full", { price: PRICE_RESEARCH });
    res.json({ ok: true, data: result });
  };

  const runCompare = async (req: Request, res: Response): Promise<void> => {
    const symbols = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
    usage("compare", symbols.join(","), req);
    const result = await compareAssets(symbols, { price: PRICE_COMPARE });
    res.json({ ok: true, data: result });
  };

  const runIdentify = async (req: Request, res: Response): Promise<void> => {
    const symbol = typeof req.body?.symbol === "string" ? req.body.symbol : "";
    const asset = findAsset(symbol);
    if (!asset) {
      res.json({ ok: true, data: { found: false, symbol: symbol.trim().toUpperCase(), supported_symbols: supportedSymbols() } });
      return;
    }
    res.json({
      ok: true,
      data: {
        found: true, name: asset.name, symbol: asset.symbol, asset_type: asset.asset_type,
        issuer: asset.issuer, issuer_legal: asset.issuer_legal ?? null,
        underlying_asset: asset.underlying_asset, underlying: asset.underlying ?? null,
        chains: asset.chains, chainIds: asset.chainIds,
        official_website: asset.official_website, official_documents: asset.official_documents,
      },
    });
  };

  app.post("/api/research", (req: Request, res: Response) => {
    runResearch(req, res).catch((e: unknown) => {
      if (!res.headersSent) res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });
  });
  app.post("/api/compare", (req: Request, res: Response) => {
    runCompare(req, res).catch((e: unknown) => {
      if (!res.headersSent) res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });
  });
  app.post("/api/identify", (req: Request, res: Response) => {
    runIdentify(req, res).catch((e: unknown) => {
      if (!res.headersSent) res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });
  });

  // ---- Discovery + free preview (never paywalled) ----
  // Agents find paid APIs through these files, not through docs pages.
  app.get("/.well-known/x402", (_req: Request, res: Response) => {
    res.json({
      network: NETWORK,
      asset: "USDT0",
      routes: [
        { path: "POST /api/identify", price: "$0.00", description: "Free: resolve symbol to issuer, underlying, chain, docs." },
        { path: "POST /api/research", price: PRICE_RESEARCH, description: "Full RWA report: identity, backing evidence, onchain, risks, unknowns." },
        { path: "POST /api/compare", price: PRICE_COMPARE, description: "Side-by-side comparison of up to 4 assets with per-category leaders." },
        { path: "GET /api/research/preview?symbol=AAPLx", price: "$0.00", description: "Free capped preview: identity only, no fetches." },
      ],
    });
  });

  app.get("/openapi.json", (req: Request, res: Response) => {
    const base = `${req.protocol}://${req.get("host")}`;
    const symbolSchema = { type: "object", properties: { symbol: { type: "string", example: "AAPLx" } }, required: ["symbol"] };
    const researchSchema = { type: "object", properties: { symbol: { type: "string", example: "AAPLx" }, focus: { type: "string", enum: ["full", "issuer", "backing", "risks"] } }, required: ["symbol"] };
    const compareSchema = { type: "object", properties: { symbols: { type: "array", items: { type: "string" }, example: ["AAPLx", "TSLAx"] } }, required: ["symbols"] };
    const asJson = (schema: unknown) => ({ content: { "application/json": { schema } } });
    res.json({
      openapi: "3.0.0",
      info: { title: "Uzam RWA Intelligence API", version: "0.1.0", description: "Evidence-backed research on xStocks tokenized equities (X Layer 196). Identify free, depth paid via x402." },
      servers: [{ url: base }],
      paths: {
        "/api/identify": { post: { summary: "Free asset identifier", requestBody: asJson(symbolSchema) } },
        "/api/research": { post: { summary: `Full report (${PRICE_RESEARCH} via x402)`, requestBody: asJson(researchSchema) } },
        "/api/compare": { post: { summary: `Compare up to 4 (${PRICE_COMPARE} via x402)`, requestBody: asJson(compareSchema) } },
        "/api/research/preview": { get: { summary: "Free capped preview (identity only)" } },
        "/api/receipts": { get: { summary: "Public log of recent paid-route calls" } },
      },
    });
  });

  app.get("/llms.txt", (_req: Request, res: Response) => {
    res.type("text/plain").send(
      `# Uzam — RWA intelligence for xStocks on X Layer (chain 196)\n` +
      `Free: POST /api/identify {"symbol":"AAPLx"} → issuer, underlying, docs.\n` +
      `Paid (x402, USDT0 on X Layer): POST /api/research (${PRICE_RESEARCH}) → full report with backing evidence, onchain, 9 risks, unknowns, receipt. POST /api/compare (${PRICE_COMPARE}) → up to 4 assets, per-category leaders.\n` +
      `Free preview: GET /api/research/preview?symbol=AAPLx (identity only).\n` +
      `MCP (free): POST /mcp → tools identify_asset, analyze_onchain, analyze_backing, research_asset, compare_assets.\n` +
      `Supported: ${supportedSymbols().join(", ")}. Never guesses; unknowns stated, never "safe".\n`
    );
  });

  // Free capped preview: identity only, zero external fetches.
  app.get("/api/research/preview", (req: Request, res: Response) => {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "";
    if (!symbol.trim() || !TICKER.test(symbol.trim())) {
      res.status(400).json({ ok: false, error: "invalid symbol: 1-20 ticker characters" });
      return;
    }
    researchAsset(symbol, "issuer")
      .then((result) => res.json({ ok: true, preview: true, data: result }))
      .catch((e: unknown) => {
        if (!res.headersSent) res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      });
  });

  app.get("/api/receipts", (_req: Request, res: Response) => {
    res.json({ ok: true, receipts: receipts.map(({ ip, ...rest }) => rest) });
  });

  // One-click agent install: paste into Claude Desktop / Cursor MCP config.
  app.get("/install", (req: Request, res: Response) => {
    const base = `${req.protocol}://${req.get("host")}`;
    res.type("text/plain").send(
      `# Uzam MCP — add to Claude Desktop (claude_desktop_config.json) or Cursor (~/.cursor/mcp.json):\n` +
      `{\n  "mcpServers": {\n    "uzam": { "url": "${base}/mcp" }\n  }\n}\n` +
      `# Then ask: "Use Uzam to compare AAPLx vs TSLAx backing and biggest unanswered risks."\n` +
      `# REST: free identify + preview, paid research/compare via x402 — see ${base}/.well-known/x402\n`
    );
  });

  const on = paywall !== null;
  return on
    ? { paid: true, reason: `charging ${PRICE_RESEARCH}/research + ${PRICE_COMPARE}/compare` }
    : { paid: false, reason: "free mode (set PAY_TO_ADDRESS + OKX creds to charge)" };
}
