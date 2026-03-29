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
const MOMENTUM_THRESHOLD = 0.015; // 1.5% (raised from 0.35% to reduce noise)
const MAX_TICKS = 200; // keep enough ticks for rolling volume average
const ROLLING_WINDOW_MS = 5 * 60_000; // 5 minutes
const ROLLING_WINDOWS = ROLLING_WINDOW_MS / WINDOW_MS; // 10 windows
const VOLUME_MULTIPLIER = 3; // fire only if current-window ticks > 3x rolling avg
const COOLDOWN_MS = 5 * 60_000; // 5 minutes per-direction cooldown

const DEBUG_HEARTBEAT_MS = 5 * 60_000; // 5 minutes

type LastSignal = { direction: "up" | "down"; timestamp: number };

export class SignalEngine {
  private ticks: Map<string, PriceTick[]> = new Map();
  private lastDebugAt: Map<string, number> = new Map();
  private lastSignal: Map<string, LastSignal> = new Map();

  addTick(tick: PriceTick): MomentumSignal | null {
    const key = tick.symbol;
    if (!this.ticks.has(key)) this.ticks.set(key, []);
    const arr = this.ticks.get(key)!;
    arr.push(tick);

    // trim: keep enough history for rolling volume average (5 min × 2)
    const cutoff = Date.now() - ROLLING_WINDOW_MS * 2;
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

    // Volume confirmation: only fire if current-window tick count > 3x rolling average.
    // Skip this check when history is too thin (avg < 1 tick/window) to avoid blocking
    // signals at startup.
    const rollingStart = now - ROLLING_WINDOW_MS;
    const rollingTickCount = arr.filter((t) => t.timestamp >= rollingStart).length;
    const rollingAvg = rollingTickCount / ROLLING_WINDOWS;
    if (rollingAvg >= 1 && recent.length <= VOLUME_MULTIPLIER * rollingAvg) {
      return null;
    }

    // Cooldown: suppress same-direction signal within 5 minutes
    const direction: "up" | "down" = momentum > 0 ? "up" : "down";
    const last = this.lastSignal.get(symbol);
    if (last && last.direction === direction && now - last.timestamp < COOLDOWN_MS) {
      return null;
    }

    this.lastSignal.set(symbol, { direction, timestamp: now });

    return {
      symbol,
      direction,
      momentum,
      currentPrice: newest,
      recentTicks: arr.slice(-5).map((t) => t.price),
      timestamp: now,
    };
  }

  getRecentTicks(symbol: "BTC" | "ETH", n = 5): number[] {
    const arr = this.ticks.get(symbol) ?? [];
    return arr.slice(-n).map((t) => t.price);
  }
}
