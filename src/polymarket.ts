import { log } from "./logger.js";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

export type Contract = {
  id: string;
  question: string;
  expiresAt: number; // unix ms
  yesPrice: number; // 0-1
  noPrice: number;  // 0-1
  symbol: "BTC" | "ETH";
  direction: "up" | "down";
};

export type OrderResult = {
  orderId: string;
  status: string;
};

export type TradeEvent = {
  size: number;      // USDC notional
  side: 'buy' | 'sell';
  price: number;
  timestamp: number; // unix ms
};

export type WhaleFadeSignal = {
  direction: 'buy' | 'sell'; // fade direction (opposite of whale)
  size: number;
  minutesAgo: number;
};

type RawTrade = {
  size: string | number;
  side: string;
  price: string | number;
  timestamp: string | number;
};

export async function fetchRecentTrades(
  marketId: string,
  opts: { limit: number } = { limit: 20 }
): Promise<TradeEvent[]> {
  try {
    const url = `${CLOB_API}/trades?market=${encodeURIComponent(marketId)}&limit=${opts.limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const raw = (await res.json()) as RawTrade[] | { data: RawTrade[] };
    const trades = Array.isArray(raw) ? raw : (raw.data ?? []);
    return trades.map((t) => {
      const ts = Number(t.timestamp);
      return {
        size: Number(t.size),
        side: String(t.side).toUpperCase() === "BUY" ? "buy" : "sell",
        price: Number(t.price),
        // CLOB timestamps are Unix seconds; convert to ms if needed
        timestamp: ts < 1e12 ? ts * 1000 : ts,
      };
    });
  } catch {
    return [];
  }
}

export function detectWhaleFade(trades: TradeEvent[]): WhaleFadeSignal | null {
  const whaleTrades = trades.filter((t) => t.size > 10_000);
  if (whaleTrades.length === 0) return null;

  const lastWhale = whaleTrades[0];
  const timeSince = Date.now() - lastWhale.timestamp;
  if (timeSince >= 30 * 60 * 1000) return null;

  const signal: WhaleFadeSignal = {
    direction: lastWhale.side === "buy" ? "sell" : "buy",
    size: lastWhale.size,
    minutesAgo: Math.round(timeSince / 60_000),
  };

  log("info", {
    source: "polymarket",
    event: "whale_fade_signal",
    whaleSize: lastWhale.size,
    whaleSide: lastWhale.side,
    fadeDirection: signal.direction,
    minutesAgo: signal.minutesAgo,
  });

  return signal;
}

type RestMarket = {
  id: string;
  question: string;
  endDate: string;
  outcomePrices: string | string[];
  outcomes: string | string[];
  active: boolean;
  closed: boolean;
};

function parseJsonField(field: string | string[]): string[] {
  if (Array.isArray(field)) return field;
  try { return JSON.parse(field); } catch { return []; }
}

function parseDirection(question: string): "up" | "down" | null {
  const q = question.toLowerCase();
  if (q.includes("higher") || q.includes("above") || q.includes("exceed")) return "up";
  if (q.includes("lower") || q.includes("below") || q.includes("drop") || q.includes("fall")) return "down";
  return null;
}

export async function fetchContracts(symbol: "BTC" | "ETH"): Promise<Contract[]> {
  const now = Date.now();
  const maxExpiry = now + 20 * 60 * 1000; // 20 min from now

  const symbolKeywords: Record<"BTC" | "ETH", string[]> = {
    BTC: ["BTC", "Bitcoin", "bitcoin"],
    ETH: ["ETH", "Ethereum", "ethereum"],
  };

  try {
    const url = `${GAMMA_API}/markets?active=true&closed=false&limit=200`;
    const res = await fetch(url);

    if (!res.ok) {
      log("warn", { source: "polymarket", event: "rest_error", status: res.status });
      return [];
    }

    const markets = (await res.json()) as RestMarket[];
    const keywords = symbolKeywords[symbol];
    const contracts: Contract[] = [];

    for (const m of markets) {
      if (!keywords.some((k) => m.question?.includes(k))) continue;

      const expiresAt = new Date(m.endDate).getTime();
      if (expiresAt > maxExpiry || expiresAt < now) continue;

      const direction = parseDirection(m.question);
      if (!direction) continue;

      const prices = parseJsonField(m.outcomePrices).map(Number);
      contracts.push({
        id: m.id,
        question: m.question,
        expiresAt,
        yesPrice: prices[0] ?? 0.5,
        noPrice: prices[1] ?? 0.5,
        symbol,
        direction,
      });
    }

    return contracts;
  } catch (err) {
    log("warn", { source: "polymarket", event: "fetch_error", error: String(err) });
    return [];
  }
}

export async function placeOrder(
  contract: Contract,
  side: "YES" | "NO",
  size: number,
  price: number,
  paperMode: boolean
): Promise<OrderResult | null> {
  const order = {
    marketId: contract.id,
    side,
    size,
    price,
    orderType: "LIMIT",
  };

  if (paperMode) {
    log("trade", {
      event: "paper_order",
      contract: contract.question,
      side,
      size,
      price,
      expiresAt: new Date(contract.expiresAt).toISOString(),
    });
    return { orderId: `paper-${Date.now()}`, status: "paper" };
  }

  const apiKey = process.env.POLYMARKET_API_KEY;
  const secret = process.env.POLYMARKET_SECRET;
  if (!apiKey || !secret) {
    log("error", { event: "missing_creds", message: "POLYMARKET_API_KEY and POLYMARKET_SECRET required for live trading" });
    return null;
  }

  try {
    const res = await fetch(`${CLOB_API}/order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Secret": secret,
      },
      body: JSON.stringify(order),
    });

    if (!res.ok) {
      log("error", { source: "polymarket", event: "order_error", status: res.status });
      return null;
    }

    const result = (await res.json()) as OrderResult;
    log("trade", { event: "order_placed", orderId: result.orderId, ...order });
    return result;
  } catch (err) {
    log("error", { source: "polymarket", event: "order_exception", error: String(err) });
    return null;
  }
}
