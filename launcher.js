#!/usr/bin/env node
/**
 * npx launcher for polymarket-arb.
 * 1. Ensures Python 3.11+ is available
 * 2. pip-installs polymarket-arb if not already installed
 * 3. Passes all CLI args through to `python3 -m polymarket_arb`
 */

"use strict";

const { execSync, spawnSync } = require("child_process");
const process = require("process");

const PACKAGE = "polymarket-arb";
const MIN_PYTHON_MINOR = 11;

function findPython() {
  for (const cmd of ["python3", "python"]) {
    try {
      const result = spawnSync(cmd, ["--version"], { encoding: "utf8" });
      if (result.status === 0) {
        const ver = (result.stdout || result.stderr || "").trim();
        const m = ver.match(/Python (\d+)\.(\d+)/);
        if (m && parseInt(m[1]) === 3 && parseInt(m[2]) >= MIN_PYTHON_MINOR) {
          return cmd;
        }
      }
    } catch (_) {}
  }
  return null;
}

function isInstalled(python) {
  try {
    const r = spawnSync(
      python,
      ["-c", "import polymarket_arb; print(polymarket_arb.__version__)"],
      { encoding: "utf8" }
    );
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

function install(python) {
  console.log(`[polymarket-arb] Installing Python package via pip...`);
  const r = spawnSync(
    python,
    ["-m", "pip", "install", "--quiet", PACKAGE],
    { stdio: "inherit" }
  );
  if (r.status !== 0) {
    console.error("[polymarket-arb] pip install failed. Trying pip3...");
    spawnSync("pip3", ["install", "--quiet", PACKAGE], { stdio: "inherit" });
  }
}

function main() {
  const args = process.argv.slice(2);

  // --help short-circuit (before Python check)
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
polymarket-arb — Polymarket latency arbitrage bot

Usage:
  npx polymarket-arb [options]
  npx polymarket-arb --paper           # Safe paper trading mode (default)
  npx polymarket-arb --live --confirm-live --i-understand-the-risks

Options:
  --paper               Paper trading mode (default, safe)
  --live                Enable live trading (requires 2 additional flags)
  --confirm-live        Confirm live mode
  --i-understand-the-risks  Final live mode confirmation
  --portfolio FLOAT     Starting portfolio size in USDC (default: 1000)
  --no-dashboard        Disable Rich terminal dashboard
  --verbose, -v         Verbose logging
  --help, -h            Show this help

Environment variables:
  POLYMARKET_API_KEY        Polymarket API key (optional, paper works without)
  POLYMARKET_API_SECRET     Polymarket API secret
  POLYMARKET_API_PASSPHRASE Polymarket API passphrase
  POLYMARKET_PRIVATE_KEY    Ethereum private key for live trading
  TELEGRAM_BOT_TOKEN        Telegram bot token for alerts (optional)
  TELEGRAM_CHAT_ID          Telegram chat ID for alerts (optional)
  INITIAL_PORTFOLIO         Starting portfolio (default: 1000)

Data:
  Trades DB:  ~/.polymarket-arb/trades.db
  Logs:       ~/.polymarket-arb/polymarket-arb.log
`);
    process.exit(0);
  }

  const python = findPython();
  if (!python) {
    console.error(
      `[polymarket-arb] Python 3.${MIN_PYTHON_MINOR}+ is required but not found.\n` +
      `Install from https://python.org`
    );
    process.exit(1);
  }

  if (!isInstalled(python)) {
    install(python);
  }

  // Pass through to python -m polymarket_arb
  const finalArgs = args.length === 0 ? ["--paper"] : args;
  const result = spawnSync(python, ["-m", "polymarket_arb", ...finalArgs], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status || 0);
}

main();
