import WebSocket from "ws";
import { log } from "./logger.js";

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

  private connectCoinbase(): void {
    if (this.stopped) return;

    const ws = new WebSocket(COINBASE_WS);
    this.coinbaseWs = ws;

    ws.on("open", () => {
      log("info", { source: "coinbase", event: "connected" });
      ws.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: ["BTC-USD", "ETH-USD"],
          channel: "market_trades",
        })
      );
    });

    ws.on("message", (raw: Buffer) => {
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
              this.emit({ symbol, price, timestamp: Date.now(), source: "coinbase" });
            }
          }
        }
      } catch {
        // ignore malformed
      }
    });

    ws.on("error", (err: Error) => {
      log("warn", { source: "coinbase", event: "error", message: err.message });
    });

    ws.on("close", () => {
      if (this.stopped) return;
      log("info", { source: "coinbase", event: "reconnecting" });
      setTimeout(() => this.connectCoinbase(), 5000);
    });
  }
}
