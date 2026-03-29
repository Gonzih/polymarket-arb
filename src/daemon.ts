import { FeedManager } from "./feeds.js";
import { SignalEngine } from "./signal.js";
import { fetchContracts, fetchRecentTrades, detectWhaleFade, placeOrder } from "./polymarket.js";
import { analyzeTradeOpportunity } from "./claude.js";
import { simulateMarket, computeHighConfidenceEdge } from "./simulate.js";
import type { SimulationResult } from "./simulate.js";
import {
  runSimulation,
  shouldRunSimulation,
  kellyAdjustment,
  logSimulationResult,
} from "./simulationSignal.js";
import type { SimulationResult as DebateSimulationResult } from "./simulationSignal.js";
import { RiskManager } from "./kelly.js";
import { log } from "./logger.js";
import { NewsPoller } from "./newsPoller.js";
import { ReportCollector } from "./report.js";

const CLAUDE_CONFIDENCE_THRESHOLD = 0.65;
const INITIAL_BALANCE = 1000; // paper trading starts with $1000
const SIGNAL_COOLDOWN_MS = 60_000; // don't re-fire same symbol within 1 min
const NEWS_BOOST_WINDOW_MS = 120_000; // 2 minutes: boost signal if news within this window
const NEWS_BOOST_MULTIPLIER = 1.5;
const SIM_MIN_VOLUME = 50_000; // 24h volume threshold for simulation
const SIM_MIN_ODDS = 0.15;     // skip simulation near certainty
const SIM_MAX_ODDS = 0.85;
const SIM_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // re-run sim at most every 2h per market

// Debate simulation constants
const DEBATE_WHALE_THRESHOLD = 100_000; // run debate simulation on whale trades >= $100k
const DEBATE_ODDS_DELTA_THRESHOLD = 0.07; // 7% odds change triggers debate simulation
const DEBATE_SCHEDULE_MIN_MS = 4 * 60 * 60 * 1000; // 4h minimum
const DEBATE_SCHEDULE_MAX_MS = 6 * 60 * 60 * 1000; // 6h maximum

export class TradingDaemon {
  private feeds = new FeedManager();
  private signals = new SignalEngine();
  private risk = new RiskManager(INITIAL_BALANCE);
  private paperMode: boolean;
  private lastSignal: Map<string, number> = new Map();
  private dayResetTimer: NodeJS.Timeout | null = null;
  private simCache: Map<string, { lastRunAt: number; result: SimulationResult }> = new Map();

  // Debate simulation state
  private lastDebateSimAt: Map<string, number> = new Map();
  private lastMarketOdds: Map<string, number> = new Map();
  private debateScheduleTimer: NodeJS.Timeout | null = null;
  private activeMarkets: Map<string, { question: string; odds: number; volume: number; hoursToResolution: number }> = new Map();

  // News + report
  private newsPoller = new NewsPoller();
  private reporter = new ReportCollector();

  constructor(paperMode = true) {
    this.paperMode = paperMode;
    log("info", { event: "daemon_start", paperMode, balance: INITIAL_BALANCE });
  }

  start(): void {
    this.newsPoller.start();
    this.reporter.start();

    this.feeds.onPrice(async (tick) => {
      const signalAt = Date.now();
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

      // News confidence boost: check if any recent news event fired within 2 min
      const recentNews = this.newsPoller.getRecentEvents(NEWS_BOOST_WINDOW_MS);
      const newsBoost = recentNews.length > 0;
      let signalConfidenceMultiplier = 1.0;
      if (newsBoost) {
        signalConfidenceMultiplier = NEWS_BOOST_MULTIPLIER;
        const topNews = recentNews[recentNews.length - 1];
        log("info", {
          event: "news_boost",
          headline: topNews.headline,
          signalConfidenceMultiplier,
        });
      }

      log("info", {
        event: "signal_fired",
        symbol: signal.symbol,
        direction: signal.direction,
        momentum: (signal.momentum * 100).toFixed(3) + "%",
        price: signal.currentPrice,
        newsBoost,
      });

      // Record signal for daily report
      this.reporter.recordSignal(newsBoost);

      // Find matching contracts — measure latency from signal detection to CLOB query
      const contracts = await fetchContracts(signal.symbol);
      const oddsCheckedAt = Date.now();
      const latencyMs = oddsCheckedAt - signalAt;
      log("info", { event: "latency", "signal→odds check": `${latencyMs}ms`, latencyMs });
      this.reporter.recordLatency(latencyMs);

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

      // Track this market for scheduled debate simulations
      const hoursToResolution = Math.max(0, (contract.expiresAt - Date.now()) / 3_600_000);
      this.activeMarkets.set(contract.id, {
        question: contract.question,
        odds,
        volume: 0, // volume not available in Contract type; will be checked against threshold
        hoursToResolution,
      });

      // Check for odds delta trigger (>7% change since last observed)
      const lastOdds = this.lastMarketOdds.get(contract.id);
      const oddsDelta = lastOdds !== undefined ? Math.abs(odds - lastOdds) : 0;
      this.lastMarketOdds.set(contract.id, odds);

      // Run debate simulation on whale trade or odds delta
      let debateResult: DebateSimulationResult | null = null;
      if (whaleFade && whaleFade.size >= DEBATE_WHALE_THRESHOLD) {
        log("info", {
          event: "debate_sim_trigger",
          reason: "whale_trade",
          marketId: contract.id,
          whaleSize: whaleFade.size,
        });
        debateResult = await runSimulation({
          type: 'whale',
          marketId: contract.id,
          marketQuestion: contract.question,
          marketOdds: odds,
          volume: whaleFade.size,
          hoursToResolution,
        }).catch(() => null);
        if (debateResult) logSimulationResult(debateResult, contract.question);
      } else if (oddsDelta >= DEBATE_ODDS_DELTA_THRESHOLD) {
        log("info", {
          event: "debate_sim_trigger",
          reason: "odds_delta",
          marketId: contract.id,
          oddsDelta: parseFloat((oddsDelta * 100).toFixed(2)),
        });
        debateResult = await runSimulation({
          type: 'odds_delta',
          marketId: contract.id,
          marketQuestion: contract.question,
          marketOdds: odds,
          volume: 0,
          hoursToResolution,
        }).catch(() => null);
        if (debateResult) logSimulationResult(debateResult, contract.question);
      }

      // Apply Kelly adjustment from debate result
      let kellyMultiplier = 1.0;
      if (debateResult) {
        kellyMultiplier = kellyAdjustment(debateResult);
        if (kellyMultiplier === 0.0) {
          log("info", {
            event: "trade_skipped",
            reason: "debate_volatility_signal",
            marketId: contract.id,
            spread: debateResult.spread,
          });
          return;
        }
      }

      // Ask Claude for analysis (with extra context)
      const analysis = await analyzeTradeOpportunity(signal, contract, {
        whaleFade,
        simulationGap,
        highConfidenceEdge,
        simulation: debateResult ?? undefined,
      });
      if (!analysis) return;

      const boostedConfidence = Math.min(1.0, analysis.confidence * signalConfidenceMultiplier);
      if (!analysis.enter || boostedConfidence < CLAUDE_CONFIDENCE_THRESHOLD) {
        log("info", {
          event: "trade_skipped",
          reason: "claude_confidence_below_threshold",
          confidence: analysis.confidence,
          boostedConfidence,
          threshold: CLAUDE_CONFIDENCE_THRESHOLD,
          reasoning: analysis.reasoning,
        });
        return;
      }

      // Size the position (apply debate Kelly multiplier)
      const price = contract.yesPrice;
      const adjustedKelly = analysis.kelly_fraction * kellyMultiplier;
      const size = this.risk.sizePosition(adjustedKelly, price);

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
        boostedConfidence,
        newsBoost,
        kellyFraction: adjustedKelly,
        reasoning: analysis.reasoning,
        expiresAt: new Date(contract.expiresAt).toISOString(),
        paperMode: this.paperMode,
      });

      await placeOrder(contract, "YES", size, price, this.paperMode);
    });

    this.feeds.start();

    // Reset daily P&L at midnight
    this.scheduleDayReset();

    // Schedule periodic debate simulations (every 4-6h)
    this.scheduleDebateSimulation();

    log("info", { event: "feeds_started" });
  }

  stop(): void {
    this.feeds.stop();
    this.newsPoller.stop();
    this.reporter.stop();
    if (this.dayResetTimer) clearTimeout(this.dayResetTimer);
    if (this.debateScheduleTimer) clearTimeout(this.debateScheduleTimer);
    log("info", { event: "daemon_stopped" });
  }

  private scheduleDebateSimulation(): void {
    const jitter = DEBATE_SCHEDULE_MIN_MS +
      Math.random() * (DEBATE_SCHEDULE_MAX_MS - DEBATE_SCHEDULE_MIN_MS);

    this.debateScheduleTimer = setTimeout(async () => {
      log("info", { event: "debate_sim_scheduled_run", marketCount: this.activeMarkets.size });

      for (const [marketId, market] of this.activeMarkets.entries()) {
        if (!shouldRunSimulation(market.volume, market.hoursToResolution)) continue;

        const lastRun = this.lastDebateSimAt.get(marketId) ?? 0;
        if (Date.now() - lastRun < DEBATE_SCHEDULE_MIN_MS) continue;

        this.lastDebateSimAt.set(marketId, Date.now());
        const result = await runSimulation({
          type: 'scheduled',
          marketId,
          marketQuestion: market.question,
          marketOdds: market.odds,
          volume: market.volume,
          hoursToResolution: market.hoursToResolution,
        }).catch(() => null);

        if (result) logSimulationResult(result, market.question);
      }

      // Reschedule
      this.scheduleDebateSimulation();
    }, jitter);
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
