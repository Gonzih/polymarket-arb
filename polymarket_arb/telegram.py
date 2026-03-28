"""
Telegram alert sender — graceful no-op if TELEGRAM_BOT_TOKEN not configured.
"""
import asyncio
import logging
from typing import Optional

logger = logging.getLogger(__name__)


class TelegramAlerter:
    def __init__(self, bot_token: Optional[str], chat_id: Optional[str]):
        self._token = bot_token
        self._chat_id = chat_id
        self._enabled = bool(bot_token and chat_id)
        if self._enabled:
            logger.info("Telegram alerts enabled (chat_id=%s)", chat_id)
        else:
            logger.info("Telegram alerts disabled (no credentials)")

    async def send(self, message: str):
        if not self._enabled:
            return
        try:
            import urllib.request
            import urllib.parse
            import json

            url = f"https://api.telegram.org/bot{self._token}/sendMessage"
            payload = json.dumps({
                "chat_id": self._chat_id,
                "text": message,
                "parse_mode": "Markdown",
            }).encode()

            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: urllib.request.urlopen(
                    urllib.request.Request(
                        url,
                        data=payload,
                        headers={"Content-Type": "application/json"},
                    ),
                    timeout=5,
                ),
            )
        except Exception as e:
            logger.warning("Telegram send failed: %s", e)

    async def alert_kill_switch(self, reason: str, equity: float):
        await self.send(
            f"🚨 *KILL SWITCH FIRED*\n"
            f"Reason: {reason}\n"
            f"Current equity: ${equity:.2f}"
        )

    async def alert_trade(self, asset: str, direction: str, size: float, edge: float, paper: bool):
        mode = "PAPER" if paper else "LIVE"
        await self.send(
            f"{'📄' if paper else '💰'} *{mode} TRADE*\n"
            f"{asset} {direction} | Size: ${size:.2f} | Edge: {edge:.1f}%"
        )

    async def alert_shutdown(self, reason: str):
        await self.send(f"❌ *BOT SHUTDOWN*\n{reason}")

    async def alert_startup(self, paper: bool):
        mode = "PAPER" if paper else "LIVE ⚡"
        await self.send(f"🤖 *Bot started* — Mode: {mode}")
