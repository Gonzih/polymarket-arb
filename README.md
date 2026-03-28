# polymarket-arb

Polymarket latency arbitrage bot. Monitors BTC/ETH 5-min and 15-min up/down contracts on Polymarket and detects when odds lag Binance price movements. Paper trading mode by default — three explicit flags required for live trading.

> **This is a research tool.** Paper trading only by default. See RESEARCH.md for the testing plan.

## Install & run

### Via npx (recommended)
```bash
npx polymarket-arb --paper
```

### Via pip
```bash
pip install polymarket-arb
python -m polymarket_arb --paper
```

### From source
```bash
git clone https://github.com/Gonzih/polymarket-arb
cd polymarket-arb
pip install -e ".[dev]"
python -m polymarket_arb --paper
```

## How it works

1. **Binance WebSocket** streams `btcusdt@kline_1m` and `ethusdt@kline_1m` 1-minute klines
2. **Edge detection**: when 1-min momentum > threshold AND Polymarket odds lag CEX by > 3%, a signal is generated
3. **Trade gate**: edge > 5% AND confidence > 85% AND position < 8% of portfolio
4. **Half-Kelly sizing**: `f* = 0.5 × (p - q/b)`
5. **Paper mode**: logs every would-be trade with simulated P&L resolved at contract expiry
6. **Kill switches**: daily drawdown > 20% halts trading; total > 40% shuts down

## Configuration

All settings via environment variables (sane defaults provided):

| Variable | Default | Description |
|---|---|---|
| `POLYMARKET_API_KEY` | — | CLOB API key (optional, paper works without) |
| `POLYMARKET_API_SECRET` | — | CLOB API secret |
| `POLYMARKET_API_PASSPHRASE` | — | CLOB API passphrase |
| `POLYMARKET_PRIVATE_KEY` | — | Ethereum private key (live only) |
| `TELEGRAM_BOT_TOKEN` | — | Telegram alerts (optional) |
| `TELEGRAM_CHAT_ID` | — | Telegram chat ID |
| `INITIAL_PORTFOLIO` | 1000 | Starting portfolio in USDC |
| `MIN_EDGE_PCT` | 5.0 | Minimum edge % to trade |
| `MIN_CONFIDENCE` | 0.85 | Minimum confidence (0-1) |
| `MAX_POSITION_PCT` | 8.0 | Max position as % of portfolio |
| `KELLY_FRACTION` | 0.5 | Half-Kelly multiplier |
| `DAILY_DRAWDOWN_HALT_PCT` | 20.0 | Daily DD % that halts trading |
| `TOTAL_DRAWDOWN_SHUTDOWN_PCT` | 40.0 | Total DD % that shuts down bot |

## Live trading

Live trading requires **three explicit flags**:

```bash
python -m polymarket_arb --live --confirm-live --i-understand-the-risks
```

Additionally requires: `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`, `POLYMARKET_PRIVATE_KEY`.

**Do not run live until paper trading success criteria are met.** See RESEARCH.md.

## Data

- **Trades DB**: `~/.polymarket-arb/trades.db` (SQLite)
- **Logs**: `~/.polymarket-arb/polymarket-arb.log`

### Useful queries
```bash
# Win rate today
sqlite3 ~/.polymarket-arb/trades.db \
  "SELECT COUNT(*), AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) as win_rate \
   FROM trades WHERE date(created_at) = date('now')"

# Total P&L
sqlite3 ~/.polymarket-arb/trades.db "SELECT SUM(pnl) FROM trades WHERE outcome!='OPEN'"
```

## launchd daemon (macOS)

Run as a background daemon with auto-restart:

```bash
# Already configured at ~/Library/LaunchAgents/com.polymarket-arb.plist
launchctl start com.polymarket-arb

# Check logs
tail -f ~/.polymarket-arb/polymarket-arb.log
```

## Architecture

```
polymarket_arb/
  config.py     — all thresholds from env vars
  binance.py    — Binance WS client, kline streams, PriceState
  polymarket.py — CLOB wrapper + simulated fallback contracts
  signal.py     — edge calc, confidence, half-Kelly sizing
  risk.py       — kill switches, drawdown tracker, position limits
  telegram.py   — alert sender (no-op if not configured)
  db.py         — SQLite trade log (stdlib only)
  dashboard.py  — Rich terminal dashboard
  main.py       — CLI entry point
```

## Disclaimer

This software is for research and educational purposes. Crypto trading involves substantial risk of loss. The paper trading results do not guarantee live trading performance. Only trade with money you can afford to lose entirely.
