import { FeedManager } from "./feeds.js";
import { SignalEngine } from "./signal.js";
import { fetchContracts, fetchRecentTrades, detectWhaleFade, placeOrder } from "./polymarket.js";
import { analyzeTradeOpportunity } from "./claude.js";
import { simulateMarket, computeHighConfidenceEdge } from "./simulate.js";
import type { SimulationResult } from "./simulate.js";
import { RiskManager } from "./kelly.js";
import { log } from "./logger.js";

const CLAUDE_CONFIDENCE_THRESHOLD = 0.65;
const INITIAL_BALANCE = 1000; // paper trading starts with $1000
const SIGNAL_COOLDOWN_MS = 60_000; // don't re-fire same symbol within 1 min
const SIM_MIN_VOLUME = 50_000; // 24h volume threshold for simulation
const SIM_MIN_ODDS = 0.15;     // skip simulation near certainty
const SIM_MAX_ODDS = 0.85;
const SIM_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // re-run sim at most every 2h per market

export class TradingDaemon {
  private feeds = new FeedManager();
  private signals = new SignalEngine();
  private risk = new RiskManager(INITIAL_BALANCE);
  private paperMode: boolean;
  private lastSignal: Map<string, number> = new Map();
  private dayResetTimer: NodeJS.Timeout | null = null;
  private simCache: Map<string, { lastRunAt: number; result: SimulationResult }> = new Map();

  constructor(paperMode = true) {
    this.paperMode = paperMode;
    log("info", { event: "daemon_start", paperMode, balance: INITIAL_BALANCE });
  }

  start(): void {
    this.feeds.onPrice(async (tick) => {
      const signal = this.signals.addTick(tick);
      if (!signal) return;

      // Cooldown check
      const lastFired = this.lastSignal.get(signal.symbol) ?? 0;
      if (Date.now() - lastFired < SIGNAL_COOLDOWN_MS) return;

      // Risk limits
      const limits = this.risk.checkLimits();
      if (!limits.ok) {
        log("warn", { event: "trading_halted", reason: limits.reason });
        this.stop();
        return;
      }

      this.lastSignal.set(signal.symbol, Date.now());

      log("info", {
        event: "signal_fired",
        symbol: signal.symbol,
        direction: signal.direction,
        momentum: (signal.momentum * 100).toFixed(3) + "%",
        price: signal.currentPrice,
      });

      // Find matching contracts
      const contracts = await fetchContracts(signal.symbol);
      const matching = contracts.filter((c) => c.direction === signal.direction);

      if (matching.length === 0) {
        log("info", { event: "no_matching_contracts", symbol: signal.symbol });
        return;
      }

      // Process best contract (closest expiry)
      const contract = matching.sort((a, b) => a.expiresAt - b.expiresAt)[0];

      // Whale fade detection
      const recentTrades = await fetchRecentTrades(contract.id, { limit: 20 });
      const whaleFade = detectWhaleFade(recentTrades);

      // Mini multi-agent simulation (trigger when odds are uncertain and not recently run)
      const odds = contract.yesPrice;
      const cached = this.simCache.get(contract.id);
      const simStale = !cached || Date.now() - cached.lastRunAt > SIM_CACHE_TTL_MS;
      const oddsInRange = odds >= SIM_MIN_ODDS && odds <= SIM_MAX_ODDS;

      let simResult: SimulationResult | null = null;
      if (oddsInRange && simStale) {
        simResult = await simulateMarket(contract.question, odds).catch(() => null);
        if (simResult) {
          this.simCache.set(contract.id, { lastRunAt: Date.now(), result: simResult });
        }
      } else if (cached) {
        simResult = cached.result;
      }

      const simulationGap = simResult
        ? parseFloat(((simResult.consensus - odds) * 100).toFixed(1))
        : null;

      const highConfidenceEdge = computeHighConfidenceEdge(
        whaleFade,
        simResult ? simResult.consensus : null,
        odds
      );

      if (highConfidenceEdge) {
        log("info", {
          event: "high_confidence_edge",
          symbol: signal.symbol,
          contract: contract.question,
          whaleFadeDirection: whaleFade?.direction,
          simulationGapPp: simulationGap,
        });
      }

      // Ask Claude for analysis (with extra context)
      const analysis = await analyzeTradeOpportunity(signal, contract, {
        whaleFade,
        simulationGap,
        highConfidenceEdge,
      });
      if (!analysis) return;

      if (!analysis.enter || analysis.confidence < CLAUDE_CONFIDENCE_THRESHOLD) {
        log("info", {
          event: "trade_skipped",
          reason: "claude_confidence_below_threshold",
          confidence: analysis.confidence,
          threshold: CLAUDE_CONFIDENCE_THRESHOLD,
          reasoning: analysis.reasoning,
        });
        return;
      }

      // Size the position
      const price = contract.yesPrice;
      const size = this.risk.sizePosition(analysis.kelly_fraction, price);

      if (size <= 0) {
        log("info", { event: "trade_skipped", reason: "zero_size" });
        return;
      }

      log("trade", {
        event: "entering_trade",
        symbol: signal.symbol,
        contract: contract.question,
        direction: signal.direction,
        size,
        price,
        confidence: analysis.confidence,
        kellyFraction: analysis.kelly_fraction,
        reasoning: analysis.reasoning,
        expiresAt: new Date(contract.expiresAt).toISOString(),
        paperMode: this.paperMode,
      });

      await placeOrder(contract, "YES", size, price, this.paperMode);
    });

    this.feeds.start();

    // Reset daily P&L at midnight
    this.scheduleDayReset();

    log("info", { event: "feeds_started" });
  }

  stop(): void {
    this.feeds.stop();
    if (this.dayResetTimer) clearTimeout(this.dayResetTimer);
    log("info", { event: "daemon_stopped" });
  }

  private scheduleDayReset(): void {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const msUntilMidnight = midnight.getTime() - now.getTime();

    this.dayResetTimer = setTimeout(() => {
      this.risk.resetDay();
      this.scheduleDayReset();
    }, msUntilMidnight);
  }
}
