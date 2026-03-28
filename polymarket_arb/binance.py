"""
Binance WebSocket client — kline streams for BTC/ETH.
Maintains live price state accessible to signal detector.
"""
import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, Optional

logger = logging.getLogger(__name__)


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
