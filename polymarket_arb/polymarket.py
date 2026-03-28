"""
Polymarket CLOB wrapper — contract discovery, odds fetching, order execution.
Falls back to simulated odds in paper mode when API is unavailable/unauthenticated.
"""
import asyncio
import logging
import math
import random
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class Contract:
    market_id: str
    question: str
    asset: str           # 'BTC' or 'ETH'
    direction: str       # 'UP' or 'DOWN'
    duration_min: int    # 5 or 15
    condition_id: str
    yes_token_id: str
    no_token_id: str
    end_time: float      # unix timestamp
    yes_price: float = 0.5
    no_price: float = 0.5
    last_updated: float = field(default_factory=time.time)

    @property
    def is_expired(self) -> bool:
        return time.time() > self.end_time

    @property
    def minutes_remaining(self) -> float:
        return max(0.0, (self.end_time - time.time()) / 60.0)


@dataclass
class SimulatedContract(Contract):
    """Used when real API is unavailable — random-walk odds for testing."""
    _walk: float = field(default=0.5, repr=False)

    def tick(self, cex_change_pct: float = 0.0):
        """Advance simulated odds with lag relative to CEX."""
        # 2.7s simulated lag — advance toward the "true" value slowly
        implied = 0.5 + cex_change_pct / 200.0  # crude mapping
        implied = max(0.05, min(0.95, implied))
        # Random walk with some drift toward implied
        noise = random.gauss(0, 0.005)
        self._walk += 0.03 * (implied - self._walk) + noise
        self._walk = max(0.05, min(0.95, self._walk))

        if self.direction == "UP":
            self.yes_price = self._walk
            self.no_price = 1.0 - self._walk
        else:
            self.yes_price = 1.0 - self._walk
            self.no_price = self._walk
        self.last_updated = time.time()


def _make_sim_contract(
    asset: str,
    direction: str,
    duration_min: int,
) -> SimulatedContract:
    end_time = time.time() + duration_min * 60
    cid = f"sim_{asset}_{direction}_{duration_min}m_{int(end_time)}"
    return SimulatedContract(
        market_id=cid,
        question=f"Will {asset} go {direction} in the next {duration_min} minutes?",
        asset=asset,
        direction=direction,
        duration_min=duration_min,
        condition_id=cid,
        yes_token_id=f"{cid}_yes",
        no_token_id=f"{cid}_no",
        end_time=end_time,
    )


class PolymarketClient:
    """
    Thin wrapper around py-clob-client (optional) with simulated fallback.
    Paper mode always works — live execution requires valid credentials.
    """

    def __init__(
        self,
        host: str = "https://clob.polymarket.com",
        api_key: Optional[str] = None,
        api_secret: Optional[str] = None,
        api_passphrase: Optional[str] = None,
        private_key: Optional[str] = None,
        paper: bool = True,
    ):
        self.host = host
        self.paper = paper
        self._api_key = api_key
        self._api_secret = api_secret
        self._api_passphrase = api_passphrase
        self._private_key = private_key
        self._client = None
        self._use_real_api = False
        self._contracts: Dict[str, Contract] = {}
        self._sim_contracts: Dict[str, SimulatedContract] = {}
        self._last_refresh = 0.0

    def _try_init_client(self):
        if not self._api_key:
            logger.info("No Polymarket API key — using simulated contracts")
            return
        try:
            from py_clob_client.client import ClobClient  # type: ignore
            self._client = ClobClient(
                host=self.host,
                key=self._private_key or "",
                chain_id=137,
                creds={
                    "apiKey": self._api_key,
                    "secret": self._api_secret,
                    "passphrase": self._api_passphrase,
                },
            )
            self._use_real_api = True
            logger.info("Polymarket CLOB client initialized")
        except Exception as e:
            logger.warning("Failed to init py-clob-client: %s — using simulated contracts", e)

    async def initialize(self):
        self._try_init_client()
        self._ensure_sim_contracts()

    def _ensure_sim_contracts(self):
        """Refresh simulated contracts if expired or missing."""
        for asset in ["BTC", "ETH"]:
            for direction in ["UP", "DOWN"]:
                for duration in [5, 15]:
                    key = f"{asset}_{direction}_{duration}m"
                    existing = self._sim_contracts.get(key)
                    if existing is None or existing.is_expired:
                        self._sim_contracts[key] = _make_sim_contract(
                            asset, direction, duration
                        )

    def tick_sim_contracts(self, btc_change: float, eth_change: float):
        """Advance simulated contract odds — called periodically."""
        self._ensure_sim_contracts()
        for key, c in self._sim_contracts.items():
            change = btc_change if c.asset == "BTC" else eth_change
            c.tick(change)

    async def get_active_contracts(self) -> List[Contract]:
        """Return active BTC/ETH 5/15-min contracts."""
        if self._use_real_api and self._client:
            return await self._fetch_real_contracts()
        return list(self._sim_contracts.values())

    async def _fetch_real_contracts(self) -> List[Contract]:
        """Fetch from real CLOB API — best effort, falls back to sim on error."""
        try:
            loop = asyncio.get_event_loop()
            markets = await loop.run_in_executor(
                None, self._client.get_markets
            )
            contracts = []
            keywords = {
                "btc": "BTC",
                "bitcoin": "BTC",
                "eth": "ETH",
                "ethereum": "ETH",
            }
            for m in (markets or []):
                q = (m.get("question") or "").lower()
                asset = None
                for kw, sym in keywords.items():
                    if kw in q:
                        asset = sym
                        break
                if not asset:
                    continue
                duration = None
                if "5 min" in q or "5min" in q or "5-min" in q:
                    duration = 5
                elif "15 min" in q or "15min" in q or "15-min" in q:
                    duration = 15
                if not duration:
                    continue
                direction = "UP" if any(w in q for w in ["up", "higher", "above"]) else "DOWN"
                tokens = m.get("tokens", [])
                yes_tok = next((t["token_id"] for t in tokens if t.get("outcome") == "Yes"), "")
                no_tok = next((t["token_id"] for t in tokens if t.get("outcome") == "No"), "")
                contracts.append(
                    Contract(
                        market_id=m.get("condition_id", ""),
                        question=m.get("question", ""),
                        asset=asset,
                        direction=direction,
                        duration_min=duration,
                        condition_id=m.get("condition_id", ""),
                        yes_token_id=yes_tok,
                        no_token_id=no_tok,
                        end_time=float(m.get("end_date_iso", time.time() + 3600)),
                        yes_price=float(m.get("tokens", [{}])[0].get("price", 0.5)),
                        no_price=float(m.get("tokens", [{}])[-1].get("price", 0.5)),
                    )
                )
            if contracts:
                return contracts
        except Exception as e:
            logger.warning("Real API fetch failed: %s — using simulated", e)
        return list(self._sim_contracts.values())

    async def place_order(
        self,
        contract: Contract,
        side: str,       # 'YES' or 'NO'
        size_usdc: float,
        price: float,
        paper: bool = True,
    ) -> dict:
        """Place order. In paper mode, always returns a simulated fill."""
        if paper or self.paper:
            return {
                "status": "PAPER_FILL",
                "token_id": contract.yes_token_id if side == "YES" else contract.no_token_id,
                "size": size_usdc / price if price > 0 else 0,
                "price": price,
                "contract_id": contract.condition_id,
                "paper": True,
            }

        if not self._use_real_api or not self._client:
            raise RuntimeError("Live trading requires valid API credentials")

        try:
            loop = asyncio.get_event_loop()
            token_id = contract.yes_token_id if side == "YES" else contract.no_token_id
            order_args = {
                "token_id": token_id,
                "price": price,
                "size": size_usdc / price,
                "side": "BUY",
            }
            result = await loop.run_in_executor(
                None,
                lambda: self._client.create_and_post_order(order_args),
            )
            return result
        except Exception as e:
            logger.error("Order placement failed: %s", e)
            raise
