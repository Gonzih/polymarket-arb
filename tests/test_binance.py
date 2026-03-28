"""
Unit tests for binance.py — CoinbaseFeed, PriceFeedManager, and geo-block detection.
"""
import asyncio
import time
import pytest

from polymarket_arb.binance import (
    CoinbaseFeed,
    KlineData,
    PriceFeedManager,
    PriceState,
    _is_geo_block,
)


# ---------------------------------------------------------------------------
# _is_geo_block
# ---------------------------------------------------------------------------

def test_is_geo_block_451():
    assert _is_geo_block(Exception("server rejected WebSocket connection: HTTP 451"))


def test_is_geo_block_403():
    assert _is_geo_block(Exception("HTTP 403 Forbidden"))


def test_is_geo_block_other():
    assert not _is_geo_block(Exception("Connection reset by peer"))
    assert not _is_geo_block(Exception("ping timeout"))


# ---------------------------------------------------------------------------
# CoinbaseFeed._get_change_pct
# ---------------------------------------------------------------------------

def test_coinbase_change_pct_first_call():
    feed = CoinbaseFeed(price_state=PriceState())
    pct = feed._get_change_pct("BTCUSDT", 50_000.0)
    assert pct == 0.0


def test_coinbase_change_pct_within_window():
    feed = CoinbaseFeed(price_state=PriceState())
    feed._get_change_pct("BTCUSDT", 50_000.0)
    pct = feed._get_change_pct("BTCUSDT", 51_000.0)
    assert abs(pct - 2.0) < 0.001


def test_coinbase_change_pct_resets_after_60s():
    feed = CoinbaseFeed(price_state=PriceState())
    feed._get_change_pct("BTCUSDT", 50_000.0)
    # Artificially age the baseline
    feed._price_baseline["BTCUSDT"] = (50_000.0, time.time() - 61.0)
    # First call resets the baseline to 55_000 (but still returns delta from old baseline)
    feed._get_change_pct("BTCUSDT", 55_000.0)
    # Second call: baseline is now 55_000 (fresh) → tiny change
    pct = feed._get_change_pct("BTCUSDT", 55_100.0)
    assert abs(pct - (100.0 / 55_000.0 * 100.0)) < 0.01


# ---------------------------------------------------------------------------
# CoinbaseFeed._make_kline
# ---------------------------------------------------------------------------

def test_coinbase_make_kline_btc():
    feed = CoinbaseFeed(price_state=PriceState())
    kline = feed._make_kline("BTC-USD", 67_000.0)
    assert kline is not None
    assert kline.symbol == "BTCUSDT"
    assert kline.close == 67_000.0
    assert kline.interval == "1m"


def test_coinbase_make_kline_eth():
    feed = CoinbaseFeed(price_state=PriceState())
    kline = feed._make_kline("ETH-USD", 3_500.0)
    assert kline is not None
    assert kline.symbol == "ETHUSDT"
    assert kline.close == 3_500.0


def test_coinbase_make_kline_unknown_product():
    feed = CoinbaseFeed(price_state=PriceState())
    kline = feed._make_kline("SOL-USD", 150.0)
    assert kline is None


# ---------------------------------------------------------------------------
# CoinbaseFeed._update_state
# ---------------------------------------------------------------------------

def test_coinbase_update_state_btc():
    state = PriceState()
    feed = CoinbaseFeed(price_state=state)
    kline = feed._make_kline("BTC-USD", 70_000.0)
    feed._update_state(kline)
    assert state.btc_price == 70_000.0
    assert state.btc_last_update > 0


def test_coinbase_update_state_eth():
    state = PriceState()
    feed = CoinbaseFeed(price_state=state)
    kline = feed._make_kline("ETH-USD", 4_000.0)
    feed._update_state(kline)
    assert state.eth_price == 4_000.0


# ---------------------------------------------------------------------------
# PriceFeedManager — forced modes (no network required)
# ---------------------------------------------------------------------------

def test_price_feed_manager_init_auto():
    state = PriceState()
    mgr = PriceFeedManager(price_state=state)
    assert mgr._price_feed == "auto"
    assert mgr._active == "none"


def test_price_feed_manager_init_forced_coinbase():
    state = PriceState()
    mgr = PriceFeedManager(price_state=state, price_feed="coinbase")
    assert mgr._price_feed == "coinbase"


def test_price_feed_manager_init_forced_binance():
    state = PriceState()
    mgr = PriceFeedManager(price_state=state, price_feed="binance")
    assert mgr._price_feed == "binance"


# ---------------------------------------------------------------------------
# PriceFeedManager — geo-block fallback logic (sync, no I/O)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_geo_block_triggers_after_n_errors():
    """5 geo-block errors in <30s should switch to Coinbase."""
    state = PriceState()
    mgr = PriceFeedManager(price_state=state, price_feed="auto")
    mgr._running = True
    mgr._active = "binance"

    switched = []

    async def _fake_switch():
        switched.append(True)

    mgr._switch_to_coinbase = _fake_switch

    exc = Exception("HTTP 451 Unavailable For Legal Reasons")
    for _ in range(5):
        await mgr._on_binance_error(exc)

    assert switched, "Expected _switch_to_coinbase to be called after 5 geo errors"


@pytest.mark.asyncio
async def test_geo_block_does_not_trigger_for_non_geo_errors():
    state = PriceState()
    mgr = PriceFeedManager(price_state=state, price_feed="auto")
    mgr._running = True
    mgr._active = "binance"

    switched = []

    async def _fake_switch():
        switched.append(True)

    mgr._switch_to_coinbase = _fake_switch

    exc = Exception("Connection reset by peer")
    for _ in range(10):
        await mgr._on_binance_error(exc)

    assert not switched, "Non-geo errors should not trigger fallback"


@pytest.mark.asyncio
async def test_geo_block_window_expires():
    """Errors spread beyond 30s should not trigger fallback."""
    state = PriceState()
    mgr = PriceFeedManager(price_state=state, price_feed="auto")
    mgr._running = True
    mgr._active = "binance"

    switched = []

    async def _fake_switch():
        switched.append(True)

    mgr._switch_to_coinbase = _fake_switch

    # Inject 4 old errors (outside the 30s window)
    old_time = time.time() - 35.0
    mgr._geo_error_times = [old_time] * 4

    exc = Exception("HTTP 451")
    # One new error — total in window should be 1 (old ones trimmed), not 5
    await mgr._on_binance_error(exc)

    assert not switched, "Old errors outside window should be trimmed"


@pytest.mark.asyncio
async def test_coinbase_mode_ignores_errors():
    """Errors should not cause double-switch when already on Coinbase."""
    state = PriceState()
    mgr = PriceFeedManager(price_state=state, price_feed="auto")
    mgr._running = True
    mgr._active = "coinbase"

    switched = []

    async def _fake_switch():
        switched.append(True)

    mgr._switch_to_coinbase = _fake_switch

    exc = Exception("HTTP 451")
    for _ in range(10):
        await mgr._on_binance_error(exc)

    assert not switched
