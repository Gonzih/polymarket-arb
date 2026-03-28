import type { PriceTick } from "./feeds.js";
import { log } from "./logger.js";

export type MomentumSignal = {
  symbol: "BTC" | "ETH";
  direction: "up" | "down";
  momentum: number; // % change, signed
  currentPrice: number;
  recentTicks: number[];
  timestamp: number;
};

const WINDOW_MS = 30_000; // 30 seconds
const MOMENTUM_THRESHOLD = 0.0035; // 0.35%
const MAX_TICKS = 20; // keep last N ticks per symbol for history

const DEBUG_HEARTBEAT_MS = 5 * 60_000; // 5 minutes

export class SignalEngine {
  private ticks: Map<string, PriceTick[]> = new Map();
  private lastDebugAt: Map<string, number> = new Map();

  addTick(tick: PriceTick): MomentumSignal | null {
    const key = tick.symbol;
    if (!this.ticks.has(key)) this.ticks.set(key, []);
    const arr = this.ticks.get(key)!;
    arr.push(tick);

    // trim to keep only recent + last MAX_TICKS
    const cutoff = Date.now() - WINDOW_MS * 2;
    while (arr.length > 0 && arr[0].timestamp < cutoff && arr.length > MAX_TICKS) {
      arr.shift();
    }

    return this.evaluate(tick.symbol);
  }

  private evaluate(symbol: "BTC" | "ETH"): MomentumSignal | null {
    const arr = this.ticks.get(symbol);
    if (!arr || arr.length < 2) return null;

    const now = Date.now();
    const windowStart = now - WINDOW_MS;
    const recent = arr.filter((t) => t.timestamp >= windowStart);
    const all = arr.slice(-MAX_TICKS);

    if (recent.length < 2) return null;

    const oldest = recent[0].price;
    const newest = recent[recent.length - 1].price;
    const momentum = (newest - oldest) / oldest;

    if (Math.abs(momentum) < MOMENTUM_THRESHOLD) {
      const lastDebug = this.lastDebugAt.get(symbol) ?? 0;
      if (now - lastDebug >= DEBUG_HEARTBEAT_MS) {
        log("info", { event: "signal_evaluated", symbol, momentum, threshold: MOMENTUM_THRESHOLD, fired: false });
        this.lastDebugAt.set(symbol, now);
      }
      return null;
    }

    return {
      symbol,
      direction: momentum > 0 ? "up" : "down",
      momentum,
      currentPrice: newest,
      recentTicks: all.map((t) => t.price).slice(-5),
      timestamp: now,
    };
  }

  getRecentTicks(symbol: "BTC" | "ETH", n = 5): number[] {
    const arr = this.ticks.get(symbol) ?? [];
    return arr.slice(-n).map((t) => t.price);
  }
}
