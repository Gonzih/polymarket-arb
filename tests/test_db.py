"""Tests for the SQLite trade log."""
import os
import tempfile
import pytest
from polymarket_arb.db import TradeDB


@pytest.fixture
def db():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        path = f.name
    db = TradeDB(path)
    yield db
    db.close()
    os.unlink(path)


def test_log_signal(db):
    sig_id = db.log_signal(
        asset="BTC",
        contract_id="test_cid",
        edge_pct=7.5,
        confidence=0.90,
        cex_price=60000.0,
        poly_odds=0.50,
        fired=True,
        fire_reason="edge=7.5% conf=0.90",
    )
    assert sig_id > 0


def test_open_and_close_trade(db):
    trade_id = db.open_trade(
        asset="BTC",
        contract_id="test_cid",
        direction="YES",
        paper=True,
        edge_at_signal=7.5,
        confidence=0.90,
        kelly_size=4.5,
        simulated_size=45.0,
        entry_price=0.60,
    )
    assert trade_id > 0

    open_trades = db.get_open_trades()
    assert len(open_trades) == 1
    assert open_trades[0]["asset"] == "BTC"

    db.close_trade(trade_id, exit_price=1.0, pnl=30.0, outcome="WIN")

    open_trades = db.get_open_trades()
    assert len(open_trades) == 0

    recent = db.get_recent_trades(10)
    assert len(recent) == 1
    assert recent[0]["outcome"] == "WIN"


def test_win_rate_empty(db):
    assert db.win_rate() == 0.0


def test_win_rate_calculation(db):
    for i, (pnl, outcome) in enumerate([(10.0, "WIN"), (-5.0, "LOSS"), (8.0, "WIN")]):
        tid = db.open_trade("ETH", f"cid_{i}", "YES", True, 6.0, 0.88, 3.0, 30.0, 0.55)
        db.close_trade(tid, 1.0 if pnl > 0 else 0.0, pnl, outcome)
    # 2/3 wins = 0.667
    wr = db.win_rate()
    assert abs(wr - 2 / 3) < 0.001


def test_total_pnl(db):
    assert db.total_pnl() == 0.0
    tid = db.open_trade("BTC", "cid_x", "YES", True, 7.0, 0.90, 4.0, 40.0, 0.60)
    db.close_trade(tid, 1.0, 25.0, "WIN")
    assert abs(db.total_pnl() - 25.0) < 0.001


def test_upsert_daily_stats(db):
    db.upsert_daily_stats("2026-03-28", 1000.0, 1050.0, 5, 4, 1, 2.5)
    row = db.get_daily_stats("2026-03-28")
    assert row is not None
    assert row["wins"] == 4
    assert row["losses"] == 1

    # Update
    db.upsert_daily_stats("2026-03-28", 1000.0, 1080.0, 8, 6, 2, 3.0)
    row = db.get_daily_stats("2026-03-28")
    assert row["wins"] == 6
    assert abs(row["ending_equity"] - 1080.0) < 0.001
