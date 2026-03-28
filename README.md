# polymarket-arb

Claude-powered Polymarket arbitrage bot. Monitors BTC/ETH price feeds, detects 30-second momentum signals, finds matching Polymarket contracts expiring within 20 minutes, and uses Claude AI to assess each trade opportunity before entering.

## How it works

1. **Price feeds** — connects to Binance WebSocket (with Coinbase fallback on 451 geo-block) for real-time BTC/ETH prices
2. **Signal detection** — fires when |30s momentum| > 0.35%
3. **Contract discovery** — queries Polymarket GraphQL for open BTC/ETH up/down contracts expiring within 20 minutes
4. **Claude analysis** — sends signal + contract data to `claude-haiku-4-5-20251001` for confidence score, Kelly fraction, and reasoning
5. **Trade entry** — only enters if Claude confidence > 0.65; sizes position using Kelly Criterion (capped at 10%)
6. **Risk management** — daily loss limit -20%, total drawdown kill switch -40%

## Installation

```bash
npm install -g @gonzih/polymarket-arb
```

## Usage

```bash
# Paper trading (default, safe)
ANTHROPIC_API_KEY=sk-... polymarket-arb --paper

# Live trading
ANTHROPIC_API_KEY=sk-... POLYMARKET_API_KEY=... POLYMARKET_SECRET=... polymarket-arb --live
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Claude API key |
| `POLYMARKET_API_KEY` | Live only | — | Polymarket CLOB API key |
| `POLYMARKET_SECRET` | Live only | — | Polymarket API secret |
| `PAPER_MODE` | No | `true` | Set `false` for live trading |
| `LOG_DIR` | No | `~/.polymarket-arb` | Log directory |

## Logs

Structured JSON logs written to `~/.polymarket-arb/trades.jsonl`. Each line is a JSON object with `timestamp`, `level`, and event-specific fields.

## macOS daemon (launchd)

A launchd plist is included (`com.polymarket-arb.plist`). Install:

```bash
# Edit REPLACE_ME with your API key first
cp com.polymarket-arb.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.polymarket-arb.plist
```

## Architecture

```
src/
  index.ts      — CLI entry point
  feeds.ts      — Binance + Coinbase WebSocket managers
  signal.ts     — 30s momentum calculation
  polymarket.ts — GraphQL contract discovery + CLOB order placement
  claude.ts     — Anthropic SDK integration, trade analysis
  kelly.ts      — Kelly Criterion position sizing, risk limits
  logger.ts     — Structured JSON logging
  daemon.ts     — Main bot loop, kill switch logic
```

## License

MIT
