import {
  fetchCoinbaseCandles,
  replaySignals,
  fetchPolymarketMarkets,
  fetchMarketTrades,
  findCorrelatedMoves,
  askClaude,
  buildSignalLog,
  generateMarkdownReport,
  writeReport,
  type RawTrade,
  type SignalResult,
  type BacktestReport,
} from "./backtest.js";

const PRODUCT = "BTC-USD";
const GRANULARITY = 60; // 1-minute candles
const CANDLE_LIMIT = 300; // ~5 hours of data
const POLYMARKET_MARKETS = 20;

export async function runBacktest(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);

  console.log("=== POLYMARKET-ARB BACKTESTING HARNESS ===");
  console.log(`Fetching ${CANDLE_LIMIT} × ${GRANULARITY}s candles for ${PRODUCT}...`);

  const candles = await fetchCoinbaseCandles(PRODUCT, GRANULARITY, CANDLE_LIMIT);
  if (candles.length === 0) {
    console.error(
      "ERROR: No candles returned from Coinbase REST API.\n" +
        "Possible causes:\n" +
        "  • API rate-limited or unreachable\n" +
        "  • Network error"
    );
    process.exit(1);
  }
  console.log(`Fetched ${candles.length} candles`);

  const signals = replaySignals(candles, PRODUCT);
  console.log(`Signals fired: ${signals.length} (threshold: 1.5% per candle)`);

  console.log(`\nFetching ${POLYMARKET_MARKETS} active Polymarket markets...`);
  const markets = await fetchPolymarketMarkets(POLYMARKET_MARKETS);
  console.log(`Fetched ${markets.length} qualifying markets (volume > $10k)`);

  // Pre-fetch trades for all markets once, then reuse across signals
  const tradesByMarket: Record<string, RawTrade[]> = {};
  if (signals.length > 0 && markets.length > 0) {
    console.log(`Pre-fetching trades for ${markets.length} markets...`);
    for (let i = 0; i < markets.length; i++) {
      const market = markets[i];
      if (market.clobTokenId) {
        process.stdout.write(`\r  [${i + 1}/${markets.length}] ${market.question.slice(0, 50)}`);
        tradesByMarket[market.id] = await fetchMarketTrades(market.clobTokenId);
      }
    }
    process.stdout.write("\n");
  }

  const results: SignalResult[] = signals.map((signal) => {
    const correlatedMoves = findCorrelatedMoves(signal, markets, tradesByMarket);
    return {
      signal,
      marketsChecked: markets.length,
      correlatedMoves,
    };
  });

  const correlatedCount = results.filter((r) => r.correlatedMoves.length > 0).length;
  const candleMinutes = (candles.length * GRANULARITY) / 60;
  const signalRatePerDay =
    candleMinutes > 0 ? (signals.length / candleMinutes) * 24 * 60 : 0;

  console.log(`\nResults:`);
  console.log(`  Signals fired: ${signals.length}`);
  console.log(`  Signals with correlated Polymarket moves: ${correlatedCount}/${signals.length}`);
  console.log(`  Correlation rate: ${signals.length > 0 ? ((correlatedCount / signals.length) * 100).toFixed(1) : "0.0"}%`);

  const signalLog = buildSignalLog(results);

  console.log("\nAsking Claude for interpretation...");
  const claudeInterpretation = await askClaude(signalLog);
  console.log("Claude responded.");

  const report: BacktestReport = {
    date,
    product: PRODUCT,
    candlesAnalyzed: candles.length,
    signalsFired: signals.length,
    signalRatePerDay,
    marketsChecked: markets.length,
    correlatedSignals: correlatedCount,
    correlationRate: signals.length > 0 ? (correlatedCount / signals.length) * 100 : 0,
    signals: results,
    claudeInterpretation,
  };

  const reportText = generateMarkdownReport(report);
  const reportPath = writeReport(reportText, date);
  console.log(`\nReport written to: ${reportPath}`);
  console.log("\n" + reportText);
}

// Run when invoked directly (not imported)
const selfPath = process.argv[1] ?? "";
if (selfPath.endsWith("backtestRunner.ts") || selfPath.endsWith("backtestRunner.js")) {
  runBacktest().catch((err: unknown) => {
    console.error("Backtest failed:", err);
    process.exit(1);
  });
}
