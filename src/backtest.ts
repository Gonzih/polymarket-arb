import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { log } from "./logger.js";

export const COINBASE_API = "https://api.exchange.coinbase.com";
export const CLOB_API = "https://clob.polymarket.com";
export const MOMENTUM_THRESHOLD = 0.015; // 1.5% per candle (open→close)
export const CORRELATION_THRESHOLD = 0.02; // 2% odds move
export const CORRELATION_WINDOW_MINUTES = 30;

// Coinbase candle tuple: [timestamp, low, high, open, close, volume]
export type Candle = [number, number, number, number, number, number];

export const CANDLE_TIME = 0;
export const CANDLE_LOW = 1;
export const CANDLE_HIGH = 2;
export const CANDLE_OPEN = 3;
export const CANDLE_CLOSE = 4;
export const CANDLE_VOL = 5;

export type CandleSignal = {
  firedAt: number; // unix ms
  symbol: string;
  direction: "UP" | "DOWN";
  momentum: number; // signed %
  price: number; // close price
  confidence: number; // 0-1 scale, relative to threshold
};

export type RawTrade = {
  price: string | number;
  timestamp: string | number;
};

export type PolymarketMarket = {
  id: string;
  conditionId: string;
  clobTokenId: string;
  question: string;
  yesPrice: number;
  volume: number;
};

export type OddsMove = {
  marketId: string;
  question: string;
  oddsChange: number; // absolute (0-1)
  direction: "UP" | "DOWN";
};

export type SignalResult = {
  signal: CandleSignal;
  marketsChecked: number;
  correlatedMoves: OddsMove[];
};

export type BacktestReport = {
  date: string;
  product: string;
  candlesAnalyzed: number;
  signalsFired: number;
  signalRatePerDay: number;
  marketsChecked: number;
  correlatedSignals: number;
  correlationRate: number;
  signals: SignalResult[];
  claudeInterpretation: string;
};

/**
 * Fetch 1-minute (or custom granularity) OHLCV candles from Coinbase REST API.
 * Coinbase returns newest-first; we reverse to chronological order.
 */
export async function fetchCoinbaseCandles(
  product = "BTC-USD",
  granularity = 60,
  limit = 300
): Promise<Candle[]> {
  try {
    const url = `${COINBASE_API}/products/${encodeURIComponent(product)}/candles?granularity=${granularity}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
      log("warn", { source: "backtest", event: "coinbase_candles_error", status: res.status });
      return [];
    }
    const data = (await res.json()) as Candle[];
    // Reverse so index 0 is oldest
    return data.reverse();
  } catch (err) {
    log("warn", { source: "backtest", event: "coinbase_candles_exception", error: String(err) });
    return [];
  }
}

/**
 * Replay the 1.5% momentum signal logic against Coinbase candle data.
 * Uses per-candle momentum (open→close). Applies 5-minute per-direction cooldown.
 */
export function replaySignals(candles: Candle[], symbol = "BTC-USD"): CandleSignal[] {
  const signals: CandleSignal[] = [];
  const COOLDOWN_MS = 5 * 60 * 1000;
  const lastSignalTime: Record<"UP" | "DOWN", number> = { UP: 0, DOWN: 0 };

  for (const candle of candles) {
    const open = candle[CANDLE_OPEN];
    const close = candle[CANDLE_CLOSE];
    const ts = candle[CANDLE_TIME];

    if (open === 0) continue;

    const momentum = (close - open) / open;
    if (Math.abs(momentum) < MOMENTUM_THRESHOLD) continue;

    const direction: "UP" | "DOWN" = momentum > 0 ? "UP" : "DOWN";
    const firedAt = ts * 1000;

    if (firedAt - lastSignalTime[direction] < COOLDOWN_MS) continue;

    lastSignalTime[direction] = firedAt;
    signals.push({
      firedAt,
      symbol,
      direction,
      momentum,
      price: close,
      confidence: Math.min(1, Math.abs(momentum) / (MOMENTUM_THRESHOLD * 2)),
    });
  }

  return signals;
}

function parseJsonField(field: string | string[]): string[] {
  if (Array.isArray(field)) return field;
  try {
    return JSON.parse(field);
  } catch {
    return [];
  }
}

type RawPolymarketMarket = {
  id?: string;
  conditionId?: string;
  clobTokenIds?: string | string[];
  question?: string;
  volume?: string | number;
  volumeNum?: number;
  outcomePrices?: string | string[];
};

/**
 * Fetch active Polymarket markets from the CLOB API.
 * Handles both array and {data:[]} response shapes.
 */
export async function fetchPolymarketMarkets(limit = 20): Promise<PolymarketMarket[]> {
  try {
    const url = `${CLOB_API}/markets?active=true&closed=false&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
      log("warn", { source: "backtest", event: "polymarket_markets_error", status: res.status });
      return [];
    }
    const raw = (await res.json()) as { data?: RawPolymarketMarket[] } | RawPolymarketMarket[];
    const markets: RawPolymarketMarket[] = Array.isArray(raw) ? raw : (raw.data ?? []);

    return markets
      .map((m) => {
        const prices = parseJsonField(m.outcomePrices ?? []).map(Number);
        const yesPrice = prices[0] ?? 0.5;
        const tokenIds = parseJsonField(m.clobTokenIds ?? "[]");
        return {
          id: m.id ?? "",
          conditionId: m.conditionId ?? m.id ?? "",
          clobTokenId: tokenIds[0] ?? "",
          question: m.question ?? "",
          yesPrice,
          volume: Number(m.volumeNum ?? m.volume ?? 0),
        };
      })
      .filter((m) => m.id && m.question && m.volume > 10_000);
  } catch (err) {
    log("warn", { source: "backtest", event: "polymarket_markets_exception", error: String(err) });
    return [];
  }
}

/**
 * Fetch recent trades for a Polymarket market token from the CLOB.
 * Returns empty array on any error.
 */
export async function fetchMarketTrades(tokenId: string): Promise<RawTrade[]> {
  try {
    const url = `${CLOB_API}/trades?market=${encodeURIComponent(tokenId)}&limit=500`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const raw = (await res.json()) as RawTrade[] | { data: RawTrade[] };
    return Array.isArray(raw) ? raw : (raw.data ?? []);
  } catch {
    return [];
  }
}

/**
 * For each signal, check if any Polymarket market moved >2% in odds
 * within `windowMinutes` of the signal firing.
 * tradesByMarket is a pre-fetched map of marketId → trades.
 */
export function findCorrelatedMoves(
  signal: CandleSignal,
  markets: PolymarketMarket[],
  tradesByMarket: Record<string, RawTrade[]>,
  oddsThreshold = CORRELATION_THRESHOLD,
  windowMinutes = CORRELATION_WINDOW_MINUTES
): OddsMove[] {
  const windowStartSec = signal.firedAt / 1000;
  const windowEndSec = windowStartSec + windowMinutes * 60;
  const correlated: OddsMove[] = [];

  for (const market of markets) {
    const trades = tradesByMarket[market.id] ?? [];
    const windowTrades = trades.filter((t) => {
      const ts = Number(t.timestamp);
      const tsSec = ts < 1e12 ? ts : Math.floor(ts / 1000);
      return tsSec >= windowStartSec && tsSec <= windowEndSec;
    });

    if (windowTrades.length < 2) continue;

    const priceStart = Number(windowTrades[0].price);
    const priceEnd = Number(windowTrades[windowTrades.length - 1].price);
    const oddsChange = priceEnd - priceStart;

    if (Math.abs(oddsChange) >= oddsThreshold) {
      correlated.push({
        marketId: market.id,
        question: market.question,
        oddsChange: Math.abs(oddsChange),
        direction: oddsChange > 0 ? "UP" : "DOWN",
      });
    }
  }

  return correlated;
}

/**
 * Build a human-readable signal log for Claude interpretation.
 */
export function buildSignalLog(results: SignalResult[]): string {
  if (results.length === 0) {
    return "No signals fired in the analysis window. Momentum threshold (1.5%) not crossed in recent candles.";
  }

  const correlated = results.filter((r) => r.correlatedMoves.length > 0).length;
  const lines = [
    `Total signals: ${results.length}`,
    `Correlated with Polymarket moves >2%: ${correlated}/${results.length}`,
    `Correlation rate: ${((correlated / results.length) * 100).toFixed(1)}%`,
    "",
    "Signal Log:",
  ];

  for (const r of results) {
    const ts = new Date(r.signal.firedAt).toISOString();
    const pct = (r.signal.momentum * 100).toFixed(2);
    const corrStr =
      r.correlatedMoves.length > 0
        ? r.correlatedMoves
            .map((m) => `${m.question.slice(0, 40)} (${(m.oddsChange * 100).toFixed(1)}% ${m.direction})`)
            .join("; ")
        : "no correlated moves";
    lines.push(
      `  [${ts}] ${r.signal.direction} ${pct}% @ $${r.signal.price.toFixed(0)} | conf=${r.signal.confidence.toFixed(2)} | ${corrStr}`
    );
  }

  return lines.join("\n");
}

/**
 * Spawn claude --print and ask for signal pattern analysis.
 * Returns Claude's response text or a fallback message on failure.
 */
export async function askClaude(signalLog: string): Promise<string> {
  const prompt =
    `Given these signal firings and Polymarket odds movements, what patterns do you see? ` +
    `Which signal types (high momentum, news-boosted, specific time windows) correlate best with market moves? ` +
    `What threshold would maximize signal quality?\n\n${signalLog}`;

  return new Promise((resolve) => {
    const proc = spawn("claude", ["--print", "--model", "claude-haiku-4-5-20251001"], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = "";
    let timedOut = false;

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", () => {}); // suppress stderr noise

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, 60_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) {
        resolve("(Claude interpretation unavailable — subprocess error or timeout)");
        return;
      }
      resolve(stdout.trim() || "(No interpretation returned)");
    });

    proc.on("error", () => {
      clearTimeout(timer);
      resolve("(Claude interpretation unavailable — spawn error)");
    });
  });
}

/**
 * Render the full backtest report as Markdown.
 */
export function generateMarkdownReport(report: BacktestReport): string {
  const signalRows =
    report.signals.length > 0
      ? report.signals.map((r) => {
          const ts = new Date(r.signal.firedAt).toISOString().replace("T", " ").slice(0, 19);
          const mom = `${(r.signal.momentum * 100).toFixed(2)}%`;
          const marketMove =
            r.correlatedMoves.length > 0
              ? r.correlatedMoves.map((m) => `${(m.oddsChange * 100).toFixed(1)}%`).join(", ")
              : "—";
          return `| ${ts} | ${r.signal.symbol} | ${mom} | ${r.signal.direction} | ${marketMove} |`;
        })
      : ["| — | — | — | — | — |"];

  return [
    `# Polymarket Backtest — ${report.date}`,
    "",
    "## Summary",
    `- Candles analyzed: ${report.candlesAnalyzed}`,
    `- Signals fired: ${report.signalsFired}`,
    `- Signal rate: ${report.signalRatePerDay.toFixed(1)} per day`,
    `- Markets checked per signal: ${report.marketsChecked}`,
    `- Correlated moves (signal + market move >2%): ${report.correlatedSignals}`,
    `- Correlation rate: ${report.correlationRate.toFixed(1)}%`,
    "",
    "## Signal Log",
    "| Time | Symbol | Momentum | Direction | Market Move |",
    "|------|--------|----------|-----------|-------------|",
    ...signalRows,
    "",
    "## Interpretation",
    report.claudeInterpretation,
    "",
  ].join("\n");
}

/**
 * Write a report to disk. Creates `dir` if it doesn't exist.
 * Returns the path written.
 */
export function writeReport(text: string, date: string, dir = "research"): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const reportPath = path.join(dir, `backtest-results-${date}.md`);
  fs.writeFileSync(reportPath, text);
  return reportPath;
}
