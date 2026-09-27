// x402 paid routes — the cash register.
// Discovery (identify $0.08, preview $0.08) is the cheap funnel. Depth is paid:
// research (full dossier) $0.25, compare (up to 4 assets) $0.50 —
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
import { researchAsset, compareAssets, supportedSymbols, buildIdentity } from "../research/engines.js";

const NETWORK = "eip155:196";
export const PRICE_IDENTIFY = "$0.08";
export const PRICE_PREVIEW = "$0.08";
export const PRICE_RESEARCH = "$0.25";
export const PRICE_COMPARE = "$0.50";
// Public receipts log: last 50 paid-route calls. No IPs, no wallet addresses —
// route, detail, timestamp and settled flag only.
const receipts: { ts: string; paid_route: string; detail: string; settled: boolean }[] = [];

function usage(route: string, detail: string, _req: Request): void {
  const x402 = (_req as unknown as Record<string, unknown>).x402 as
    | { settleResult?: unknown; payment?: unknown }
    | undefined;
  const entry = {
    ts: new Date().toISOString(),
    paid_route: route,
    // Cap detail: symbols are TICKER-validated upstream, belt and suspenders.
    detail: String(detail ?? "").slice(0, 200),
    settled: !!x402,
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
      // Handshake FIRST with a deadline: if the facilitator hangs, boot must
      // still reach listen() so /health serves and Render marks us live.
      // A hung payments dependency must never sink the whole service.
      const handshake = resourceServer.initialize();
      const deadline = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("facilitator handshake timeout (8s)")), 8000)
      );
      await Promise.race([handshake, deadline]);
      paywall = paymentMiddleware(
        {
          "POST /api/identify": {
            accepts: [{ scheme: "exact", network: NETWORK, payTo, price: PRICE_IDENTIFY }],
            description: "Uzam identity check on X Layer (under 1 minute): what the token is, issuer, underlying, network, contract, verification checks, official sources, unknowns. No market analysis.",
            mimeType: "application/json",
          },
          "GET /api/research/preview": {
            accepts: [{ scheme: "exact", network: NETWORK, payTo, price: PRICE_PREVIEW }],
            description: "Uzam capped research preview on one X Layer tokenized stock (identity only, no fetches).",
            mimeType: "application/json",
          },
          "POST /api/research": {
            accepts: [{ scheme: "exact", network: NETWORK, payTo, price: PRICE_RESEARCH }],
            description: "Uzam evidence dossier on one X Layer tokenized stock: snapshot, findings, backing (claim vs verified vs on-chain vs unknown), on-chain, liquidity with calculated price impact, price relationship, 10 risk categories, source register. Focus: full/issuer/backing/risks.",
            mimeType: "application/json",
          },
          "POST /api/compare": {
            accepts: [{ scheme: "exact", network: NETWORK, payTo, price: PRICE_COMPARE }],
            description: "Uzam side-by-side comparison table for up to 4 X Layer tokenized stocks: identity, legal, backing, on-chain, liquidity, price, documentation, unknowns per asset. Observations only, never a winner.",
            mimeType: "application/json",
          },
        },
        resourceServer
      ) as unknown as RequestHandler;
      console.log(`[x402] paywall ON — identify ${PRICE_IDENTIFY}, preview ${PRICE_PREVIEW}, research ${PRICE_RESEARCH}, compare ${PRICE_COMPARE} -> ${payTo} (MCP free)`);
    } catch (e: unknown) {
      console.error("[x402] facilitator unreachable — paid routes running FREE:", e instanceof Error ? e.message : String(e));
    }
  }

  // Parameter validation runs BEFORE the paywall: buyers must get a 400 for
// bad input without ever seeing a payment challenge. (Review rejects services
// that charge first and validate later.)
// Paths are normalized (trailing slash) because the paywall normalizes too —
// validation and charging must agree on what a route is.
const TICKER = /^[A-Za-z0-9](?:[A-Za-z0-9.\-]{0,18}[A-Za-z0-9])?$/;
const FOCUS = ["full", "issuer", "backing", "risks"] as const;
const LANG_RE = /^[a-z]{2}(-[a-z]{2})?$/;

function normPath(req: Request): string {
  const p = req.path === "/" ? "/" : req.path.replace(/\/+$/, "");
  return `${req.method} ${p}`;
}

function badSymbol(s: unknown): boolean {
  return typeof s !== "string" || !TICKER.test(s.trim());
}

function validatePaidBody(req: Request, res: Response, next: () => void): void {
  const route = normPath(req);
  if (route === "POST /api/research") {
    const s: unknown = req.body?.symbol;
    if (badSymbol(s)) {
      res.status(400).json({ ok: false, error: "invalid symbol: 1-20 ticker characters" });
      return;
    }
    const f: unknown = req.body?.focus;
    if (f !== undefined && (typeof f !== "string" || !(FOCUS as readonly string[]).includes(f))) {
      res.status(400).json({ ok: false, error: "invalid focus: full|issuer|backing|risks" });
      return;
    }
  }
  if (route === "POST /api/compare") {
    const arr: unknown = req.body?.symbols;
    const ok =
      Array.isArray(arr) && arr.length >= 1 && arr.length <= 4 &&
      arr.every((x: unknown) => typeof x === "string" && TICKER.test(x.trim()));
    if (!ok) {
      res.status(400).json({ ok: false, error: "invalid symbols: array of 1-4 ticker strings" });
      return;
    }
  }
  if (route === "POST /api/identify") {
    const s: unknown = req.body?.symbol;
    if (badSymbol(s)) {
      res.status(400).json({ ok: false, error: "invalid symbol: 1-20 ticker characters" });
      return;
    }
    const l: unknown = req.body?.lang;
    if (l !== undefined && (typeof l !== "string" || !LANG_RE.test(l.trim().toLowerCase()))) {
      res.status(400).json({ ok: false, error: "invalid lang: en|zh|es|fr" });
      return;
    }
  }
  next();
}

  // Validation first, then paywall, then handlers — in that order.
  // (/mcp and /health are registered before this and intentionally bypass
  // both: MCP tools validate per-tool via zod, health needs no validation.)
  app.use(validatePaidBody);
  if (paywall) app.use(paywall);

  // Handlers: identify, preview, research and compare are ALL paywalled when
  // configured (MCP tools stay free). Prices: PRICE_* below.

  const runResearch = async (req: Request, res: Response): Promise<void> => {
    const symbol = typeof req.body?.symbol === "string" ? req.body.symbol : "";
    const focusRaw: unknown = req.body?.focus;
    const focus = typeof focusRaw === "string" && (FOCUS as readonly string[]).includes(focusRaw) ? focusRaw : "full";
    const lang = typeof req.body?.lang === "string" ? req.body.lang : undefined;
    usage("research", symbol, req);
    const result = await researchAsset(symbol, focus as "full" | "issuer" | "backing" | "risks", { price: PRICE_RESEARCH, lang });
    res.json({ ok: true, data: result });
  };

  const runCompare = async (req: Request, res: Response): Promise<void> => {
    const symbols = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
    const lang = typeof req.body?.lang === "string" ? req.body.lang : undefined;
    usage("compare", symbols.join(","), req);
    const result = await compareAssets(symbols, { price: PRICE_COMPARE, lang });
    res.json({ ok: true, data: result });
  };

  const runIdentify = async (req: Request, res: Response): Promise<void> => {
    // Fast identity check: registry only, no fetches, no market analysis.
    const symbol = typeof req.body?.symbol === "string" ? req.body.symbol : "";
    const lang = typeof req.body?.lang === "string" ? req.body.lang : undefined;
    res.json({ ok: true, data: buildIdentity(symbol, { lang }) });
  };

  // Public errors stay generic; details go to server logs only.
  const fail = (route: string) => (e: unknown) => {
    console.error(`${route} failed:`, e instanceof Error ? e.message : String(e));
  };

  app.post("/api/research", (req: Request, res: Response) => {
    runResearch(req, res).catch((e: unknown) => {
      fail("research")(e);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "research_unavailable" });
    });
  });
  app.post("/api/compare", (req: Request, res: Response) => {
    runCompare(req, res).catch((e: unknown) => {
      fail("compare")(e);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "compare_unavailable" });
    });
  });
  app.post("/api/identify", (req: Request, res: Response) => {
    runIdentify(req, res).catch((e: unknown) => {
      fail("identify")(e);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "identify_unavailable" });
    });
  });

  // ---- Discovery + free preview (never paywalled) ----
  // Agents find paid APIs through these files, not through docs pages.
  app.get("/.well-known/x402", (_req: Request, res: Response) => {
    res.json({
      network: NETWORK,
      asset: "USDT0",
      routes: [
        { path: "POST /mcp", price: "$0.00", description: "Free: 5 agent tools (identify, onchain, backing, research, compare)." },
        { path: "POST /api/identify", price: PRICE_IDENTIFY, description: "60-second identity check: what the token is, verification checks, official sources, unknowns. No market data." },
        { path: "POST /api/research", price: PRICE_RESEARCH, description: "Evidence dossier: snapshot, findings, backing (claim vs verified vs on-chain vs unknown), on-chain, liquidity + calculated price impact, 10 risks, source register." },
        { path: "POST /api/compare", price: PRICE_COMPARE, description: "Side-by-side table for up to 4 assets: identity, legal, backing, on-chain, liquidity, price, docs, unknowns. Never a winner." },
        { path: "GET /api/research/preview?symbol=AAPLx", price: PRICE_PREVIEW, description: "Capped preview: identity only, no fetches." },
      ],
    });
  });

  app.get("/openapi.json", (req: Request, res: Response) => {
    const base = `${req.protocol}://${req.get("host")}`;
    const symbolSchema = { type: "object", properties: { symbol: { type: "string", example: "AAPLx" }, lang: { type: "string", enum: ["en", "zh", "es", "fr"] } }, required: ["symbol"] };
    const researchSchema = { type: "object", properties: { symbol: { type: "string", example: "AAPLx" }, focus: { type: "string", enum: ["full", "issuer", "backing", "risks"] }, lang: { type: "string", enum: ["en", "zh", "es", "fr"] } }, required: ["symbol"] };
    const compareSchema = { type: "object", properties: { symbols: { type: "array", items: { type: "string" }, example: ["AAPLx", "TSLAx"] }, lang: { type: "string", enum: ["en", "zh", "es", "fr"] } }, required: ["symbols"] };
    const asJson = (schema: unknown) => ({ content: { "application/json": { schema } } });
    res.json({
      openapi: "3.0.0",
      info: { title: "Uzam RWA Intelligence API", version: "0.1.0", description: "Evidence-backed research on xStocks tokenized equities (X Layer 196). Identify free, depth paid via x402." },
      servers: [{ url: base }],
      paths: {
        "/api/identify": { post: { summary: `Identity check, no market data (${PRICE_IDENTIFY} via x402 when configured)`, requestBody: asJson(symbolSchema) } },
        "/api/research": { post: { summary: `Full report (${PRICE_RESEARCH} via x402)`, requestBody: asJson(researchSchema) } },
        "/api/compare": { post: { summary: `Compare up to 4 (${PRICE_COMPARE} via x402)`, requestBody: asJson(compareSchema) } },
        "/api/research/preview": { get: { summary: `Capped preview, identity only (${PRICE_PREVIEW} via x402 when configured)` } },
        "/api/receipts": { get: { summary: "Public log of recent paid-route calls" } },
      },
    });
  });

  app.get("/llms.txt", (_req: Request, res: Response) => {
    res.type("text/plain").send(
      `# Uzam — RWA intelligence for xStocks on X Layer (chain 196)\n` +
      `Paid (x402, USDT0 on X Layer): POST /api/identify (${PRICE_IDENTIFY}) → 60-second identity check, verification checks, unknowns. POST /api/research (${PRICE_RESEARCH}) → evidence dossier with backing evidence, onchain, 10 risks, source register. POST /api/compare (${PRICE_COMPARE}) → side-by-side table, up to 4 assets. GET /api/research/preview?symbol=AAPLx (${PRICE_PREVIEW}, identity only).\n` +
      `MCP (free): POST /mcp → tools identify_asset, analyze_onchain, analyze_backing, research_asset, compare_assets.\n` +
      `Supported: ${supportedSymbols().join(", ")}. Never guesses; unknowns stated, never "safe".\n`
    );
  });

  // Capped preview: identity only, zero external fetches. Paid when configured.
  app.get("/api/research/preview", (req: Request, res: Response) => {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "";
    const langRaw: unknown = req.query.lang;
    if (!symbol.trim() || !TICKER.test(symbol.trim())) {
      res.status(400).json({ ok: false, error: "invalid symbol: 1-20 ticker characters" });
      return;
    }
    if (langRaw !== undefined && (typeof langRaw !== "string" || !LANG_RE.test(langRaw.trim().toLowerCase()))) {
      res.status(400).json({ ok: false, error: "invalid lang: en|zh|es|fr" });
      return;
    }
    const lang = typeof langRaw === "string" ? langRaw : undefined;
    researchAsset(symbol, "issuer", { lang })
      .then((result) => res.json({ ok: true, preview: true, data: result }))
      .catch((e: unknown) => {
        console.error("preview failed:", e instanceof Error ? e.message : String(e));
        if (!res.headersSent) res.status(500).json({ ok: false, error: "preview_unavailable" });
      });
  });

  app.get("/api/receipts", (_req: Request, res: Response) => {
    res.json({ ok: true, receipts });
  });

  // One-click agent install: paste into Claude Desktop / Cursor MCP config.
  app.get("/install", (req: Request, res: Response) => {
    const base = `${req.protocol}://${req.get("host")}`;
    res.type("text/plain").send(
      `# Uzam MCP — add to Claude Desktop (claude_desktop_config.json) or Cursor (~/.cursor/mcp.json):\n` +
      `{\n  "mcpServers": {\n    "uzam": { "url": "${base}/mcp" }\n  }\n}\n` +
      `# Then ask: "Use Uzam to compare AAPLx vs TSLAx backing and biggest unanswered risks."\n` +
      `# REST (paid via x402 when configured — identify ${PRICE_IDENTIFY}, preview ${PRICE_PREVIEW}, research ${PRICE_RESEARCH}, compare ${PRICE_COMPARE}): see ${base}/.well-known/x402\n`
    );
  });

  const on = paywall !== null;
  return on
    ? { paid: true, reason: `charging ${PRICE_RESEARCH}/research + ${PRICE_COMPARE}/compare` }
    : { paid: false, reason: "free mode (set PAY_TO_ADDRESS + OKX creds to charge)" };
}
