# Polymarket-ARB Backtest Results — 2026-03-29

## Summary

Full backtest attempted against real historical Polymarket data. Core limitation confirmed:
**CLOB `/prices-history` returns empty data for all resolved markets.** Signal accuracy
on Polymarket itself cannot be measured without a dedicated historical data provider.
Supplementary BTC momentum analysis was performed using CoinGecko 90-day hourly data.

---

## 1. Data Sources Used

| Source | Endpoint | Data |
|--------|----------|------|
| Gamma API | `gamma-api.polymarket.com/markets?closed=true` | 50 resolved markets, vol >$50k, last 6 months |
| CLOB API | `clob.polymarket.com/prices-history` | ❌ Returns empty for all resolved markets |
| CoinGecko | `/coins/bitcoin/market_chart?days=90&interval=hourly` | 2,162 BTC price points (90 days) |

**Time ranges:**
- Polymarket markets: September 2025 – March 2026
- BTC hourly data: January 2026 – March 2026 (90 days), price range $63,177–$75,632

---

## 2. Core Finding: CLOB Price History Unavailable

All 50 resolved Polymarket markets returned `{history: []}` from the CLOB
`/prices-history` endpoint. This is a fundamental API limitation, not a bug in the bot:

- Closed/resolved markets: always returns empty history
- Active markets: returns ~2 data points (insufficient for 4-hour window analysis)
- The `end_date_min` filter on GAMMA API works correctly for efficient market fetching

**Impact:** The backtest harness' `replaySignals()` path was not executed. 0 momentum
signals were generated from Polymarket price history.

---

## 3. Momentum Signal Analysis — BTC Historical Data (Proxy)

Since Polymarket price history is unavailable, BTC hourly data was used as a proxy
to characterize signal behavior. The momentum signal is designed to react to crypto
price moves and then predict Polymarket odds movement.

### Signal Frequency (90 days BTC hourly)

| Config | Signals | Per Day | Notes |
|--------|---------|---------|-------|
| 1h window / 0.35% threshold (live `signal.ts`) | 764 | **8.5/day** | Extremely frequent — noise |
| 1h window / 1.0% threshold (conservative) | 151 | 1.7/day | More selective |
| 1h window / 2.0% threshold (aggressive) | 23 | 0.3/day | Low volume |
| 4h window / 5.0% threshold (`backtest.ts`) | 7 | **0.1/day** | Too rare for live trading |

### Signal Directional Accuracy at +4h (BTC continuation)

| Config | +1h | +2h | +4h | +8h | +24h |
|--------|-----|-----|-----|-----|------|
| 1h/0.35% | – | – | **48%** (below 50%) | – | – |
| 1h/1.0% (118 signals, 2h cooldown) | 53% | – | **52%** | 52% | 46% |
| 4h/5% (n=4, 12h cooldown) | 25% | 25% | **50%** | 50% | 0% |

**Key finding:** No signal configuration shows consistent directional edge in BTC price
continuation. Accuracy hovers around 48-53%, consistent with random noise.

### Sample 4h/5% Signals (BTC, 90 days)

```
2026-02-03 19:02 | BTC=$73,112 | DOWN  5.3% | +1h: +2.1% (reversal!)  | +4h: +3.4% | +24h: +0.5%
2026-02-05 18:03 | BTC=$66,086 | DOWN  5.1% | +1h: +0.2%              | +4h: -4.4% | +24h: +7.1%
2026-02-06 17:03 | BTC=$69,872 | UP    5.1% | +1h: +1.3% (confirmed)  | +4h: +0.2% | +24h: -1.3%
2026-03-02 17:02 | BTC=$69,482 | UP    5.4% | +1h: -0.5% (reversal!)  | +4h: -0.3% | +24h: -2.6%
```

Notably: 2/4 signals reversed within 1h. The 5% threshold catches the *aftermath* of
volatile moves, not the start of them — frequent mean reversion.

---

## 4. Claude Integration Health

Claude integration (`claude --print`, stdin-based subprocess) is working correctly.

| Metric | Result |
|--------|--------|
| Calls succeeded | 5/5 (100%) |
| Calls with errors | 0 |
| Avg latency | **5.1s** |
| Max latency | 6.0s |

### Sample Claude decisions (Haiku 4.5, no momentum context):

| Market | Decision | Resolved | Time |
|--------|----------|----------|------|
| Greens win >15% in German election? | PASS | NO | 5.0s |
| Microstrategy stock supply vote pass? | PASS | YES | 5.8s |
| Fed rate hike in 2025? | PASS | NO | 4.4s |
| Circle IPO in 2025? | PASS | YES | 4.5s |
| US recession in 2025? | PASS | NO | 6.0s |

All 5 returned PASS. This is expected: without current market odds or a momentum signal,
the prompt lacks the context for Claude to make directional bets.

---

## 5. Whale Fade Signal

Cannot be measured — requires order book trade history which is not available via CLOB
for resolved markets. Live testing via the daemon's whale detection would be needed
to gather real ground truth data.

---

## 6. Signal Lag (Crypto → Polymarket)

Not measurable with current data sources. Requires:
1. Concurrent timestamps for both BTC price changes AND Polymarket odds changes
2. Polymarket price history for at least the same markets during the same period

Estimated theoretical lag based on architecture:
- Coinbase WebSocket tick → SignalEngine: ~50ms
- Signal fire → Claude analysis: ~5s (measured)
- Claude decision → order submission: ~100ms
- **Total latency: ~5-6s** from price move to potential order

This is slow for crypto arbitrage but potentially acceptable for prediction market
odds lag, which typically moves over minutes rather than seconds.

---

## 7. Recommendations

### Immediate (High Priority)

1. **Get Polymarket price history from alternative source:**
   - **Dune Analytics** (`dune.com`) — Polymarket has public dashboards with full trade
     history accessible via SQL. Free tier allows queries.
   - **TheGraph** — Polymarket is indexed; historical trade events available.
   - **Polymarket CLOB trades endpoint**: `GET /trades?market=<token_id>` may return
     individual trades (not price aggregates), allowing reconstruction of price series.

2. **Fix signal threshold for live trading:**
   - Current 0.35%/30s threshold fires **8.5 times/day** per symbol.
   - Suggested: 1.0%/1h or 2%/30min to reduce noise.
   - All thresholds show ~50% accuracy on BTC continuation — no edge found yet.

3. **Verify CLOB trades endpoint** for historical data:
   ```bash
   curl "https://clob.polymarket.com/trades?market=<token_id>&limit=100"
   ```
   Trades may be available even when prices-history is not.

### Medium-term

4. **Decouple crypto signal from Polymarket target:**
   The current design assumes BTC/ETH momentum predicts Polymarket odds changes on
   crypto-adjacent markets. This correlation has not been validated. The 50% accuracy
   of the BTC momentum signal suggests no inherent edge from crypto momentum alone.

5. **Test Claude with real momentum context:**
   The probe showed PASS for all markets without momentum data. Run the full signal
   loop live for 1 week and log Claude's actual decisions with momentum context included.

6. **Consider event-driven signals instead of momentum:**
   Polymarket odds move on news events (elections, Fed decisions, sports outcomes).
   A news/social sentiment feed may be more predictive than crypto price momentum.

---

## 8. Verdict

```
INSUFFICIENT DATA — No actionable signals from Polymarket price history.

BTC momentum signal analysis (proxy):
  - 0.35%/30s config: 8.5 signals/day, ~48% directional accuracy (below random)
  - No configuration showed statistically significant edge (max n=118 trades at 52%)
  - 4h/5% config: only 0.1 signals/day — too rare for live trading

Claude integration: WORKING ✓ (5.1s avg latency, 0% error rate)
Whale fade: UNMEASURABLE without order book history
Signal lag (crypto→Polymarket): UNMEASURABLE without concurrent Polymarket price data

Bottom line: The current momentum signal has no demonstrated edge.
Before trading real money, obtain Polymarket trade history via Dune/TheGraph
and validate that crypto momentum predicts odds movement.
```

---

*Generated by cc-agent backtest run 2026-03-29*
*BTC data: CoinGecko free API, 90 days, 2162 hourly points*
*Polymarket data: Gamma API (metadata only), CLOB API (empty history)*
