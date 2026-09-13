// x402 paid routes — the cash register.
// Free discovery stays free (/mcp, /api/identify). The two heavy reports cost
// $3 per call in USDT0 on X Layer, enforced by OKX's payment middleware:
// unpaid calls get HTTP 402 + PAYMENT-REQUIRED, paid calls run the engines.
// Without PAY_TO_ADDRESS (or without OKX facilitator creds) the routes stay
// free and log a warning — never half-enforced.

import type { Express, Request, Response, RequestHandler } from "express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { loadOkxConfig } from "../okx/adapter.js";
import { researchAsset, compareAssets, findAsset, supportedSymbols } from "../research/engines.js";

const NETWORK = "eip155:196";
export const PRICE_RESEARCH = "$2.00";
export const PRICE_COMPARE = "$2.00";

function usage(route: string, detail: string, req: Request): void {
  const x402 = (req as unknown as Record<string, unknown>).x402 as
    | { settleResult?: unknown; payment?: unknown }
    | undefined;
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      paid_route: route,
      detail,
      settled: !!x402,
      ip: req.ip ?? null,
    })
  );
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
      console.log(`[x402] paywall ON — research ${PRICE_RESEARCH}, compare ${PRICE_COMPARE} -> ${payTo}`);
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

  const runResearch = async (req: Request, res: Response): Promise<void> => {
    const symbol = typeof req.body?.symbol === "string" ? req.body.symbol : "";
    const focus = typeof req.body?.focus === "string" ? req.body.focus : "full";
    usage("research", symbol, req);
    const result = await researchAsset(symbol, focus === "issuer" || focus === "backing" || focus === "risks" ? focus : "full");
    res.json({ ok: true, data: result });
  };

  const runCompare = async (req: Request, res: Response): Promise<void> => {
    const symbols = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
    usage("compare", symbols.join(","), req);
    const result = await compareAssets(symbols);
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
        issuer: asset.issuer, underlying_asset: asset.underlying_asset,
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

  const on = paywall !== null;
  return on
    ? { paid: true, reason: `charging ${PRICE_RESEARCH}/research + ${PRICE_COMPARE}/compare` }
    : { paid: false, reason: "free mode (set PAY_TO_ADDRESS + OKX creds to charge)" };
}
