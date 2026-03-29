import {
  fetchResolvedMarkets,
  fetchPriceHistory,
  replaySignals,
  askClaude,
  kellySize,
  computePnl,
  generateReport,
  formatReport as formatBaseReport,
  writeReport,
  probeClaudeIntegration,
  type BacktestResult,
  type BacktestReport,
} from "./backtest.js";
import { log } from "./logger.js";

const MARKETS_TO_FETCH = 50;
// At most one Claude call per market to keep runtime reasonable
const MAX_SIGNALS_PER_MARKET = 1;

export async function runBacktest(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);

  console.log("=== POLYMARKET-ARB BACKTESTING HARNESS ===");
  console.log(`Fetching up to ${MARKETS_TO_FETCH} resolved markets (volume > $50k, last 6 months)...`);

  const markets = await fetchResolvedMarkets(MARKETS_TO_FETCH);
  console.log(`Fetched ${markets.length} qualifying markets\n`);

  if (markets.length === 0) {
    console.error(
      "ERROR: No resolved markets found.\n" +
        "Possible causes:\n" +
        "  • GAMMA API unreachable\n" +
        "  • No markets with volume > $50k resolved in last 6 months\n" +
        "  • outcomePrices not cleanly 0 or 1 (market still settling)"
    );
    process.exit(1);
  }

  const results: BacktestResult[] = [];
  let marketsWithHistory = 0;
  let marketsNoHistory = 0;
  let marketsNoSignal = 0;

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];
    process.stdout.write(
      `\r[${i + 1}/${markets.length}] ${market.question.slice(0, 55)}...`
    );

    // Use the YES clobTokenId for price history
    const tokenId = market.clobTokenId || market.conditionId;
    const history = await fetchPriceHistory(tokenId);
    if (history.length < 5) {
      marketsNoHistory++;
      continue;
    }
    marketsWithHistory++;

    const signals = replaySignals(history).slice(0, MAX_SIGNALS_PER_MARKET);
    if (signals.length === 0) {
      marketsNoSignal++;
      continue;
    }

    for (const signal of signals) {
      // Skip signals that fired at or after resolution — unfair look-ahead
      if (signal.firedAt >= market.resolutionTime) continue;

      const { decision, latencyMs } = await askClaude(market.question, signal.oddsAtSignal);

      const betOdds = decision === "BUY_YES" ? signal.oddsAtSignal : 1 - signal.oddsAtSignal;
      // Assume modest 65% win probability as prior when signal fires
      const WIN_PROB_PRIOR = 0.65;
      const kellySizePct =
        decision !== "PASS" && decision !== "ERROR"
          ? kellySize(betOdds, WIN_PROB_PRIOR)
          : 0;

      const pnl = computePnl(decision, signal.oddsAtSignal, market.resolution, kellySizePct);
      const correct =
        decision === "BUY_YES"
          ? market.resolution === 1
          : decision === "BUY_NO"
          ? market.resolution === 0
          : false;

      results.push({
        marketId: market.id,
        question: market.question,
        signalFiredAt: signal.firedAt,
        oddsAtSignal: signal.oddsAtSignal,
        claudeDecision: decision,
        claudeLatencyMs: latencyMs,
        actualResolution: market.resolution,
        correct,
        kellySizePct,
        hypotheticalPnl: pnl,
      });

      log("info", {
        source: "backtest",
        event: "result",
        question: market.question.slice(0, 60),
        decision,
        oddsAtSignal: signal.oddsAtSignal.toFixed(3),
        resolution: market.resolution,
        correct,
        pnl: pnl.toFixed(4),
      });
    }
  }

  process.stdout.write("\n\n");

  console.log(
    `Price history: ${marketsWithHistory}/${markets.length} markets had history, ` +
      `${marketsNoHistory} had no/insufficient data, ` +
      `${marketsNoSignal} had history but no signal fired`
  );

  // ── Claude integration probe ──────────────────────────────────────────────
  // Always run this to verify the subprocess works, regardless of signals.
  console.log("\nRunning Claude integration probe (5 markets)...");
  const probe = await probeClaudeIntegration(markets);
  console.log(
    `Claude probe: ${probe.success}/5 calls succeeded, ` +
      `${probe.errors} errors, avg latency ${(probe.avgLatencyMs / 1000).toFixed(1)}s`
  );

  // Add probe results to the report if no signal-based results exist
  const reportResults = results.length > 0 ? results : probe.sample;

  const report = generateReport(reportResults, markets.length);
  const reportText = buildFullReport(report, probe, marketsNoHistory, markets.length, date);
  console.log("\n" + reportText);

  const reportPath = writeReport(reportText, date);
  console.log(`\nReport written to: ${reportPath}`);

  if (probe.errors > 0) {
    console.warn(
      `\nWARNING: ${probe.errors} Claude call(s) failed.\n` +
        "Check that CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_AUTH_TOKEN is set."
    );
  }
}

function buildFullReport(
  report: BacktestReport,
  probe: { success: number; errors: number; avgLatencyMs: number; sample: BacktestResult[] },
  marketsNoHistory: number,
  marketsTotal: number,
  date: string
): string {
  let text = formatBaseReport(report, date);

  if (marketsNoHistory === marketsTotal) {
    text +=
      "\n\nAPI FINDING: CLOB /prices-history endpoint returned empty data for all " +
      marketsTotal +
      " resolved markets.\n" +
      "Investigation results:\n" +
      "  • GET /prices-history returns {history:[]} for all closed/resolved markets\n" +
      "  • Active markets: price history exists but only ~2 data points (insufficient for 4h window)\n" +
      "  • The end_date_min filter works to find recent markets efficiently\n" +
      "  • Recommendation: use a dedicated historical data provider (Dune Analytics, TheGraph) for future backtests\n";
  }

  text +=
    "\n\nCLAUDE INTEGRATION PROBE (5 markets, no momentum signal required):\n" +
    `  ${probe.success}/5 calls succeeded (${probe.errors} errors)\n` +
    `  Avg latency: ${(probe.avgLatencyMs / 1000).toFixed(1)}s\n`;

  for (const r of probe.sample) {
    const icon = r.claudeDecision === "ERROR" ? "✗" : "✓";
    text +=
      `  ${icon} "${r.question.slice(0, 50)}" → ${r.claudeDecision} ` +
      `(${(r.claudeLatencyMs / 1000).toFixed(1)}s, resolved: ${r.actualResolution === 1 ? "YES" : "NO"})\n`;
  }

  return text;
}

// Run when invoked directly (not imported)
const selfPath = process.argv[1] ?? "";
if (selfPath.endsWith("backtestRunner.ts") || selfPath.endsWith("backtestRunner.js")) {
  runBacktest().catch((err: unknown) => {
    console.error("Backtest failed:", err);
    process.exit(1);
  });
}
