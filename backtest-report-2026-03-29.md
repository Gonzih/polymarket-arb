=== POLYMARKET-ARB BACKTEST REPORT ===
Date: 2026-03-29

Markets analyzed: 50
Signals fired: 5 (10.0% of markets)
Claude Code: 5/5 decisions returned (0 errors)
Claude latency: avg 5.1s, max 6.0s

SIGNAL ACCURACY:
  BUY_YES decisions: 0 → correct: 0/0 (n/a)
  BUY_NO decisions: 0 → correct: 0/0 (n/a)
  PASS decisions: 5

EDGE vs RANDOM:
  Win rate: 0.0% (random baseline: 50%)
  Avg Kelly size: 0.0% of bankroll
  Hypothetical total P&L: +0.0% of bankroll over 50 markets

CLAUDE CODE INTEGRATION:
  ✓ All 5 calls succeeded

VERDICT: INSUFFICIENT DATA: No actionable signals. Either no price history from API, signals never crossed the 5% threshold, or all signals fired after market resolution.

API FINDING: CLOB /prices-history endpoint returned empty data for all 50 resolved markets.
Investigation results:
  • GET /prices-history returns {history:[]} for all closed/resolved markets
  • Active markets: price history exists but only ~2 data points (insufficient for 4h window)
  • The end_date_min filter works to find recent markets efficiently
  • Recommendation: use a dedicated historical data provider (Dune Analytics, TheGraph) for future backtests


CLAUDE INTEGRATION PROBE (5 markets, no momentum signal required):
  5/5 calls succeeded (0 errors)
  Avg latency: 5.1s
  ✓ "Greens win over 15% of vote in German election? " → PASS (5.0s, resolved: NO)
  ✓ "Will Microstrategy vote to increase common stock s" → PASS (5.8s, resolved: YES)
  ✓ "Fed rate hike in 2025?" → PASS (4.4s, resolved: NO)
  ✓ "Circle IPO in 2025?" → PASS (4.5s, resolved: YES)
  ✓ "US recession in 2025?" → PASS (6.0s, resolved: NO)

