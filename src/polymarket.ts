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

const GRAPHQL_QUERY = `
query OpenContracts($symbol: String!) {
  markets(
    where: {
      active: true,
      closed: false,
      question_contains: $symbol
    },
    orderBy: endDate,
    orderDirection: asc
  ) {
    id
    question
    endDate
    outcomePrices
    outcomes
  }
}
`;

function parseDirection(question: string): "up" | "down" | null {
  const q = question.toLowerCase();
  if (q.includes("higher") || q.includes("above") || q.includes("exceed")) return "up";
  if (q.includes("lower") || q.includes("below") || q.includes("drop") || q.includes("fall")) return "down";
  return null;
}

export async function fetchContracts(symbol: "BTC" | "ETH"): Promise<Contract[]> {
  const now = Date.now();
  const maxExpiry = now + 20 * 60 * 1000; // 20 min from now

  try {
    const res = await fetch(`${GAMMA_API}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: GRAPHQL_QUERY,
        variables: { symbol },
      }),
    });

    if (!res.ok) {
      log("warn", { source: "polymarket", event: "graphql_error", status: res.status });
      return [];
    }

    const data = (await res.json()) as {
      data?: {
        markets?: Array<{
          id: string;
          question: string;
          endDate: string;
          outcomePrices: string[];
          outcomes: string[];
        }>;
      };
    };

    const markets = data?.data?.markets ?? [];
    const contracts: Contract[] = [];

    for (const m of markets) {
      const expiresAt = new Date(m.endDate).getTime();
      if (expiresAt > maxExpiry || expiresAt < now) continue;

      const direction = parseDirection(m.question);
      if (!direction) continue;

      const prices = m.outcomePrices?.map(Number) ?? [0.5, 0.5];
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
