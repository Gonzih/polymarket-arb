#!/usr/bin/env node
import { TradingDaemon } from "./daemon.js";
import { log, logDir } from "./logger.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`polymarket-arb — Claude-powered prediction market arbitrage bot

Usage: polymarket-arb [options]

Options:
  --paper       Paper trading mode (default, no real orders)
  --live        Live trading mode (requires POLYMARKET_API_KEY + POLYMARKET_SECRET)
  --log-dir     Override log directory (default: ~/.polymarket-arb)
  --help        Show this help

Environment variables:
  POLYMARKET_API_KEY    Required for live trading
  POLYMARKET_SECRET     Required for live trading
  PAPER_MODE=true       Default paper mode (overridden by --live flag)
  LOG_DIR               Log directory path

Log directory: ${logDir()}
`);
  process.exit(0);
}

// Determine paper mode
const paperMode = args.includes("--live")
  ? false
  : args.includes("--paper")
  ? true
  : process.env.PAPER_MODE !== "false";

if (!paperMode && !process.env.POLYMARKET_API_KEY) {
  console.error("ERROR: --live mode requires POLYMARKET_API_KEY environment variable");
  process.exit(1);
}

log("info", {
  event: "startup",
  mode: paperMode ? "paper" : "live",
  logDir: logDir(),
  nodeVersion: process.version,
});

if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  log("info", { event: "claude_auth", method: "oauth_token" });
} else {
  log("warn", { event: "claude_auth", method: "credential_file", note: "no CLAUDE_CODE_OAUTH_TOKEN set" });
}

const daemon = new TradingDaemon(paperMode);
daemon.start();

// Graceful shutdown
process.on("SIGTERM", () => {
  log("info", { event: "sigterm_received" });
  daemon.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  log("info", { event: "sigint_received" });
  daemon.stop();
  process.exit(0);
});
