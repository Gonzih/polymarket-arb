import WebSocket from "ws";
import { log } from "./logger.js";

// ---------------------------------------------------------------------------
// Dune Analytics stub
// ---------------------------------------------------------------------------
// CLOB /trades?market=<token> requires authentication (returns 401 without API
// key). Dune Analytics is the recommended path for historical Polymarket trade
// reconstruction. This stub has the correct API structure and will be activated
// once DUNE_API_KEY is set in the environment.

const DUNE_API_BASE = "https://api.dune.com/api/v1";

export type DuneRow = Record<string, unknown>;

export async function duneFeed(queryId: number): Promise<DuneRow[]> {
  const apiKey = process.env.DUNE_API_KEY;
  if (!apiKey) {
    log("info", { source: "dune", event: "no_api_key", message: "no API key configured, skipping" });
    return [];
  }

  const url = `${DUNE_API_BASE}/query/${queryId}/results?limit=1000`;
  const res = await fetch(url, {
    headers: { "X-Dune-API-Key": apiKey },
  });

  if (!res.ok) {
    log("warn", { source: "dune", event: "fetch_error", status: res.status, queryId });
    return [];
  }

  const data = (await res.json()) as { result?: { rows?: DuneRow[] } };
  return data.result?.rows ?? [];
}

export type PriceTick = {
  symbol: "BTC" | "ETH";
  price: number;
  timestamp: number;
  source: "binance" | "coinbase";
};

export type PriceUpdateHandler = (tick: PriceTick) => void;

const BINANCE_WS =
  "wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1m/ethusdt@kline_1m";
const COINBASE_WS = "wss://advanced-trade-ws.coinbase.com";

// Retry Binance every 6 hours after 451 block
const BINANCE_RETRY_MS = 6 * 60 * 60 * 1000;

export class FeedManager {
  private handlers: PriceUpdateHandler[] = [];
  private binanceWs: WebSocket | null = null;
  private coinbaseWs: WebSocket | null = null;
  private binanceBlocked = false;
  private binanceRetryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private coinbaseLastMessageAt = 0;
  private coinbaseHeartbeatTimer: NodeJS.Timeout | null = null;
  private totalTicks = 0;
  private lastBtcPrice = 0;
  private lastEthPrice = 0;
  private lastTickHeartbeatAt = 0;

  onPrice(handler: PriceUpdateHandler): void {
    this.handlers.push(handler);
  }

  private emit(tick: PriceTick): void {
    for (const h of this.handlers) h(tick);
  }

  start(): void {
    this.connectBinance();
    this.connectCoinbase();
  }

  stop(): void {
    this.stopped = true;
    if (this.binanceRetryTimer) clearTimeout(this.binanceRetryTimer);
    if (this.coinbaseHeartbeatTimer) clearInterval(this.coinbaseHeartbeatTimer);
    this.binanceWs?.close();
    this.coinbaseWs?.close();
  }

  private connectBinance(): void {
    if (this.stopped || this.binanceBlocked) return;

    const ws = new WebSocket(BINANCE_WS);
    this.binanceWs = ws;

    ws.on("open", () => {
      log("info", { source: "binance", event: "connected" });
    });

    ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        const stream: string = msg.stream ?? "";
        const kline = msg.data?.k;
        if (!kline || !kline.x) return; // not closed candle — use last close price anyway
        const symbol: "BTC" | "ETH" = stream.startsWith("btc") ? "BTC" : "ETH";
        const price = parseFloat(kline.c);
        this.emit({ symbol, price, timestamp: Date.now(), source: "binance" });
      } catch {
        // ignore malformed
      }
    });

    ws.on("error", (err: Error & { code?: string }) => {
      // Check for 451 geo-block
      if (err.message?.includes("451") || (err as NodeJS.ErrnoException).code === "451") {
        log("warn", { source: "binance", event: "geo_blocked_451", message: err.message });
        this.binanceBlocked = true;
        ws.close();
        this.scheduleBindanceRetry();
      } else {
        log("warn", { source: "binance", event: "error", message: err.message });
      }
    });

    ws.on("unexpected-response", (_req: unknown, res: { statusCode: number }) => {
      if (res.statusCode === 451) {
        log("warn", { source: "binance", event: "geo_blocked_451", statusCode: 451 });
        this.binanceBlocked = true;
        ws.close();
        this.scheduleBindanceRetry();
      }
    });

    ws.on("close", () => {
      if (this.stopped || this.binanceBlocked) return;
      log("info", { source: "binance", event: "reconnecting" });
      setTimeout(() => this.connectBinance(), 5000);
    });
  }

  private scheduleBindanceRetry(): void {
    log("info", { source: "binance", event: "retry_scheduled_6h" });
    this.binanceRetryTimer = setTimeout(() => {
      this.binanceBlocked = false;
      this.connectBinance();
    }, BINANCE_RETRY_MS);
  }

  private startCoinbaseHeartbeat(): void {
    if (this.coinbaseHeartbeatTimer) clearInterval(this.coinbaseHeartbeatTimer);
    this.coinbaseHeartbeatTimer = setInterval(() => {
      if (this.stopped) return;
      const staleMs = Date.now() - this.coinbaseLastMessageAt;
      if (this.coinbaseLastMessageAt > 0 && staleMs > 90_000) {
        log("info", { source: "coinbase", event: "coinbase:reconnecting", reason: "no_message_90s", staleMs });
        this.coinbaseWs?.close();
      }
    }, 60_000);
  }

  private connectCoinbase(): void {
    if (this.stopped) return;

    const ws = new WebSocket(COINBASE_WS);
    this.coinbaseWs = ws;

    ws.on("open", () => {
      log("info", { source: "coinbase", event: "connected" });
      this.coinbaseLastMessageAt = Date.now();
      this.startCoinbaseHeartbeat();
      ws.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: ["BTC-USD", "ETH-USD"],
          channel: "market_trades",
        })
      );
    });

    ws.on("message", (raw: Buffer) => {
      this.coinbaseLastMessageAt = Date.now();
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.channel !== "market_trades") return;
        const events: Array<{ trades?: Array<{ product_id: string; price: string }> }> = msg.events ?? [];
        for (const event of events) {
          const trades = event.trades ?? [];
          for (const trade of trades) {
            const symbol: "BTC" | "ETH" = trade.product_id.startsWith("BTC") ? "BTC" : "ETH";
            const price = parseFloat(trade.price);
            if (!isNaN(price)) {
              if (symbol === "BTC") this.lastBtcPrice = price;
              else this.lastEthPrice = price;
              this.totalTicks++;
              this.emit({ symbol, price, timestamp: Date.now(), source: "coinbase" });
            }
          }
        }
        // log heartbeat every 100 ticks or every 60 seconds
        const now = Date.now();
        if (this.totalTicks > 0 && (this.totalTicks % 100 === 0 || now - this.lastTickHeartbeatAt >= 60_000)) {
          log("info", { source: "coinbase", event: "tick_heartbeat", btcPrice: this.lastBtcPrice, ethPrice: this.lastEthPrice, tickCount: this.totalTicks });
          this.lastTickHeartbeatAt = now;
        }
      } catch {
        // ignore malformed
      }
    });

    ws.on("error", (err: Error) => {
      log("warn", { source: "coinbase", event: "error", message: err.message });
    });

    ws.on("close", () => {
      if (this.coinbaseHeartbeatTimer) clearInterval(this.coinbaseHeartbeatTimer);
      if (this.stopped) return;
      log("info", { source: "coinbase", event: "reconnecting" });
      setTimeout(() => this.connectCoinbase(), 5000);
    });
  }
}
