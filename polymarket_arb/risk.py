"""
Kill switch, drawdown tracker, and position limits.
"""
import logging
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Dict, Optional

logger = logging.getLogger(__name__)


class KillSwitchError(Exception):
    """Raised when a kill switch fires — should halt trading."""


class TotalShutdownError(Exception):
    """Raised when total drawdown limit is hit — should exit the process."""


@dataclass
class PositionRecord:
    contract_id: str
    asset: str
    size_usdc: float
    entry_price: float
    trade_id: int


@dataclass
class RiskManager:
    initial_portfolio: float
    max_position_pct: float = 8.0
    daily_halt_pct: float = 20.0
    total_shutdown_pct: float = 40.0

    # Runtime state
    current_equity: float = field(init=False)
    day_start_equity: float = field(init=False)
    current_day: str = field(init=False)
    halted: bool = field(default=False, init=False)
    shutdown: bool = field(default=False, init=False)
    open_positions: Dict[str, PositionRecord] = field(default_factory=dict, init=False)
    peak_equity: float = field(init=False)

    def __post_init__(self):
        self.current_equity = self.initial_portfolio
        self.day_start_equity = self.initial_portfolio
        self.current_day = date.today().isoformat()
        self.peak_equity = self.initial_portfolio

    def _check_day_rollover(self):
        today = date.today().isoformat()
        if today != self.current_day:
            logger.info(
                "Day rollover %s → %s | equity %.2f",
                self.current_day, today, self.current_equity,
            )
            self.current_day = today
            self.day_start_equity = self.current_equity
            self.halted = False  # Reset daily halt on new day

    def check_kill_switches(self):
        """Raise if any kill switch is triggered."""
        if self.shutdown:
            raise TotalShutdownError("Total drawdown limit reached — bot shut down")
        if self.halted:
            raise KillSwitchError("Daily drawdown halt active — trading suspended")

    def update_equity(self, pnl_delta: float):
        """Update equity after a trade closes."""
        self._check_day_rollover()
        self.current_equity += pnl_delta
        if self.current_equity > self.peak_equity:
            self.peak_equity = self.current_equity

        # Daily drawdown
        daily_dd_pct = (self.day_start_equity - self.current_equity) / self.day_start_equity * 100.0
        if daily_dd_pct >= self.daily_halt_pct and not self.halted:
            self.halted = True
            logger.warning(
                "KILL SWITCH: Daily drawdown %.1f%% >= %.1f%% — halting trading",
                daily_dd_pct, self.daily_halt_pct,
            )
            raise KillSwitchError(
                f"Daily drawdown {daily_dd_pct:.1f}% exceeds {self.daily_halt_pct}% limit"
            )

        # Total drawdown
        total_dd_pct = (self.initial_portfolio - self.current_equity) / self.initial_portfolio * 100.0
        if total_dd_pct >= self.total_shutdown_pct and not self.shutdown:
            self.shutdown = True
            logger.critical(
                "KILL SWITCH: Total drawdown %.1f%% >= %.1f%% — SHUTTING DOWN",
                total_dd_pct, self.total_shutdown_pct,
            )
            raise TotalShutdownError(
                f"Total drawdown {total_dd_pct:.1f}% exceeds {self.total_shutdown_pct}% limit"
            )

    @property
    def daily_drawdown_pct(self) -> float:
        self._check_day_rollover()
        if self.day_start_equity <= 0:
            return 0.0
        return max(0.0, (self.day_start_equity - self.current_equity) / self.day_start_equity * 100.0)

    @property
    def total_drawdown_pct(self) -> float:
        if self.initial_portfolio <= 0:
            return 0.0
        return max(0.0, (self.initial_portfolio - self.current_equity) / self.initial_portfolio * 100.0)

    @property
    def total_open_exposure(self) -> float:
        return sum(p.size_usdc for p in self.open_positions.values())

    def can_open_position(self, size_usdc: float) -> tuple[bool, str]:
        """Returns (allowed, reason)."""
        if self.shutdown:
            return False, "Total shutdown active"
        if self.halted:
            return False, "Daily halt active"

        pct_of_portfolio = size_usdc / self.current_equity * 100.0
        if pct_of_portfolio > self.max_position_pct:
            return False, f"Size {pct_of_portfolio:.1f}% > max {self.max_position_pct}%"

        max_exposure = self.current_equity * 0.5  # total 50% max
        if self.total_open_exposure + size_usdc > max_exposure:
            return False, f"Total exposure would exceed 50% of portfolio"

        return True, "OK"

    def add_position(self, record: PositionRecord):
        self.open_positions[record.contract_id] = record

    def close_position(self, contract_id: str) -> Optional[PositionRecord]:
        return self.open_positions.pop(contract_id, None)

    def position_count(self, asset: str) -> int:
        return sum(1 for p in self.open_positions.values() if p.asset == asset)
