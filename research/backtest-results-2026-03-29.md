# Polymarket Backtest — 2026-03-29

## Summary
- Candles analyzed: 300 (1-minute BTC-USD, ~5 hours)
- Signals fired: 0 (1.5% per-candle threshold not crossed in recent window)
- Signal rate: 0.0 per day
- Markets checked per signal: 0
- Correlated moves (signal + market move >2%): 0
- Correlation rate: 0.0%

## Signal Log
| Time | Symbol | Momentum | Direction | Market Move |
|------|--------|----------|-----------|-------------|
| — | — | — | — | — |

## Interpretation

No signals fired in the analysis window. Momentum threshold (1.5%) not crossed in recent candles.

### Context

The 1.5% per-candle threshold is intentionally conservative — calibrated to reduce noise in the live
daemon. In a 5-hour window of recent BTC price action, no single 1-minute candle moved > 1.5% from
open to close.

### Methodology Notes

- **Data source**: Coinbase REST API (`/products/BTC-USD/candles?granularity=60&limit=300`)
- **Signal logic**: Per-candle momentum `(close − open) / open`, 5-minute per-direction cooldown
- **Correlation window**: 30-minute post-signal window, >2% Polymarket odds move
- **Prior approach (deprecated)**: Polymarket CLOB `/prices-history` returned `{history:[]}` for
  all 50 resolved markets tested — 0/50 had usable price data. This Coinbase-based approach
  replaces it with a reliable data source.

### Recommendations

1. **Threshold tuning**: A 0.5–1.0% per-candle threshold would fire more signals for correlation
   analysis. Consider running a longer historical window (Coinbase supports up to 300 candles per
   request; chain multiple requests for days of data).
2. **Multi-asset**: Add ETH-USD candles to double signal frequency without changing logic.
3. **Polymarket correlation**: Active market trades data is available via CLOB `/trades`; the
   infrastructure is in place to correlate once signals fire.
4. **Statistical significance**: Need 30+ correlated signal observations for any edge claim.
