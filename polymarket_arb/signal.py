"""
Edge calculation, confidence scoring, and Kelly position sizing.
"""
import logging
import math
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class Signal:
    asset: str
    contract_id: Optional[str]
    direction: str        # 'YES' or 'NO' (the side to trade)
    edge_pct: float       # estimated edge in percent
    confidence: float     # 0-1
    kelly_size_pct: float # fraction of portfolio to bet
    cex_price: float
    poly_odds: float      # current Polymarket odds for our side
    implied_fair: float   # our estimate of fair value
    notes: str = ""

    @property
    def passes_gate(self) -> bool:
        return self.edge_pct >= 5.0 and self.confidence >= 0.85


def _momentum_confidence(
    change_1m_pct: float,
    stale: bool,
) -> float:
    """
    Confidence from 1-min momentum.
    Strong moves → higher confidence; stale data → low confidence.
    """
    if stale:
        return 0.0
    abs_chg = abs(change_1m_pct)
    # Sigmoid-like scaling: 2% move → ~0.70 confidence, 5% → ~0.95
    conf = 1.0 / (1.0 + math.exp(-1.5 * (abs_chg - 2.0)))
    return min(conf, 0.97)


def _implied_probability(cex_change_1m_pct: float, direction: str) -> float:
    """
    Estimate true probability that price is UP/DOWN over the contract window.
    Uses a simple sigmoid on the 1-min momentum signal.
    A 3% 1-min move → ~80% prob of continued up movement.
    """
    # Map CEX 1m momentum to probability of continued move
    magnitude = abs(cex_change_1m_pct)
    base_prob = 0.5 + 0.5 * (1.0 - math.exp(-0.4 * magnitude))
    # Direction alignment
    if (direction == "UP" and cex_change_1m_pct > 0) or \
       (direction == "DOWN" and cex_change_1m_pct < 0):
        return min(base_prob, 0.97)
    else:
        return max(1.0 - base_prob, 0.03)


def half_kelly(
    prob_win: float,
    odds: float,           # b: net odds (payout per unit risked)
    kelly_fraction: float = 0.5,
    max_fraction: float = 0.08,
) -> float:
    """
    Half-Kelly position size as a fraction of portfolio.
    f* = kelly_fraction * (p - q/b) where q = 1-p
    """
    if odds <= 0 or prob_win <= 0:
        return 0.0
    q = 1.0 - prob_win
    f_star = prob_win - q / odds
    f_kelly = kelly_fraction * f_star
    return max(0.0, min(f_kelly, max_fraction))


def calculate_signal(
    asset: str,
    contract_id: Optional[str],
    direction: str,           # 'UP' or 'DOWN' (contract direction)
    cex_price: float,
    cex_change_1m_pct: float,
    poly_yes_price: float,    # current Polymarket YES price (0-1)
    cex_stale: bool = False,
    kelly_fraction: float = 0.5,
    max_position_pct: float = 8.0,
    lag_threshold_pct: float = 3.0,
) -> Optional[Signal]:
    """
    Compute whether there's a tradeable edge.
    Returns None if no meaningful signal.
    """
    if cex_stale or cex_price <= 0:
        return None

    # Which direction are we trading?
    # If CEX is moving UP and we're checking an UP contract, trade YES
    momentum_is_up = cex_change_1m_pct > 0
    trade_side: str
    poly_odds_for_side: float

    if direction == "UP":
        trade_side = "YES" if momentum_is_up else "NO"
        poly_odds_for_side = poly_yes_price if trade_side == "YES" else (1.0 - poly_yes_price)
    else:  # DOWN contract
        trade_side = "YES" if not momentum_is_up else "NO"
        poly_odds_for_side = poly_yes_price if trade_side == "YES" else (1.0 - poly_yes_price)

    # Implied fair probability for this side
    implied_prob = _implied_probability(cex_change_1m_pct, direction if trade_side == "YES" else ("DOWN" if direction == "UP" else "UP"))

    # Edge = implied_fair - polymarket_odds (if polymarket is lagging)
    edge_pct = (implied_prob - poly_odds_for_side) * 100.0

    if abs(edge_pct) < lag_threshold_pct:
        return None  # Not enough lag detected

    confidence = _momentum_confidence(cex_change_1m_pct, cex_stale)

    # Kelly sizing
    # Net odds for binary outcome: if we pay 'price' for 1 unit payout
    if poly_odds_for_side <= 0:
        return None
    net_odds = (1.0 / poly_odds_for_side) - 1.0  # b in Kelly formula
    kelly_pct = half_kelly(implied_prob, net_odds, kelly_fraction, max_position_pct / 100.0) * 100.0

    return Signal(
        asset=asset,
        contract_id=contract_id,
        direction=trade_side,
        edge_pct=edge_pct,
        confidence=confidence,
        kelly_size_pct=kelly_pct,
        cex_price=cex_price,
        poly_odds=poly_odds_for_side,
        implied_fair=implied_prob,
        notes=f"1m_chg={cex_change_1m_pct:.2f}% dir={direction}",
    )
