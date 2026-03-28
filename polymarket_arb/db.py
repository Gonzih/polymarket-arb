"""
SQLite trade log — stdlib only, no extra deps.
"""
import sqlite3
import logging
from datetime import datetime, timezone


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      TEXT NOT NULL,
    asset           TEXT NOT NULL,
    contract_id     TEXT,
    direction       TEXT NOT NULL,   -- 'YES' or 'NO'
    paper           INTEGER NOT NULL DEFAULT 1,
    edge_at_signal  REAL NOT NULL,
    confidence      REAL NOT NULL,
    kelly_size      REAL NOT NULL,
    simulated_size  REAL NOT NULL,
    entry_price     REAL NOT NULL,
    exit_price      REAL,
    pnl             REAL,
    resolved_at     TEXT,
    outcome         TEXT,            -- 'WIN', 'LOSS', 'OPEN'
    notes           TEXT
);

CREATE TABLE IF NOT EXISTS signals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      TEXT NOT NULL,
    asset           TEXT NOT NULL,
    contract_id     TEXT,
    edge_pct        REAL NOT NULL,
    confidence      REAL NOT NULL,
    cex_price       REAL NOT NULL,
    poly_odds       REAL NOT NULL,
    fired           INTEGER NOT NULL DEFAULT 0,
    fire_reason     TEXT,
    skip_reason     TEXT
);

CREATE TABLE IF NOT EXISTS daily_stats (
    date            TEXT PRIMARY KEY,
    starting_equity REAL NOT NULL,
    ending_equity   REAL,
    trades_count    INTEGER DEFAULT 0,
    wins            INTEGER DEFAULT 0,
    losses          INTEGER DEFAULT 0,
    max_drawdown    REAL DEFAULT 0.0,
    halted          INTEGER DEFAULT 0
);
"""


class TradeDB:
    def __init__(self, db_path: str):
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self):
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def log_signal(
        self,
        asset: str,
        contract_id: Optional[str],
        edge_pct: float,
        confidence: float,
        cex_price: float,
        poly_odds: float,
        fired: bool,
        fire_reason: str = "",
        skip_reason: str = "",
    ) -> int:
        cur = self._conn.execute(
            """INSERT INTO signals
               (created_at, asset, contract_id, edge_pct, confidence,
                cex_price, poly_odds, fired, fire_reason, skip_reason)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                _now_iso(),
                asset,
                contract_id,
                edge_pct,
                confidence,
                cex_price,
                poly_odds,
                1 if fired else 0,
                fire_reason,
                skip_reason,
            ),
        )
        self._conn.commit()
        return cur.lastrowid

    def open_trade(
        self,
        asset: str,
        contract_id: Optional[str],
        direction: str,
        paper: bool,
        edge_at_signal: float,
        confidence: float,
        kelly_size: float,
        simulated_size: float,
        entry_price: float,
    ) -> int:
        cur = self._conn.execute(
            """INSERT INTO trades
               (created_at, asset, contract_id, direction, paper,
                edge_at_signal, confidence, kelly_size, simulated_size,
                entry_price, outcome)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                _now_iso(),
                asset,
                contract_id,
                direction,
                1 if paper else 0,
                edge_at_signal,
                confidence,
                kelly_size,
                simulated_size,
                entry_price,
                "OPEN",
            ),
        )
        self._conn.commit()
        return cur.lastrowid

    def close_trade(
        self,
        trade_id: int,
        exit_price: float,
        pnl: float,
        outcome: str,
        notes: str = "",
    ):
        self._conn.execute(
            """UPDATE trades
               SET exit_price=?, pnl=?, outcome=?, resolved_at=?, notes=?
               WHERE id=?""",
            (
                exit_price,
                pnl,
                outcome,
                _now_iso(),
                notes,
                trade_id,
            ),
        )
        self._conn.commit()

    def get_open_trades(self) -> list:
        return list(
            self._conn.execute(
                "SELECT * FROM trades WHERE outcome='OPEN' ORDER BY created_at"
            ).fetchall()
        )

    def get_recent_trades(self, limit: int = 10) -> list:
        return list(
            self._conn.execute(
                "SELECT * FROM trades WHERE outcome!='OPEN' ORDER BY resolved_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        )

    def get_daily_stats(self, date: str) -> Optional[sqlite3.Row]:
        return self._conn.execute(
            "SELECT * FROM daily_stats WHERE date=?", (date,)
        ).fetchone()

    def upsert_daily_stats(
        self,
        date: str,
        starting_equity: float,
        ending_equity: float,
        trades_count: int,
        wins: int,
        losses: int,
        max_drawdown: float,
        halted: bool = False,
    ):
        self._conn.execute(
            """INSERT INTO daily_stats
               (date, starting_equity, ending_equity, trades_count, wins, losses, max_drawdown, halted)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(date) DO UPDATE SET
                 ending_equity=excluded.ending_equity,
                 trades_count=excluded.trades_count,
                 wins=excluded.wins,
                 losses=excluded.losses,
                 max_drawdown=excluded.max_drawdown,
                 halted=excluded.halted""",
            (
                date,
                starting_equity,
                ending_equity,
                trades_count,
                wins,
                losses,
                max_drawdown,
                1 if halted else 0,
            ),
        )
        self._conn.commit()

    def win_rate(self, since_date: Optional[str] = None) -> float:
        if since_date:
            row = self._conn.execute(
                """SELECT COUNT(*) as total,
                          SUM(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) as wins
                   FROM trades
                   WHERE outcome!='OPEN' AND date(created_at)>=?""",
                (since_date,),
            ).fetchone()
        else:
            row = self._conn.execute(
                """SELECT COUNT(*) as total,
                          SUM(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) as wins
                   FROM trades WHERE outcome!='OPEN'"""
            ).fetchone()
        if not row or row["total"] == 0:
            return 0.0
        return (row["wins"] or 0.0) / row["total"]

    def total_pnl(self) -> float:
        row = self._conn.execute(
            "SELECT SUM(pnl) as total FROM trades WHERE outcome!='OPEN'"
        ).fetchone()
        return row["total"] or 0.0

    def close(self):
        self._conn.close()
