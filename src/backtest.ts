import { spawn } from "child_process";
import fs from "fs";
import { log } from "./logger.js";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

// Momentum parameters adapted for prediction market hourly price data
// (0-1 range, slower-moving than crypto ticks)
export const BACKTEST_WINDOW_HOURS = 4;
export const BACKTEST_MOMENTUM_THRESHOLD = 0.05; // 5% move over 4h

export type ResolvedMarket = {
  id: string;
  conditionId: string;
  clobTokenId: string;    // YES outcome token ID for CLOB price history
  question: string;
  volume: number;
  startDate: number;      // unix ms
  endDate: number;        // unix ms
  resolutionTime: number; // unix ms
  resolution: number;     // 1 = YES won, 0 = NO won
};

export type PricePoint = {
  t: number; // unix timestamp (seconds)
  p: number; // price 0-1
};

export type BacktestSignal = {
  firedAt: number;       // unix ms
  oddsAtSignal: number;  // 0-1
  direction: "YES" | "NO";
  momentum: number;      // signed pct
};

export type ClaudeDecision = "BUY_YES" | "BUY_NO" | "PASS" | "ERROR";

export type BacktestResult = {
  marketId: string;
  question: string;
  signalFiredAt: number;
  oddsAtSignal: number;
  claudeDecision: ClaudeDecision;
  claudeLatencyMs: number;
  actualResolution: number; // 0 or 1
  correct: boolean;
  kellySizePct: number;
  hypotheticalPnl: number; // fraction of bankroll
};

function parseJsonField(field: string | string[]): string[] {
  if (Array.isArray(field)) return field;
  try {
    return JSON.parse(field);
  } catch {
    return [];
  }
}

type RawMarket = {
  id: string;
  conditionId?: string;
  clobTokenIds?: string;  // JSON-encoded array of token IDs e.g. '["123...", "456..."]'
  question?: string;
  volume?: string | number;
  volumeNum?: number;
  startDate?: string;
  endDate?: string;
  resolutionTime?: string;
  closed?: boolean;
  resolved?: boolean;
  outcomePrices?: string | string[];
};

export async function fetchResolvedMarkets(limit = 100): Promise<ResolvedMarket[]> {
  const sixMonthsAgo = Date.now() - 180 * 24 * 60 * 60 * 1000;
  // Use end_date_min to fetch recent markets without scanning thousands of pages
  const sixMonthsAgoDate = new Date(sixMonthsAgo).toISOString().slice(0, 10);
  const results: ResolvedMarket[] = [];
  let offset = 0;
  const batchSize = 100;

  while (results.length < limit) {
    const url = `${GAMMA_API}/markets?closed=true&limit=${batchSize}&offset=${offset}&end_date_min=${sixMonthsAgoDate}`;
    let markets: RawMarket[];
    try {
      const res = await fetch(url);
      if (!res.ok) {
        log("warn", { source: "backtest", event: "fetch_resolved_error", status: res.status });
        break;
      }
      markets = (await res.json()) as RawMarket[];
    } catch (err) {
      log("warn", { source: "backtest", event: "fetch_resolved_exception", error: String(err) });
      break;
    }

    if (markets.length === 0) break;

    for (const m of markets) {
      const volume = Number(m.volumeNum ?? m.volume ?? 0);
      if (volume < 50_000) continue;

      const endDate = m.endDate ? new Date(m.endDate).getTime() : 0;
      if (endDate < sixMonthsAgo || endDate === 0) continue;

      // Only include cleanly resolved markets (YES price = 0 or 1)
      const prices = parseJsonField(m.outcomePrices ?? []).map(Number);
      if (prices.length < 2) continue;
      const yesPrice = prices[0];
      if (yesPrice !== 0 && yesPrice !== 1) continue;

      // Parse YES outcome clobTokenId for CLOB price history
      const tokenIds = parseJsonField(m.clobTokenIds ?? "[]");
      const clobTokenId = tokenIds[0] ?? "";

      results.push({
        id: m.id,
        conditionId: m.conditionId ?? m.id,
        clobTokenId,
        question: m.question ?? "",
        volume,
        startDate: m.startDate ? new Date(m.startDate).getTime() : 0,
        endDate,
        resolutionTime: m.resolutionTime ? new Date(m.resolutionTime).getTime() : endDate,
        resolution: yesPrice === 1 ? 1 : 0,
      });

      if (results.length >= limit) break;
    }

    offset += batchSize;
    if (markets.length < batchSize) break; // no more pages
  }

  log("info", {
    source: "backtest",
    event: "resolved_markets_fetched",
    count: results.length,
  });
  return results;
}

/**
 * Fetches hourly price history from the CLOB API.
 * NOTE (discovered during backtest): The CLOB prices-history endpoint returns
 * empty data for resolved/closed markets. Price history is only available for
 * currently active markets, and typically has very few data points.
 * marketId should be a clobTokenId (the long numeric string from clobTokenIds[0]).
 */
export async function fetchPriceHistory(marketId: string): Promise<PricePoint[]> {
  try {
    const url = `${CLOB_API}/prices-history?market=${encodeURIComponent(marketId)}&interval=1h&fidelity=60`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { history?: PricePoint[] } | PricePoint[];
    const history = Array.isArray(data) ? data : (data.history ?? []);
    return (history as PricePoint[]).sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

/**
 * Calls Claude directly on a resolved market question to probe integration health.
 * Used when price history is unavailable and no momentum signals can be replayed.
 */
export async function probeClaudeIntegration(
  markets: ResolvedMarket[]
): Promise<{ success: number; errors: number; avgLatencyMs: number; sample: BacktestResult[] }> {
  const sample = markets.slice(0, 5);
  const results: BacktestResult[] = [];
  let totalLatency = 0;
  let errors = 0;

  for (const market of sample) {
    // Use last-known odds as 0.5 (unknown pre-resolution for closed markets)
    const odds = 0.5;
    const { decision, latencyMs } = await askClaude(market.question, odds);
    totalLatency += latencyMs;
    if (decision === "ERROR") errors++;

    const correct =
      decision === "BUY_YES"
        ? market.resolution === 1
        : decision === "BUY_NO"
        ? market.resolution === 0
        : false;

    results.push({
      marketId: market.id,
      question: market.question,
      signalFiredAt: 0,
      oddsAtSignal: odds,
      claudeDecision: decision,
      claudeLatencyMs: latencyMs,
      actualResolution: market.resolution,
      correct,
      kellySizePct: 0,
      hypotheticalPnl: 0,
    });
  }

  return {
    success: sample.length - errors,
    errors,
    avgLatencyMs: sample.length > 0 ? totalLatency / sample.length : 0,
    sample: results,
  };
}

/**
 * Replays the EXISTING momentum signal logic against prediction market price history.
 * Adapted from SignalEngine in signal.ts: same % change concept, but uses a 4-hour
 * window and 5% threshold suited to hourly prediction market data (0-1 price range).
 */
export function replaySignals(history: PricePoint[]): BacktestSignal[] {
  const signals: BacktestSignal[] = [];
  if (history.length < BACKTEST_WINDOW_HOURS + 1) return signals;

  let lastSignalAtMs = 0;
  const COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12-hour cooldown between signals per market

  for (let i = BACKTEST_WINDOW_HOURS; i < history.length; i++) {
    const windowStart = history[i - BACKTEST_WINDOW_HOURS];
    const current = history[i];

    if (windowStart.p === 0) continue;

    const momentum = (current.p - windowStart.p) / windowStart.p;
    if (Math.abs(momentum) < BACKTEST_MOMENTUM_THRESHOLD) continue;

    const tMs = current.t * 1000;
    if (tMs - lastSignalAtMs < COOLDOWN_MS) continue;

    lastSignalAtMs = tMs;
    signals.push({
      firedAt: tMs,
      oddsAtSignal: current.p,
      direction: momentum > 0 ? "YES" : "NO",
      momentum,
    });
  }

  return signals;
}

/**
 * Kelly Criterion: f* = (p*b - q) / b
 * where b = net odds (profit per $ risked), p = win probability, q = 1 - p
 * Capped at 10% maximum.
 */
export function kellySize(odds: number, winProb: number): number {
  if (odds <= 0 || odds >= 1) return 0;
  const b = (1 - odds) / odds; // net odds
  const q = 1 - winProb;
  const kelly = (winProb * b - q) / b;
  return Math.max(0, Math.min(0.1, kelly));
}

export function computePnl(
  decision: ClaudeDecision,
  odds: number,
  resolution: number,
  kellySizePct: number
): number {
  if (decision === "PASS" || decision === "ERROR") return 0;

  const betYes = decision === "BUY_YES";
  const won = betYes ? resolution === 1 : resolution === 0;
  const betOdds = betYes ? odds : 1 - odds;

  if (won) {
    // Profit per $ = (1 - betOdds) / betOdds
    return kellySizePct * ((1 - betOdds) / betOdds);
  }
  return -kellySizePct;
}

/**
 * Calls the Claude CLI subprocess. Sends prompt via stdin (not as a positional arg)
 * because when spawned with an open stdin pipe the CLI waits for input otherwise.
 */
export async function askClaude(
  question: string,
  odds: number
): Promise<{ decision: ClaudeDecision; latencyMs: number }> {
  const start = Date.now();
  const prompt = `Market: ${question}\nCurrent odds: ${(odds * 100).toFixed(1)}% YES\nSignal: momentum spike detected\nShould we bet YES or NO? Respond with: BUY_YES, BUY_NO, or PASS`;

  return new Promise((resolve) => {
    const proc = spawn(
      "claude",
      ["--print", "--model", "claude-haiku-4-5-20251001"],
      {
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Send prompt via stdin then close it so claude knows there is no more input
    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, 30_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - start;

      if (timedOut || code !== 0) {
        const err = timedOut
          ? "timeout after 30s"
          : `exit code ${code}${stderr ? ": " + stderr.slice(0, 200) : ""}`;
        log("warn", { source: "backtest", event: "claude_error", error: err });
        resolve({ decision: "ERROR", latencyMs });
        return;
      }

      const text = stdout.toUpperCase();
      let decision: ClaudeDecision = "PASS";
      if (text.includes("BUY_YES")) decision = "BUY_YES";
      else if (text.includes("BUY_NO")) decision = "BUY_NO";

      log("info", {
        source: "backtest",
        event: "claude_decision",
        question: question.slice(0, 60),
        decision,
        latencyMs,
      });

      resolve({ decision, latencyMs });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      log("warn", { source: "backtest", event: "claude_error", error: String(err) });
      resolve({ decision: "ERROR", latencyMs });
    });
  });
}

export interface BacktestReport {
  marketsAnalyzed: number;
  signalsFired: number;
  claudeSuccesses: number;
  claudeErrors: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  buyYesTotal: number;
  buyYesCorrect: number;
  buyNoTotal: number;
  buyNoCorrect: number;
  passCount: number;
  avgKellyPct: number;
  totalPnl: number;
  results: BacktestResult[];
}

export function generateReport(results: BacktestResult[], marketsAnalyzed: number): BacktestReport {
  const claudeErrors = results.filter((r) => r.claudeDecision === "ERROR").length;
  const claudeSuccesses = results.filter((r) => r.claudeDecision !== "ERROR").length;
  const latencies = results.map((r) => r.claudeLatencyMs).filter((l) => l > 0);
  const avgLatencyMs =
    latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const maxLatencyMs = latencies.length > 0 ? Math.max(...latencies) : 0;

  const buyYes = results.filter((r) => r.claudeDecision === "BUY_YES");
  const buyNo = results.filter((r) => r.claudeDecision === "BUY_NO");
  const passes = results.filter((r) => r.claudeDecision === "PASS");

  const kellyValues = results.filter((r) => r.kellySizePct > 0).map((r) => r.kellySizePct);
  const avgKellyPct =
    kellyValues.length > 0 ? kellyValues.reduce((a, b) => a + b, 0) / kellyValues.length : 0;
  const totalPnl = results.reduce((sum, r) => sum + r.hypotheticalPnl, 0);

  return {
    marketsAnalyzed,
    signalsFired: results.length,
    claudeSuccesses,
    claudeErrors,
    avgLatencyMs,
    maxLatencyMs,
    buyYesTotal: buyYes.length,
    buyYesCorrect: buyYes.filter((r) => r.correct).length,
    buyNoTotal: buyNo.length,
    buyNoCorrect: buyNo.filter((r) => r.correct).length,
    passCount: passes.length,
    avgKellyPct,
    totalPnl,
    results,
  };
}

export function formatReport(report: BacktestReport, date: string): string {
  const totalDecisions = report.buyYesTotal + report.buyNoTotal;
  const totalCorrect = report.buyYesCorrect + report.buyNoCorrect;
  const winRate = totalDecisions > 0 ? (totalCorrect / totalDecisions) * 100 : 0;
  const signalRate =
    report.marketsAnalyzed > 0
      ? (report.signalsFired / report.marketsAnalyzed) * 100
      : 0;

  const yesAcc =
    report.buyYesTotal > 0
      ? `${report.buyYesCorrect}/${report.buyYesTotal} (${((report.buyYesCorrect / report.buyYesTotal) * 100).toFixed(1)}%)`
      : "0/0 (n/a)";
  const noAcc =
    report.buyNoTotal > 0
      ? `${report.buyNoCorrect}/${report.buyNoTotal} (${((report.buyNoCorrect / report.buyNoTotal) * 100).toFixed(1)}%)`
      : "0/0 (n/a)";

  const claudeStatus =
    report.claudeErrors === 0
      ? `  ✓ All ${report.claudeSuccesses} calls succeeded`
      : `  ✓ ${report.claudeSuccesses} calls succeeded\n  ✗ ${report.claudeErrors} error${report.claudeErrors !== 1 ? "s" : ""}`;

  let verdict: string;
  if (totalDecisions === 0) {
    verdict =
      "INSUFFICIENT DATA: No actionable signals. Either no price history from API, " +
      "signals never crossed the 5% threshold, or all signals fired after market resolution.";
  } else if (totalDecisions < 5) {
    verdict =
      `TOO FEW TRADES: Only ${totalDecisions} trade${totalDecisions !== 1 ? "s" : ""} — ` +
      "cannot distinguish edge from luck. Need 30+ trades for statistical significance.";
  } else if (winRate > 60) {
    verdict =
      `POSSIBLE EDGE: Win rate ${winRate.toFixed(1)}% exceeds 50% baseline. ` +
      `P&L: ${report.totalPnl >= 0 ? "+" : ""}${(report.totalPnl * 100).toFixed(1)}% of bankroll. ` +
      "Needs larger sample (30+ trades) to confirm.";
  } else if (winRate > 50) {
    verdict =
      `WEAK SIGNAL: Win rate ${winRate.toFixed(1)}% slightly above baseline. ` +
      "Cannot yet distinguish from noise. More data needed.";
  } else {
    verdict =
      `NO EDGE DETECTED: Win rate ${winRate.toFixed(1)}% at or below 50% baseline. ` +
      "Current signal parameters not predictive on this historical data.";
  }

  const lines = [
    "=== POLYMARKET-ARB BACKTEST REPORT ===",
    `Date: ${date}`,
    "",
    `Markets analyzed: ${report.marketsAnalyzed}`,
    `Signals fired: ${report.signalsFired} (${signalRate.toFixed(1)}% of markets)`,
    `Claude Code: ${report.claudeSuccesses}/${report.signalsFired} decisions returned (${report.claudeErrors} error${report.claudeErrors !== 1 ? "s" : ""})`,
    `Claude latency: avg ${(report.avgLatencyMs / 1000).toFixed(1)}s, max ${(report.maxLatencyMs / 1000).toFixed(1)}s`,
    "",
    "SIGNAL ACCURACY:",
    `  BUY_YES decisions: ${report.buyYesTotal} → correct: ${yesAcc}`,
    `  BUY_NO decisions: ${report.buyNoTotal} → correct: ${noAcc}`,
    `  PASS decisions: ${report.passCount}`,
    "",
    "EDGE vs RANDOM:",
    `  Win rate: ${winRate.toFixed(1)}% (random baseline: 50%)`,
    `  Avg Kelly size: ${(report.avgKellyPct * 100).toFixed(1)}% of bankroll`,
    `  Hypothetical total P&L: ${report.totalPnl >= 0 ? "+" : ""}${(report.totalPnl * 100).toFixed(1)}% of bankroll over ${report.marketsAnalyzed} markets`,
    "",
    "CLAUDE CODE INTEGRATION:",
    claudeStatus,
    "",
    `VERDICT: ${verdict}`,
  ];

  return lines.join("\n");
}

export function writeReport(text: string, date: string): string {
  const reportPath = `backtest-report-${date}.md`;
  fs.writeFileSync(reportPath, text + "\n");
  return reportPath;
}
