=== POLYMARKET-ARB BACKTEST REPORT ===
Date: 2026-03-29

Markets analyzed: 50
Signals fired: 5 (10.0% of markets)
Claude Code: 5/5 decisions returned (0 errors)
Claude latency: avg 8.3s, max 9.5s

SIGNAL ACCURACY:
  BUY_YES decisions: 1 → correct: 0/1 (0.0%)
  BUY_NO decisions: 0 → correct: 0/0 (n/a)
  PASS decisions: 4

EDGE vs RANDOM:
  Win rate: 0.0% (random baseline: 50%)
  Avg Kelly size: 0.0% of bankroll
  Hypothetical total P&L: +0.0% of bankroll over 50 markets

CLAUDE CODE INTEGRATION:
  ✓ All 5 calls succeeded

VERDICT: TOO FEW TRADES: Only 1 trade — cannot distinguish edge from luck. Need 30+ trades for statistical significance.

API FINDING: CLOB /prices-history endpoint returned empty data for all 50 resolved markets.
Investigation results:
  • GET /prices-history returns {history:[]} for all closed/resolved markets
  • Active markets: price history exists but only ~2 data points (insufficient for 4h window)
  • The end_date_min filter works to find recent markets efficiently
  • Recommendation: use a dedicated historical data provider (Dune Analytics, TheGraph) for future backtests


CLAUDE INTEGRATION PROBE (5 markets, no momentum signal required):
  5/5 calls succeeded (0 errors)
  Avg latency: 8.3s
  ✓ "Greens win over 15% of vote in German election? " → BUY_YES (9.5s, resolved: NO)
  ✓ "Will Microstrategy vote to increase common stock s" → PASS (8.8s, resolved: YES)
  ✓ "Fed rate hike in 2025?" → PASS (7.5s, resolved: NO)
  ✓ "Circle IPO in 2025?" → PASS (8.1s, resolved: YES)
  ✓ "US recession in 2025?" → PASS (7.6s, resolved: NO)

