# Polymarket Arb — Research & Testing Plan

## What we're measuring

This paper trading run has one job: determine whether the latency arbitrage edge
described in the 0x8dxd case study is real and currently exploitable.

## Hypothesis

Polymarket's BTC/ETH short-duration contracts (5min, 15min) lag Binance price
movements by ~2.7 seconds on average. A bot that detects significant momentum
moves on Binance and trades the lagging Polymarket contract before repricing
should win > 70% of those specific trades.

## Success criteria (before going live)

- Minimum 200 completed paper trades
- Win rate > 70% on trades where edge > 5% at entry
- Average edge at entry > 6% (confirms signal quality, not just luck)
- No single trade > 8% of simulated portfolio
- No simulated daily drawdown event > 20%

## What we're NOT testing in paper mode

- Actual Polymarket API order execution latency (paper skips this)
- Slippage on large position sizes
- Order book liquidity — can the bot actually get filled at the quoted odds?

## Paper mode limitations

Paper mode calculates what WOULD have happened if we bought at the odds
visible at signal time. It does NOT account for:
- The 1-3% protocol fee on Polymarket trades
- Partial fills or order rejection
- The fact that our own orders move the market

## What to look for in the logs

- `edge_at_signal` distribution: should cluster around 6-12% on fired trades
- `time_to_reprice`: how long after our signal does Polymarket correct? Target < 3s
- `false_positives`: signals that fired but Polymarket was already repriced
- `missed_signals`: momentum events where we calculated edge but confidence < 85%

## Daily review checklist

- [ ] Check `trades.db` win rate: `sqlite3 ~/.polymarket-arb/trades.db "SELECT COUNT(*), AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) as win_rate FROM trades WHERE date(created_at) = date('now')"`
- [ ] Review any Telegram alerts for kill-switch events
- [ ] Check `~/.polymarket-arb/polymarket-arb.log` for errors or edge distribution drift
- [ ] After 200 trades: run analysis script to evaluate go/no-go for live

## Edge compression monitoring

Log the average time-to-reprice daily. If it drops below 1 second consistently,
the latency arb edge is likely no longer exploitable without co-located infra.
At that point pivot to oracle arb or news-driven strategy.

## Analysis queries

### Win rate by edge bucket
```sql
SELECT
  CASE
    WHEN edge_at_signal < 5 THEN '<5%'
    WHEN edge_at_signal < 8 THEN '5-8%'
    WHEN edge_at_signal < 12 THEN '8-12%'
    ELSE '>12%'
  END as edge_bucket,
  COUNT(*) as trades,
  AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) as win_rate,
  SUM(pnl) as total_pnl
FROM trades
WHERE outcome != 'OPEN'
GROUP BY edge_bucket
ORDER BY edge_bucket;
```

### Signal quality
```sql
SELECT
  date(created_at) as day,
  COUNT(*) as signals,
  SUM(fired) as fired,
  AVG(edge_pct) as avg_edge,
  AVG(confidence) as avg_confidence
FROM signals
GROUP BY day
ORDER BY day DESC;
```

### Go/no-go summary
```sql
SELECT
  COUNT(*) as total_trades,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
  ROUND(AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as win_rate_pct,
  ROUND(AVG(edge_at_signal), 2) as avg_edge_pct,
  ROUND(SUM(pnl), 2) as total_pnl,
  ROUND(MAX(simulated_size / 1000.0 * 100), 1) as max_position_pct
FROM trades
WHERE outcome != 'OPEN';
```

## Go/no-go decision framework

After 200 trades, compute the above summary query. Go live only if:
1. win_rate_pct > 70
2. avg_edge_pct > 6.0
3. total_pnl > 0 (positive expected value confirmed)
4. No kill switch events in the last 30 days of paper trading
5. Edge compression < 50% from week 1 to week 4 (edge not decaying rapidly)

If criteria not met: do NOT go live. Analyze why and pivot strategy.
