"""
Rich terminal dashboard — P&L, win rate, open positions, live prices, edges.
"""
import logging
from datetime import datetime
from typing import TYPE_CHECKING, List, Optional

if TYPE_CHECKING:
    from .db import TradeDB
    from .binance import PriceState
    from .risk import RiskManager

logger = logging.getLogger(__name__)


def _try_rich():
    try:
        from rich.live import Live
        from rich.table import Table
        from rich.panel import Panel
        from rich.columns import Columns
        from rich.text import Text
        from rich.console import Console
        from rich import box
        return True
    except ImportError:
        return False


HAS_RICH = _try_rich()


def _color_pnl(val: float) -> str:
    if val > 0:
        return f"[green]+${val:.2f}[/green]"
    elif val < 0:
        return f"[red]-${abs(val):.2f}[/red]"
    return f"$0.00"


def _pct_color(val: float) -> str:
    if val > 0:
        return f"[green]+{val:.2f}%[/green]"
    elif val < 0:
        return f"[red]{val:.2f}%[/red]"
    return "0.00%"


class Dashboard:
    def __init__(
        self,
        db: "TradeDB",
        price_state: "PriceState",
        risk: "RiskManager",
        paper: bool = True,
        refresh_interval: float = 1.0,
    ):
        self.db = db
        self.price_state = price_state
        self.risk = risk
        self.paper = paper
        self.refresh_interval = refresh_interval
        self._live = None
        self._running = False
        self._last_signals: list = []

    def add_signal(self, sig):
        """Track recent signals for display."""
        self._last_signals.append(sig)
        if len(self._last_signals) > 20:
            self._last_signals.pop(0)

    def _build_layout(self):
        if not HAS_RICH:
            return None

        from rich.table import Table
        from rich.panel import Panel
        from rich.columns import Columns
        from rich.text import Text
        from rich import box
        from rich.console import Group

        mode_str = "[yellow]PAPER[/yellow]" if self.paper else "[bold red]LIVE[/bold red]"
        ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")

        # Header
        header = Panel(
            f"[bold cyan]Polymarket Arb Bot[/bold cyan] — Mode: {mode_str} — {ts}",
            style="cyan",
        )

        # Prices & equity
        stats_table = Table(box=box.ROUNDED, expand=True, title="Portfolio & Prices")
        stats_table.add_column("Metric", style="cyan")
        stats_table.add_column("Value", justify="right")

        total_pnl = self.db.total_pnl()
        win_rate = self.db.win_rate()
        stats_table.add_row("Equity", f"${self.risk.current_equity:.2f}")
        stats_table.add_row("Total P&L", _color_pnl(total_pnl))
        stats_table.add_row("Win Rate", f"{win_rate*100:.1f}%")
        stats_table.add_row("Daily DD", f"[{'red' if self.risk.daily_drawdown_pct > 10 else 'white'}]{self.risk.daily_drawdown_pct:.1f}%[/{'red' if self.risk.daily_drawdown_pct > 10 else 'white'}]")
        stats_table.add_row("Open Positions", str(len(self.risk.open_positions)))
        stats_table.add_row(
            "BTC Price",
            f"${self.price_state.btc_price:,.2f} ({_pct_color(self.price_state.btc_1m_change_pct)})",
        )
        stats_table.add_row(
            "ETH Price",
            f"${self.price_state.eth_price:,.2f} ({_pct_color(self.price_state.eth_1m_change_pct)})",
        )
        status = "[green]RUNNING[/green]"
        if self.risk.shutdown:
            status = "[bold red]SHUTDOWN[/bold red]"
        elif self.risk.halted:
            status = "[yellow]HALTED[/yellow]"
        stats_table.add_row("Status", status)

        # Recent trades
        recent = self.db.get_recent_trades(10)
        trades_table = Table(box=box.ROUNDED, expand=True, title="Last 10 Trades")
        trades_table.add_column("Time", style="dim")
        trades_table.add_column("Asset")
        trades_table.add_column("Dir")
        trades_table.add_column("Edge%", justify="right")
        trades_table.add_column("P&L", justify="right")
        trades_table.add_column("Outcome")

        for t in recent:
            pnl = t["pnl"] or 0.0
            outcome_color = "green" if t["outcome"] == "WIN" else "red"
            trades_table.add_row(
                (t["resolved_at"] or "")[:16],
                t["asset"],
                t["direction"],
                f"{t['edge_at_signal']:.1f}%",
                _color_pnl(pnl),
                f"[{outcome_color}]{t['outcome']}[/{outcome_color}]",
            )

        # Recent signals
        sigs_table = Table(box=box.ROUNDED, expand=True, title="Recent Signals (last 10)")
        sigs_table.add_column("Time", style="dim")
        sigs_table.add_column("Asset")
        sigs_table.add_column("Edge%", justify="right")
        sigs_table.add_column("Conf", justify="right")
        sigs_table.add_column("Fired?")

        for s in self._last_signals[-10:]:
            fired_str = "[green]YES[/green]" if getattr(s, 'fired', False) else "[dim]no[/dim]"
            sigs_table.add_row(
                datetime.utcnow().strftime("%H:%M:%S"),
                getattr(s, 'asset', '?'),
                f"{getattr(s, 'edge_pct', 0):.1f}%",
                f"{getattr(s, 'confidence', 0)*100:.0f}%",
                fired_str,
            )

        return Group(header, Columns([stats_table, trades_table]), sigs_table)

    async def start(self):
        if not HAS_RICH:
            logger.info("Rich not installed — dashboard disabled (install: pip install rich)")
            return

        import asyncio
        from rich.live import Live
        from rich.console import Console

        console = Console()
        self._running = True

        with Live(
            self._build_layout(),
            refresh_per_second=1,
            console=console,
            screen=False,
        ) as live:
            self._live = live
            while self._running:
                layout = self._build_layout()
                if layout:
                    live.update(layout)
                await asyncio.sleep(self.refresh_interval)

    def stop(self):
        self._running = False
