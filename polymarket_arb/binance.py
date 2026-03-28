"""
Binance WebSocket client — kline streams for BTC/ETH.
Maintains live price state accessible to signal detector.

Also provides CoinbaseFeed (geo-restriction-free fallback) and
PriceFeedManager (auto-switch on Binance geo-block).
"""
import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

# HTTP status tokens that indicate geo-blocking
_GEO_BLOCK_TOKENS = ("451", "403")


def _is_geo_block(exc: Exception) -> bool:
    """Return True if the exception looks like a geo-block (HTTP 451/403)."""
    msg = str(exc)
    return any(tok in msg for tok in _GEO_BLOCK_TOKENS)


@dataclass
class KlineData:
    symbol: str
    interval: str
    open_time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    close_time: int
    is_closed: bool
    received_at: float = field(default_factory=time.time)

    @property
    def price_change_pct(self) -> float:
        if self.open == 0:
            return 0.0
        return (self.close - self.open) / self.open * 100.0


@dataclass
class PriceState:
    """Shared mutable price state. Updated by BinanceClient."""
    btc_price: float = 0.0
    eth_price: float = 0.0
    btc_1m_change_pct: float = 0.0
    eth_1m_change_pct: float = 0.0
    btc_last_update: float = 0.0
    eth_last_update: float = 0.0
    btc_kline: Optional[KlineData] = None
    eth_kline: Optional[KlineData] = None

    def is_stale(self, symbol: str, max_age_s: float = 10.0) -> bool:
        ts = self.btc_last_update if symbol.upper().startswith("BTC") else self.eth_last_update
        return (time.time() - ts) > max_age_s

    def get_price(self, symbol: str) -> float:
        if symbol.upper().startswith("BTC"):
            return self.btc_price
        return self.eth_price

    def get_1m_change(self, symbol: str) -> float:
        if symbol.upper().startswith("BTC"):
            return self.btc_1m_change_pct
        return self.eth_1m_change_pct


class BinanceClient:
    """
    Connects to Binance WS kline streams and keeps PriceState updated.
    Reconnects automatically on failure.
    """

    def __init__(
        self,
        price_state: PriceState,
        ws_url: str = "wss://stream.binance.com:9443",
        streams: list = None,
        on_kline: Optional[Callable[[KlineData], None]] = None,
    ):
        self.price_state = price_state
        self.ws_url = ws_url
        self.streams = streams or ["btcusdt@kline_1m", "ethusdt@kline_1m"]
        self.on_kline = on_kline
        self._running = False
        self._task: Optional[asyncio.Task] = None
        # Optional async error callback — set by PriceFeedManager in auto mode
        self._on_error: Optional[Callable] = None

    def _combined_stream_url(self) -> str:
        combined = "/".join(self.streams)
        return f"{self.ws_url}/stream?streams={combined}"

    def _parse_kline(self, data: dict) -> Optional[KlineData]:
        try:
            k = data["data"]["k"]
            symbol = data["data"]["s"]
            return KlineData(
                symbol=symbol,
                interval=k["i"],
                open_time=k["t"],
                open=float(k["o"]),
                high=float(k["h"]),
                low=float(k["l"]),
                close=float(k["c"]),
                volume=float(k["v"]),
                close_time=k["T"],
                is_closed=k["x"],
            )
        except (KeyError, ValueError, TypeError) as e:
            logger.debug("Failed to parse kline: %s", e)
            return None

    def _update_state(self, kline: KlineData):
        sym = kline.symbol.upper()
        if sym.startswith("BTC"):
            self.price_state.btc_price = kline.close
            self.price_state.btc_1m_change_pct = kline.price_change_pct
            self.price_state.btc_last_update = kline.received_at
            self.price_state.btc_kline = kline
        elif sym.startswith("ETH"):
            self.price_state.eth_price = kline.close
            self.price_state.eth_1m_change_pct = kline.price_change_pct
            self.price_state.eth_last_update = kline.received_at
            self.price_state.eth_kline = kline

    async def _connect_and_stream(self):
        try:
            import websockets
        except ImportError:
            logger.error("websockets not installed — pip install websockets")
            raise

        url = self._combined_stream_url()
        logger.info("Connecting to Binance WS: %s", url)

        while self._running:
            try:
                async with websockets.connect(
                    url,
                    ping_interval=20,
                    ping_timeout=10,
                    close_timeout=5,
                ) as ws:
                    logger.info("Binance WS connected")
                    async for raw in ws:
                        if not self._running:
                            break
                        try:
                            data = json.loads(raw)
                            kline = self._parse_kline(data)
                            if kline:
                                self._update_state(kline)
                                if self.on_kline:
                                    self.on_kline(kline)
                        except json.JSONDecodeError:
                            pass
            except Exception as e:
                if not self._running:
                    break
                logger.warning("Binance WS error: %s — reconnecting in 3s", e)
                if self._on_error:
                    try:
                        await self._on_error(e)
                    except Exception:
                        pass
                await asyncio.sleep(3)

    async def start(self):
        self._running = True
        self._task = asyncio.create_task(self._connect_and_stream())

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass


class CoinbaseFeed:
    """
    Coinbase Advanced Trade public WebSocket — BTC-USD and ETH-USD tickers.
    No authentication required. No geo-restrictions.

    Maps Coinbase product IDs to the bot's internal symbols:
      BTC-USD → BTCUSDT,  ETH-USD → ETHUSDT
    """

    WS_URL = "wss://advanced-trade-api.coinbase.com/ws/market-data"
    _PRODUCT_MAP: Dict[str, str] = {"BTC-USD": "BTCUSDT", "ETH-USD": "ETHUSDT"}

    def __init__(
        self,
        price_state: PriceState,
        on_kline: Optional[Callable[[KlineData], None]] = None,
    ):
        self.price_state = price_state
        self.on_kline = on_kline
        self._running = False
        self._task: Optional[asyncio.Task] = None
        # Rolling ~1-minute price baseline: symbol -> (price, timestamp)
        self._price_baseline: Dict[str, tuple] = {}

    def _get_change_pct(self, symbol: str, price: float) -> float:
        """Approximate 1-minute % change using a rolling 60-second baseline."""
        now = time.time()
        if symbol not in self._price_baseline:
            self._price_baseline[symbol] = (price, now)
            return 0.0
        baseline_price, baseline_ts = self._price_baseline[symbol]
        if now - baseline_ts >= 60.0:
            # Baseline is stale — reset to current price
            self._price_baseline[symbol] = (price, now)
        if baseline_price == 0:
            return 0.0
        return (price - baseline_price) / baseline_price * 100.0

    def _make_kline(self, product_id: str, price: float) -> Optional[KlineData]:
        symbol = self._PRODUCT_MAP.get(product_id)
        if not symbol:
            return None
        change_pct = self._get_change_pct(symbol, price)
        # Derive a synthetic open from the rolling change
        if change_pct != -100.0:
            synthetic_open = price / (1.0 + change_pct / 100.0)
        else:
            synthetic_open = price
        now_ms = int(time.time() * 1000)
        return KlineData(
            symbol=symbol,
            interval="1m",
            open_time=now_ms - 60_000,
            open=synthetic_open,
            high=max(synthetic_open, price),
            low=min(synthetic_open, price),
            close=price,
            volume=0.0,
            close_time=now_ms,
            is_closed=False,
        )

    def _update_state(self, kline: KlineData):
        sym = kline.symbol.upper()
        if sym.startswith("BTC"):
            self.price_state.btc_price = kline.close
            self.price_state.btc_1m_change_pct = kline.price_change_pct
            self.price_state.btc_last_update = kline.received_at
            self.price_state.btc_kline = kline
        elif sym.startswith("ETH"):
            self.price_state.eth_price = kline.close
            self.price_state.eth_1m_change_pct = kline.price_change_pct
            self.price_state.eth_last_update = kline.received_at
            self.price_state.eth_kline = kline

    async def _connect_and_stream(self):
        try:
            import websockets
        except ImportError:
            logger.error("websockets not installed — pip install websockets")
            raise

        subscribe_msg = json.dumps({
            "type": "subscribe",
            "product_ids": ["BTC-USD", "ETH-USD"],
            "channel": "ticker",
        })

        logger.info("Connecting to Coinbase WS: %s", self.WS_URL)
        while self._running:
            try:
                async with websockets.connect(
                    self.WS_URL,
                    ping_interval=20,
                    ping_timeout=10,
                    close_timeout=5,
                ) as ws:
                    await ws.send(subscribe_msg)
                    logger.info("Coinbase WS connected")
                    async for raw in ws:
                        if not self._running:
                            break
                        try:
                            data = json.loads(raw)
                            if data.get("channel") != "ticker":
                                continue
                            for event in data.get("events", []):
                                for ticker in event.get("tickers", []):
                                    product_id = ticker.get("product_id", "")
                                    price_str = ticker.get("price", "")
                                    if not price_str:
                                        continue
                                    price = float(price_str)
                                    kline = self._make_kline(product_id, price)
                                    if kline:
                                        self._update_state(kline)
                                        if self.on_kline:
                                            self.on_kline(kline)
                        except (json.JSONDecodeError, ValueError, KeyError):
                            pass
            except Exception as e:
                if not self._running:
                    break
                logger.warning("Coinbase WS error: %s — reconnecting in 5s", e)
                await asyncio.sleep(5)

    async def start(self):
        self._running = True
        self._task = asyncio.create_task(self._connect_and_stream())

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass


class PriceFeedManager:
    """
    Manages BTC/ETH price feed with automatic Binance → Coinbase fallback.

    Behavior when PRICE_FEED=auto (default):
    - Starts with Binance WS.
    - If >= 5 geo-block errors (HTTP 451/403) occur within 30 s, switches to
      Coinbase and logs: WARNING: Binance geo-blocked, switched to Coinbase feed
    - Retries Binance every 10 minutes in the background; switches back if it
      recovers.

    Set PRICE_FEED=binance or PRICE_FEED=coinbase to force a specific feed.
    Has the same start()/stop() interface as BinanceClient.
    """

    _FALLBACK_N = 5           # geo-block errors before switching
    _FALLBACK_WINDOW = 30.0   # sliding window (seconds)
    _RETRY_INTERVAL = 600.0   # Binance retry interval (10 minutes)

    def __init__(
        self,
        price_state: PriceState,
        ws_url: str = "wss://stream.binance.com:9443",
        streams: list = None,
        on_kline: Optional[Callable[[KlineData], None]] = None,
        price_feed: str = "auto",
    ):
        self._price_state = price_state
        self._ws_url = ws_url
        self._streams = streams or ["btcusdt@kline_1m", "ethusdt@kline_1m"]
        self._on_kline = on_kline
        self._price_feed = price_feed.lower()

        self._binance = self._make_binance()
        self._coinbase = CoinbaseFeed(price_state=price_state, on_kline=on_kline)

        self._active: str = "none"
        self._running = False
        self._geo_error_times: List[float] = []
        self._retry_task: Optional[asyncio.Task] = None

    def _make_binance(self) -> BinanceClient:
        client = BinanceClient(
            price_state=self._price_state,
            ws_url=self._ws_url,
            streams=self._streams,
            on_kline=self._on_kline,
        )
        client._on_error = self._on_binance_error
        return client

    async def start(self):
        self._running = True
        if self._price_feed == "coinbase":
            logger.info("Price feed: Coinbase (PRICE_FEED=coinbase)")
            self._active = "coinbase"
            await self._coinbase.start()
        elif self._price_feed == "binance":
            logger.info("Price feed: Binance (PRICE_FEED=binance)")
            self._active = "binance"
            await self._binance.start()
        else:
            logger.info("Price feed: auto (Binance with Coinbase fallback on geo-block)")
            self._active = "binance"
            await self._binance.start()

    async def stop(self):
        self._running = False
        if self._retry_task and not self._retry_task.done():
            self._retry_task.cancel()
            try:
                await self._retry_task
            except asyncio.CancelledError:
                pass
        await self._binance.stop()
        await self._coinbase.stop()

    async def _on_binance_error(self, exc: Exception):
        """Called by BinanceClient on every WS error; triggers fallback on geo-block."""
        if self._price_feed != "auto" or self._active != "binance":
            return
        if not _is_geo_block(exc):
            return

        now = time.time()
        self._geo_error_times.append(now)
        # Trim entries outside the sliding window
        self._geo_error_times = [
            t for t in self._geo_error_times if now - t < self._FALLBACK_WINDOW
        ]
        if len(self._geo_error_times) >= self._FALLBACK_N:
            await self._switch_to_coinbase()

    async def _switch_to_coinbase(self):
        if self._active == "coinbase":
            return
        logger.warning("WARNING: Binance geo-blocked, switched to Coinbase feed")
        self._active = "coinbase"
        # Halt Binance reconnect loop without awaiting the full stop
        self._binance._running = False
        if self._binance._task and not self._binance._task.done():
            self._binance._task.cancel()
        await self._coinbase.start()
        # Schedule background Binance retry
        if not self._retry_task or self._retry_task.done():
            self._retry_task = asyncio.create_task(self._retry_binance_loop())

    async def _retry_binance_loop(self):
        """Probe Binance every 10 minutes; switch back if it becomes accessible."""
        while self._running and self._active == "coinbase":
            await asyncio.sleep(self._RETRY_INTERVAL)
            if not self._running or self._active != "coinbase":
                return

            logger.info("Retrying Binance connection (10-min retry)...")
            probe_ok: asyncio.Event = asyncio.Event()

            def _probe_kline(_k):
                probe_ok.set()

            probe = BinanceClient(
                price_state=PriceState(),  # isolated state — don't pollute main
                ws_url=self._ws_url,
                streams=self._streams[:1],  # one stream is enough to confirm
                on_kline=_probe_kline,
            )
            await probe.start()
            try:
                await asyncio.wait_for(probe_ok.wait(), timeout=15.0)
                # Binance is accessible again
                logger.info(
                    "Binance connection restored — switching back from Coinbase"
                )
                self._active = "binance"
                await self._coinbase.stop()
                await probe.stop()
                self._geo_error_times = []
                self._binance = self._make_binance()
                await self._binance.start()
                return
            except asyncio.TimeoutError:
                logger.info("Binance still unavailable — staying on Coinbase")
                await probe.stop()
