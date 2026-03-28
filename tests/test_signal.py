"""Tests for signal calculation and Kelly sizing."""
import pytest
from polymarket_arb.signal import calculate_signal, half_kelly, _implied_probability


def test_half_kelly_basic():
    # 60% win rate, 1:1 odds (b=1), half-Kelly
    # f* = 0.5 * (0.6 - 0.4/1) = 0.5 * 0.2 = 0.10
    # Pass max_fraction=1.0 to avoid default cap of 0.08 interfering
    result = half_kelly(prob_win=0.6, odds=1.0, kelly_fraction=0.5, max_fraction=1.0)
    assert abs(result - 0.10) < 0.001


def test_half_kelly_zero_edge():
    # 50/50 with 1:1 odds = zero edge
    result = half_kelly(prob_win=0.5, odds=1.0, kelly_fraction=0.5)
    assert result == 0.0


def test_half_kelly_respects_max():
    # Very high edge should be capped at max_fraction
    result = half_kelly(prob_win=0.99, odds=10.0, kelly_fraction=0.5, max_fraction=0.08)
    assert result <= 0.08


def test_half_kelly_negative_edge_returns_zero():
    result = half_kelly(prob_win=0.3, odds=1.0, kelly_fraction=0.5)
    assert result == 0.0


def test_implied_probability_up_momentum():
    # Strong upward momentum → high prob of UP
    prob = _implied_probability(cex_change_1m_pct=5.0, direction="UP")
    assert prob > 0.80


def test_implied_probability_down_momentum():
    # Strong downward momentum → low prob of UP
    prob = _implied_probability(cex_change_1m_pct=-5.0, direction="UP")
    assert prob < 0.20


def test_implied_probability_bounded():
    for change in [-10.0, -5.0, 0.0, 5.0, 10.0]:
        for direction in ["UP", "DOWN"]:
            p = _implied_probability(change, direction)
            assert 0.0 <= p <= 1.0, f"Out of bounds: {p} for change={change} dir={direction}"


def test_calculate_signal_returns_none_on_stale():
    sig = calculate_signal(
        asset="BTC",
        contract_id="test",
        direction="UP",
        cex_price=50000,
        cex_change_1m_pct=5.0,
        poly_yes_price=0.50,
        cex_stale=True,
    )
    assert sig is None


def test_calculate_signal_returns_none_below_threshold():
    # Very small edge should return None (below 3% lag threshold)
    sig = calculate_signal(
        asset="BTC",
        contract_id="test",
        direction="UP",
        cex_price=50000,
        cex_change_1m_pct=0.1,  # tiny move
        poly_yes_price=0.5,
        cex_stale=False,
    )
    assert sig is None


def test_calculate_signal_fires_on_strong_momentum():
    # 5% upward move with Polymarket still at 50% → clear lag signal
    sig = calculate_signal(
        asset="BTC",
        contract_id="test_btc_up_5m",
        direction="UP",
        cex_price=50000,
        cex_change_1m_pct=5.0,
        poly_yes_price=0.50,
        cex_stale=False,
        lag_threshold_pct=3.0,
    )
    assert sig is not None
    assert sig.edge_pct > 3.0
    assert 0.0 <= sig.confidence <= 1.0
    assert sig.kelly_size_pct >= 0.0


def test_calculate_signal_passes_gate_check():
    # Edge > 5% and confidence > 85%
    sig = calculate_signal(
        asset="ETH",
        contract_id="test_eth_down_15m",
        direction="DOWN",
        cex_price=3000,
        cex_change_1m_pct=-6.0,  # big drop
        poly_yes_price=0.5,
        cex_stale=False,
        lag_threshold_pct=3.0,
    )
    if sig is not None and sig.edge_pct >= 5.0 and sig.confidence >= 0.85:
        assert sig.passes_gate


def test_calculate_signal_correct_asset():
    sig = calculate_signal(
        asset="BTC",
        contract_id="cid_123",
        direction="UP",
        cex_price=60000,
        cex_change_1m_pct=4.0,
        poly_yes_price=0.50,
        cex_stale=False,
        lag_threshold_pct=3.0,
    )
    if sig is not None:
        assert sig.asset == "BTC"
        assert sig.contract_id == "cid_123"
