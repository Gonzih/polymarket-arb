"""
CLI entry point for the Polymarket latency arbitrage bot.
"""
import argparse
import asyncio
import logging
import signal
import sys
import time
from datetime import datetime, date
from pathlib import Path
from typing import List, Optional

from .config import Config
from .binance import BinanceClient, PriceState
from .polymarket import PolymarketClient, Contract
from .signal import calculate_signal, Signal
from .risk import RiskManager, KillSwitchError, TotalShutdownError, PositionRecord
from .telegram import TelegramAlerter
from .db import TradeDB
from .dashboard import Dashboard

logger = logging.getLogger("polymarket_arb")


def setup_logging(log_path: str, verbose: bool = False):
    level = logging.DEBUG if verbose else logging.INFO
    fmt = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
    # Use stdout only — launchd redirects stdout to the log file via StandardOutPath.
    # Adding a FileHandler would cause double-logging when running as a daemon.
    handlers = [logging.StreamHandler(sys.stdout)]
    logging.basicConfig(level=level, format=fmt, handlers=handlers)


def parse_args():
    p = argparse.ArgumentParser(
        description="Polymarket latency arbitrage bot",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Paper mode (default/safe):
  python -m polymarket_arb --paper

Live trading (requires all three flags):
  python -m polymarket_arb --live --confirm-live --i-understand-the-risks
        """,
    )
    p.add_argument("--paper", action="store_true", default=True, help="Run in paper mode (default)")
    p.add_argument("--live", action="store_true", help="Enable live trading (requires --confirm-live and --i-understand-the-risks)")
    p.add_argument("--confirm-live", action="store_true", help="Confirm live trading")
    p.add_argument("--i-understand-the-risks", action="store_true", dest="risks_acknowledged", help="Acknowledge trading risks")
    p.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")
    p.add_argument("--no-dashboard", action="store_true", help="Disable Rich dashboard")
    p.add_argument("--portfolio", type=float, help="Starting portfolio size in USDC")
    return p.parse_args()


class ArbBot:
    def __init__(self, config: Config, paper: bool):
        self.config = config
        self.paper = paper
        self.price_state = PriceState()
        self.db = TradeDB(config.db_path)
        self.risk = RiskManager(
            initial_portfolio=config.initial_portfolio,
            max_position_pct=config.max_position_pct,
            daily_halt_pct=config.daily_drawdown_halt_pct,
            total_shutdown_pct=config.total_drawdown_shutdown_pct,
        )
        self.telegram = TelegramAlerter(config.telegram_bot_token, config.telegram_chat_id)
        self.poly = PolymarketClient(
            host=config.polymarket_host,
            api_key=config.polymarket_api_key,
            api_secret=config.polymarket_api_secret,
            api_passphrase=config.polymarket_api_passphrase,
            private_key=config.polymarket_private_key,
            paper=paper,
        )
        self.binance = BinanceClient(
            price_state=self.price_state,
            ws_url=config.binance_ws_url,
            streams=config.binance_streams,
            on_kline=self._on_kline,
        )
        self.dashboard: Optional[Dashboard] = None
        self._running = False
        self._kline_count = 0
        self._last_signal_scan = 0.0

    def _on_kline(self, kline):
        """Called on every Binance kline — trigger signal scan."""
        self._kline_count += 1
        # Debounce: scan at most every 1 second
        now = time.time()
        if now - self._last_signal_scan > 1.0:
            self._last_signal_scan = now
            asyncio.get_event_loop().call_soon_threadsafe(
                lambda: asyncio.ensure_future(self._scan_signals())
            )

    async def _scan_signals(self):
        """Scan all active contracts for tradeable edges."""
        try:
            self.risk.check_kill_switches()
        except (KillSwitchError, TotalShutdownError):
            return

        # Tick simulated contracts with current CEX data
        self.poly.tick_sim_contracts(
            self.price_state.btc_1m_change_pct,
            self.price_state.eth_1m_change_pct,
        )

        contracts = await self.poly.get_active_contracts()

        for contract in contracts:
            if contract.is_expired:
                await self._resolve_expired_contract(contract)
                continue

            # Only trade contracts with >1 min remaining (avoid last-minute noise)
            if contract.minutes_remaining < 1.0:
                continue

            cex_price = self.price_state.get_price(contract.asset)
            cex_change = self.price_state.get_1m_change(contract.asset)
            stale = self.price_state.is_stale(contract.asset)

            sig = calculate_signal(
                asset=contract.asset,
                contract_id=contract.condition_id,
                direction=contract.direction,
                cex_price=cex_price,
                cex_change_1m_pct=cex_change,
                poly_yes_price=contract.yes_price,
                cex_stale=stale,
                kelly_fraction=self.config.kelly_fraction,
                max_position_pct=self.config.max_position_pct,
                lag_threshold_pct=self.config.lag_detection_pct,
            )

            if sig is None:
                continue

            if self.dashboard:
                self.dashboard.add_signal(sig)

            # Log to DB
            fired = sig.passes_gate
            skip_reason = ""
            fire_reason = ""

            if fired:
                allowed, reason = self.risk.can_open_position(
                    self.risk.current_equity * sig.kelly_size_pct / 100.0
                )
                if not allowed:
                    fired = False
                    skip_reason = f"Risk: {reason}"
                else:
                    fire_reason = f"edge={sig.edge_pct:.1f}% conf={sig.confidence:.2f}"

            self.db.log_signal(
                asset=contract.asset,
                contract_id=contract.condition_id,
                edge_pct=sig.edge_pct,
                confidence=sig.confidence,
                cex_price=cex_price,
                poly_odds=sig.poly_odds,
                fired=fired,
                fire_reason=fire_reason,
                skip_reason=skip_reason or (
                    "edge<5%" if sig.edge_pct < self.config.min_edge_pct
                    else "conf<85%" if sig.confidence < self.config.min_confidence
                    else ""
                ),
            )

            if fired:
                await self._execute_trade(contract, sig)

    async def _execute_trade(self, contract: Contract, sig: Signal):
        """Execute (or simulate) a trade."""
        size_usdc = self.risk.current_equity * sig.kelly_size_pct / 100.0
        size_usdc = min(size_usdc, self.risk.current_equity * self.config.max_position_pct / 100.0)

        if size_usdc < 1.0:
            logger.debug("Position size too small: $%.2f", size_usdc)
            return

        entry_price = sig.poly_odds

        logger.info(
            "[%s] %s %s %s | edge=%.1f%% conf=%.0f%% size=$%.2f entry=%.3f",
            "PAPER" if self.paper else "LIVE",
            contract.asset,
            contract.direction,
            sig.direction,
            sig.edge_pct,
            sig.confidence * 100,
            size_usdc,
            entry_price,
        )

        try:
            order = await self.poly.place_order(
                contract=contract,
                side=sig.direction,
                size_usdc=size_usdc,
                price=entry_price,
                paper=self.paper,
            )
        except Exception as e:
            logger.error("Order failed: %s", e)
            return

        trade_id = self.db.open_trade(
            asset=contract.asset,
            contract_id=contract.condition_id,
            direction=sig.direction,
            paper=self.paper,
            edge_at_signal=sig.edge_pct,
            confidence=sig.confidence,
            kelly_size=sig.kelly_size_pct,
            simulated_size=size_usdc,
            entry_price=entry_price,
        )

        self.risk.add_position(
            PositionRecord(
                contract_id=contract.condition_id,
                asset=contract.asset,
                size_usdc=size_usdc,
                entry_price=entry_price,
                trade_id=trade_id,
            )
        )

        await self.telegram.alert_trade(
            contract.asset, sig.direction, size_usdc, sig.edge_pct, self.paper
        )

    async def _resolve_expired_contract(self, contract: Contract):
        """Close open positions on expired contracts."""
        pos = self.risk.close_position(contract.condition_id)
        if pos is None:
            return

        # Determine outcome: in paper mode, use final simulated price
        exit_price = contract.yes_price if pos.entry_price > 0 else 0.5
        # Rough P&L: if we paid 'entry_price' for a YES token and it resolves at 'exit_price'
        pnl = pos.size_usdc * (exit_price / pos.entry_price - 1.0)
        outcome = "WIN" if pnl > 0 else "LOSS"

        self.db.close_trade(pos.trade_id, exit_price, pnl, outcome)

        try:
            self.risk.update_equity(pnl)
        except (KillSwitchError, TotalShutdownError) as e:
            logger.warning("Kill switch after trade resolution: %s", e)
            await self.telegram.alert_kill_switch(str(e), self.risk.current_equity)
            if isinstance(e, TotalShutdownError):
                self._running = False

        self._update_daily_stats()
        logger.info("Closed %s %s | P&L=$%.2f (%s)", contract.asset, contract.direction, pnl, outcome)

    def _update_daily_stats(self):
        today = date.today().isoformat()
        open_t = self.db.get_recent_trades(1000)
        wins = sum(1 for t in open_t if t["outcome"] == "WIN")
        losses = sum(1 for t in open_t if t["outcome"] == "LOSS")
        self.db.upsert_daily_stats(
            date=today,
            starting_equity=self.risk.day_start_equity,
            ending_equity=self.risk.current_equity,
            trades_count=wins + losses,
            wins=wins,
            losses=losses,
            max_drawdown=self.risk.daily_drawdown_pct,
            halted=self.risk.halted,
        )

    async def run(self, show_dashboard: bool = True):
        self._running = True
        logger.info("Starting Polymarket Arb Bot — mode=%s", "PAPER" if self.paper else "LIVE")

        await self.poly.initialize()
        await self.binance.start()
        await self.telegram.alert_startup(self.paper)

        if show_dashboard:
            self.dashboard = Dashboard(
                db=self.db,
                price_state=self.price_state,
                risk=self.risk,
                paper=self.paper,
            )
            dashboard_task = asyncio.create_task(self.dashboard.start())
        else:
            dashboard_task = None

        # Periodic maintenance loop
        try:
            while self._running:
                await asyncio.sleep(5)
                self._update_daily_stats()

                # Periodic signal scan even without kline (fallback)
                now = time.time()
                if now - self._last_signal_scan > 10.0:
                    await self._scan_signals()

        except asyncio.CancelledError:
            pass
        finally:
            logger.info("Shutting down...")
            await self.binance.stop()
            if dashboard_task:
                dashboard_task.cancel()
                try:
                    await dashboard_task
                except asyncio.CancelledError:
                    pass
            self.db.close()
            await self.telegram.alert_shutdown("Bot stopped")


def main():
    args = parse_args()

    # Determine paper vs live
    paper = True
    if args.live:
        if not (args.confirm_live and args.risks_acknowledged):
            print(
                "ERROR: Live trading requires all three flags:\n"
                "  --live --confirm-live --i-understand-the-risks\n"
                "Running in paper mode instead.",
                file=sys.stderr,
            )
        else:
            paper = False
            print("⚡ LIVE TRADING ENABLED — real money at risk", file=sys.stderr)

    config = Config(paper_mode=paper)
    if args.portfolio:
        config.initial_portfolio = args.portfolio

    setup_logging(config.log_path, args.verbose)

    logger.info("=" * 60)
    logger.info("Polymarket Arb Bot starting — mode=%s", "PAPER" if paper else "LIVE")
    logger.info("Portfolio: $%.2f", config.initial_portfolio)
    logger.info("DB: %s", config.db_path)
    logger.info("=" * 60)

    bot = ArbBot(config=config, paper=paper)
    show_dashboard = not args.no_dashboard

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def _shutdown(sig, frame):
        logger.info("Received signal %s — initiating shutdown", sig)
        bot._running = False
        loop.stop()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    try:
        loop.run_until_complete(bot.run(show_dashboard=show_dashboard))
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
    finally:
        loop.close()


if __name__ == "__main__":
    main()
