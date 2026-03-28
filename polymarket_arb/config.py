"""
Configuration — all thresholds loaded from env vars with sane defaults.
"""
import os
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Config:
    # API credentials (optional — paper mode works without them)
    polymarket_api_key: Optional[str] = field(
        default_factory=lambda: os.getenv("POLYMARKET_API_KEY")
    )
    polymarket_api_secret: Optional[str] = field(
        default_factory=lambda: os.getenv("POLYMARKET_API_SECRET")
    )
    polymarket_api_passphrase: Optional[str] = field(
        default_factory=lambda: os.getenv("POLYMARKET_API_PASSPHRASE")
    )
    polymarket_private_key: Optional[str] = field(
        default_factory=lambda: os.getenv("POLYMARKET_PRIVATE_KEY")
    )

    telegram_bot_token: Optional[str] = field(
        default_factory=lambda: os.getenv("TELEGRAM_BOT_TOKEN")
    )
    telegram_chat_id: Optional[str] = field(
        default_factory=lambda: os.getenv("TELEGRAM_CHAT_ID")
    )

    # Price feed: "auto" (Binance with Coinbase fallback), "binance", or "coinbase"
    price_feed: str = os.getenv("PRICE_FEED", "auto")

    # Binance WebSocket
    binance_ws_url: str = "wss://stream.binance.com:9443"
    binance_streams: list = field(
        default_factory=lambda: ["btcusdt@kline_1m", "ethusdt@kline_1m"]
    )

    # Edge / signal thresholds
    min_edge_pct: float = float(os.getenv("MIN_EDGE_PCT", "5.0"))
    lag_detection_pct: float = float(os.getenv("LAG_DETECTION_PCT", "3.0"))
    min_confidence: float = float(os.getenv("MIN_CONFIDENCE", "0.85"))

    # Position / risk limits
    max_position_pct: float = float(os.getenv("MAX_POSITION_PCT", "8.0"))
    kelly_fraction: float = float(os.getenv("KELLY_FRACTION", "0.5"))  # half-Kelly
    initial_portfolio: float = float(os.getenv("INITIAL_PORTFOLIO", "1000.0"))

    # Kill switches
    daily_drawdown_halt_pct: float = float(os.getenv("DAILY_DRAWDOWN_HALT_PCT", "20.0"))
    total_drawdown_shutdown_pct: float = float(
        os.getenv("TOTAL_DRAWDOWN_SHUTDOWN_PCT", "40.0")
    )

    # Data / logging
    db_path: str = os.path.expanduser(
        os.getenv("DB_PATH", "~/.polymarket-arb/trades.db")
    )
    log_path: str = os.path.expanduser(
        os.getenv("LOG_PATH", "~/.polymarket-arb/polymarket-arb.log")
    )

    # Paper mode
    paper_mode: bool = True

    # Polymarket CLOB host
    polymarket_host: str = os.getenv(
        "POLYMARKET_HOST", "https://clob.polymarket.com"
    )

    def __post_init__(self):
        import pathlib
        pathlib.Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path(self.log_path).parent.mkdir(parents=True, exist_ok=True)
