"""Tests for the RiskManager."""
import pytest
from polymarket_arb.risk import RiskManager, KillSwitchError, TotalShutdownError, PositionRecord


def make_rm(**kwargs):
    defaults = dict(
        initial_portfolio=1000.0,
        max_position_pct=8.0,
        daily_halt_pct=20.0,
        total_shutdown_pct=40.0,
    )
    defaults.update(kwargs)
    return RiskManager(**defaults)


def test_can_open_position_normal():
    rm = make_rm()
    allowed, reason = rm.can_open_position(50.0)  # 5% of 1000
    assert allowed
    assert reason == "OK"


def test_can_open_position_too_large():
    rm = make_rm()
    allowed, reason = rm.can_open_position(100.0)  # 10% > max 8%
    assert not allowed
    assert "max" in reason.lower()


def test_daily_drawdown_halt():
    rm = make_rm()
    # Apply 20% loss
    with pytest.raises(KillSwitchError):
        rm.update_equity(-200.0)  # 200 / 1000 = 20%
    assert rm.halted


def test_total_shutdown():
    rm = make_rm()
    # Position current equity near the total shutdown threshold.
    # day_start_equity matches current so daily DD stays small.
    # Then a small loss tips total DD over 40%.
    # initial=1000, shutdown at 40% total → triggers when equity < 600.
    # Start at 650 (35% down total), daily also at 650 → apply -60:
    #   daily DD = 60/650 = 9.2% (< 20% halt), total DD = 410/1000 = 41% (> 40% shutdown).
    rm.current_equity = 650.0
    rm.day_start_equity = 650.0
    with pytest.raises(TotalShutdownError):
        rm.update_equity(-60.0)
    assert rm.shutdown


def test_kill_switch_blocks_after_halt():
    rm = make_rm()
    rm.halted = True
    with pytest.raises(KillSwitchError):
        rm.check_kill_switches()


def test_position_tracking():
    rm = make_rm()
    pos = PositionRecord(
        contract_id="test_cid",
        asset="BTC",
        size_usdc=50.0,
        entry_price=0.6,
        trade_id=1,
    )
    rm.add_position(pos)
    assert rm.position_count("BTC") == 1
    assert rm.total_open_exposure == 50.0

    closed = rm.close_position("test_cid")
    assert closed is not None
    assert rm.position_count("BTC") == 0
    assert rm.total_open_exposure == 0.0


def test_close_nonexistent_position_returns_none():
    rm = make_rm()
    result = rm.close_position("nonexistent")
    assert result is None


def test_daily_drawdown_resets_to_zero_at_start():
    rm = make_rm()
    assert rm.daily_drawdown_pct == 0.0
    assert rm.total_drawdown_pct == 0.0
