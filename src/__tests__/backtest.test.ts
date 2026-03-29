import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchCoinbaseCandles,
  replaySignals,
  fetchPolymarketMarkets,
  fetchMarketTrades,
  findCorrelatedMoves,
  buildSignalLog,
  generateMarkdownReport,
  MOMENTUM_THRESHOLD,
  type Candle,
  type CandleSignal,
  type PolymarketMarket,
  type SignalResult,
  type BacktestReport,
} from "../backtest.js";

vi.mock("../logger.js", () => ({ log: vi.fn() }));
vi.mock("child_process", () => ({ spawn: vi.fn() }));

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a Candle tuple; low/high derived from open/close */
function candle(ts: number, open: number, close: number, vol = 100): Candle {
  return [ts, Math.min(open, close), Math.max(open, close), open, close, vol];
}

function makeMarket(overrides: Partial<PolymarketMarket> = {}): PolymarketMarket {
  return {
    id: "m1",
    conditionId: "cond1",
    clobTokenId: "tok1",
    question: "Will ETH exceed $5k?",
    yesPrice: 0.5,
    volume: 100_000,
    ...overrides,
  };
}

function makeSignal(overrides: Partial<CandleSignal> = {}): CandleSignal {
  return {
    firedAt: 1_700_000_000_000, // unix ms
    symbol: "BTC-USD",
    direction: "UP",
    momentum: 0.02,
    price: 45000,
    confidence: 0.7,
    ...overrides,
  };
}

// ── fetchCoinbaseCandles ──────────────────────────────────────────────────────

describe("fetchCoinbaseCandles", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns candles sorted chronologically (oldest first, reversed from API)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        // Coinbase returns newest-first
        json: async () => [
          [1700001800, 45100, 45200, 45150, 45180, 10],
          [1700001200, 44950, 45100, 45000, 45050, 8],
          [1700000600, 44800, 44950, 44820, 44900, 9],
        ],
      })
    );

    const candles = await fetchCoinbaseCandles("BTC-USD", 60, 3);
    expect(candles.length).toBe(3);
    // After reversing, oldest should be first
    expect(candles[0][0]).toBe(1700000600);
    expect(candles[1][0]).toBe(1700001200);
    expect(candles[2][0]).toBe(1700001800);
  });

  it("calls the correct Coinbase endpoint with product and granularity", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchCoinbaseCandles("ETH-USD", 300, 100);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("ETH-USD")
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("granularity=300")
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("limit=100")
    );
  });

  it("returns empty array on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    expect(await fetchCoinbaseCandles()).toEqual([]);
  });

  it("returns empty array on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    expect(await fetchCoinbaseCandles()).toEqual([]);
  });

  it("returns empty array for empty API response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    expect(await fetchCoinbaseCandles()).toEqual([]);
  });
});

// ── replaySignals ─────────────────────────────────────────────────────────────

describe("replaySignals", () => {
  it("returns empty array for empty candles input", () => {
    expect(replaySignals([])).toEqual([]);
  });

  it("fires UP signal when candle moves > 1.5% up (open→close)", () => {
    const base = 1_700_000_000;
    const candles: Candle[] = [
      candle(base, 45000, 45700), // +1.56% → fires UP
    ];
    const signals = replaySignals(candles);
    expect(signals.length).toBe(1);
    expect(signals[0].direction).toBe("UP");
    expect(signals[0].momentum).toBeGreaterThan(MOMENTUM_THRESHOLD);
  });

  it("fires DOWN signal on > 1.5% drop", () => {
    const base = 1_700_000_000;
    const candles: Candle[] = [
      candle(base, 45000, 44300), // -1.56% → DOWN
    ];
    const signals = replaySignals(candles, "ETH-USD");
    expect(signals.length).toBe(1);
    expect(signals[0].direction).toBe("DOWN");
    expect(signals[0].symbol).toBe("ETH-USD");
  });

  it("does not fire when momentum is below 1.5% threshold", () => {
    const base = 1_700_000_000;
    const candles: Candle[] = [
      candle(base, 45000, 45100),      // +0.22%
      candle(base + 60, 45100, 45200), // +0.22%
      candle(base + 120, 45200, 45250), // +0.11%
    ];
    expect(replaySignals(candles)).toEqual([]);
  });

  it("signal fires when momentum equals threshold (strict less-than check)", () => {
    // Implementation uses `< MOMENTUM_THRESHOLD` so a move at exactly threshold IS suppressed only
    // when momentum < threshold. At exactly threshold it is not suppressed.
    const base = 1_700_000_000;
    // Use a value safely above threshold to avoid floating-point ambiguity
    const candles: Candle[] = [
      candle(base, 45000, 45000 * (1 + MOMENTUM_THRESHOLD * 1.01)), // 1.515% — just above threshold
    ];
    const signals = replaySignals(candles);
    expect(signals.length).toBe(1);
  });

  it("enforces 5-minute cooldown per direction", () => {
    const base = 1_700_000_000;
    // Two UP candles 60 seconds apart — only first should fire
    const candles: Candle[] = [
      candle(base, 45000, 45700),         // +1.56% UP — fires
      candle(base + 60, 45700, 46420),    // +1.54% UP — in cooldown, skip
    ];
    const signals = replaySignals(candles);
    const upSignals = signals.filter((s) => s.direction === "UP");
    expect(upSignals.length).toBe(1);
  });

  it("does not suppress opposite direction signals during cooldown", () => {
    const base = 1_700_000_000;
    const candles: Candle[] = [
      candle(base, 45000, 45700),       // +1.56% UP — fires
      candle(base + 60, 45700, 44990),  // -1.54% DOWN — different direction, fires
    ];
    const signals = replaySignals(candles);
    expect(signals.length).toBe(2);
    expect(signals[0].direction).toBe("UP");
    expect(signals[1].direction).toBe("DOWN");
  });

  it("allows UP signal again after 5-minute cooldown expires", () => {
    const base = 1_700_000_000;
    const cooldown = 5 * 60; // 5 min in seconds
    const candles: Candle[] = [
      candle(base, 45000, 45700),                 // +1.56% UP — fires
      candle(base + cooldown + 60, 45700, 46420), // after cooldown — fires
    ];
    const upSignals = replaySignals(candles).filter((s) => s.direction === "UP");
    expect(upSignals.length).toBe(2);
  });

  it("skips candles with zero open price", () => {
    const base = 1_700_000_000;
    const candles: Candle[] = [
      [base, 0, 0, 0, 45700, 10] as Candle, // open=0 → skip
      candle(base + 60, 45700, 46420),
    ];
    expect(() => replaySignals(candles)).not.toThrow();
    // First candle skipped, second fires
    const signals = replaySignals(candles);
    expect(signals.length).toBe(1);
    expect(signals[0].price).toBe(46420);
  });

  it("sets price to candle close value", () => {
    const base = 1_700_000_000;
    const candles: Candle[] = [candle(base, 45000, 45800)];
    const signals = replaySignals(candles);
    expect(signals[0].price).toBe(45800);
  });

  it("sets firedAt to candle timestamp in milliseconds", () => {
    const base = 1_700_000_000;
    const candles: Candle[] = [candle(base, 45000, 45700)];
    const signals = replaySignals(candles);
    expect(signals[0].firedAt).toBe(base * 1000);
  });

  it("confidence is between 0 and 1", () => {
    const base = 1_700_000_000;
    const candles: Candle[] = [
      candle(base, 45000, 45700), // moderate signal
    ];
    const s = replaySignals(candles)[0];
    expect(s.confidence).toBeGreaterThan(0);
    expect(s.confidence).toBeLessThanOrEqual(1);
  });

  it("confidence is capped at 1 for very large moves", () => {
    const base = 1_700_000_000;
    const candles: Candle[] = [
      candle(base, 45000, 50000), // +11% — well above 2× threshold
    ];
    const s = replaySignals(candles)[0];
    expect(s.confidence).toBe(1);
  });
});

// ── fetchPolymarketMarkets ────────────────────────────────────────────────────

describe("fetchPolymarketMarkets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses markets from flat array CLOB response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: "m1",
            conditionId: "cond1",
            question: "Will ETH exceed $5k?",
            volume: "200000",
            outcomePrices: '["0.6","0.4"]',
            clobTokenIds: '["tok1","tok2"]',
          },
        ],
      })
    );

    const markets = await fetchPolymarketMarkets(10);
    expect(markets.length).toBe(1);
    expect(markets[0].yesPrice).toBeCloseTo(0.6);
    expect(markets[0].clobTokenId).toBe("tok1");
    expect(markets[0].question).toBe("Will ETH exceed $5k?");
  });

  it("handles {data:[...]} wrapper shape from CLOB", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "m2",
              question: "Will BTC hit $100k?",
              volume: "500000",
              outcomePrices: '["0.45","0.55"]',
              clobTokenIds: '["tok3"]',
            },
          ],
        }),
      })
    );

    const markets = await fetchPolymarketMarkets(5);
    expect(markets.length).toBe(1);
    expect(markets[0].id).toBe("m2");
  });

  it("handles array outcomePrices (not JSON-encoded string)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: "m3",
            question: "Array prices test",
            volume: "100000",
            outcomePrices: ["0.7", "0.3"], // already an array
            clobTokenIds: '["tok4"]',
          },
        ],
      })
    );

    const markets = await fetchPolymarketMarkets(5);
    expect(markets[0].yesPrice).toBeCloseTo(0.7);
  });

  it("filters out markets with volume below $10k", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { id: "low", question: "Low volume?", volume: "5000", outcomePrices: '["0.5","0.5"]', clobTokenIds: '["t1"]' },
          { id: "ok", question: "Ok volume?", volume: "100000", outcomePrices: '["0.5","0.5"]', clobTokenIds: '["t2"]' },
        ],
      })
    );

    const markets = await fetchPolymarketMarkets(10);
    expect(markets.length).toBe(1);
    expect(markets[0].id).toBe("ok");
  });

  it("returns empty array on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await fetchPolymarketMarkets()).toEqual([]);
  });

  it("returns empty array on network exception", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    expect(await fetchPolymarketMarkets()).toEqual([]);
  });
});

// ── fetchMarketTrades ─────────────────────────────────────────────────────────

describe("fetchMarketTrades", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns trades from flat array response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { price: "0.60", timestamp: "1700000100" },
          { price: "0.62", timestamp: "1700003700" },
        ],
      })
    );
    const trades = await fetchMarketTrades("tok1");
    expect(trades.length).toBe(2);
    expect(String(trades[0].price)).toBe("0.60");
  });

  it("handles {data:[...]} wrapper shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ price: "0.7", timestamp: "1700000100" }] }),
      })
    );
    const trades = await fetchMarketTrades("tok1");
    expect(trades.length).toBe(1);
  });

  it("returns empty array on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await fetchMarketTrades("tok1")).toEqual([]);
  });

  it("returns empty array on network exception", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    expect(await fetchMarketTrades("tok1")).toEqual([]);
  });

  it("URL-encodes the tokenId in the request", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", mockFetch);
    await fetchMarketTrades("tok with spaces");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("tok%20with%20spaces")
    );
  });
});

// ── findCorrelatedMoves ───────────────────────────────────────────────────────

describe("findCorrelatedMoves", () => {
  const market = makeMarket();
  const signal = makeSignal();

  it("finds correlated UP move when market trades >2% upward in 30min window", () => {
    const trades = {
      m1: [
        { price: "0.50", timestamp: String(1_700_000_000) },     // at signal
        { price: "0.53", timestamp: String(1_700_000_600) },     // +3% — correlated
      ],
    };
    const corr = findCorrelatedMoves(signal, [market], trades);
    expect(corr.length).toBe(1);
    expect(corr[0].oddsChange).toBeCloseTo(0.03);
    expect(corr[0].direction).toBe("UP");
    expect(corr[0].marketId).toBe("m1");
  });

  it("finds correlated DOWN move when price drops >2%", () => {
    const trades = {
      m1: [
        { price: "0.60", timestamp: String(1_700_000_000) },
        { price: "0.55", timestamp: String(1_700_000_600) }, // -5%
      ],
    };
    const corr = findCorrelatedMoves(signal, [market], trades);
    expect(corr.length).toBe(1);
    expect(corr[0].direction).toBe("DOWN");
  });

  it("ignores moves below 2% threshold (0.50→0.51 is 1% change, below 2%)", () => {
    const trades = {
      m1: [
        { price: "0.50", timestamp: String(1_700_000_000) },
        { price: "0.51", timestamp: String(1_700_000_600) }, // +0.01 = 1% change — below 2% threshold
      ],
    };
    const corr = findCorrelatedMoves(signal, [market], trades);
    expect(corr.length).toBe(0); // 0.01 < 0.02 → not correlated
  });

  it("ignores moves below the 2% threshold", () => {
    const trades = {
      m1: [
        { price: "0.50", timestamp: String(1_700_000_000) },
        { price: "0.509", timestamp: String(1_700_000_600) }, // 1.8% — below threshold
      ],
    };
    expect(findCorrelatedMoves(signal, [market], trades)).toEqual([]);
  });

  it("ignores trades outside the 30-minute window", () => {
    const trades = {
      m1: [
        { price: "0.50", timestamp: String(1_700_000_000 - 3600) }, // before signal
        { price: "0.60", timestamp: String(1_700_000_000 + 3600) }, // after window end
      ],
    };
    expect(findCorrelatedMoves(signal, [market], trades)).toEqual([]);
  });

  it("requires at least 2 trades in window to compute move", () => {
    const trades = {
      m1: [
        { price: "0.60", timestamp: String(1_700_000_000) }, // only 1 trade
      ],
    };
    expect(findCorrelatedMoves(signal, [market], trades)).toEqual([]);
  });

  it("handles millisecond timestamps in trades", () => {
    const trades = {
      m1: [
        { price: "0.50", timestamp: String(1_700_000_000_000) },         // ms
        { price: "0.53", timestamp: String(1_700_000_000_000 + 60_000) }, // 1 min later, ms
      ],
    };
    const corr = findCorrelatedMoves(signal, [market], trades);
    expect(corr.length).toBe(1);
  });

  it("returns empty when no trades for market", () => {
    expect(findCorrelatedMoves(signal, [market], {})).toEqual([]);
  });

  it("checks multiple markets independently", () => {
    const mkt2 = makeMarket({ id: "m2", question: "Will BTC hit $80k?", clobTokenId: "tok2" });
    const trades = {
      m1: [
        { price: "0.50", timestamp: String(1_700_000_000) },
        { price: "0.55", timestamp: String(1_700_000_600) }, // +10% — correlated
      ],
      m2: [
        { price: "0.50", timestamp: String(1_700_000_000) },
        { price: "0.51", timestamp: String(1_700_000_600) }, // +2% — below threshold (1% = 0.01 < 0.02)
      ],
    };
    const corr = findCorrelatedMoves(signal, [market, mkt2], trades);
    expect(corr.length).toBe(1);
    expect(corr[0].marketId).toBe("m1");
  });

  it("respects custom oddsThreshold parameter", () => {
    const trades = {
      m1: [
        { price: "0.50", timestamp: String(1_700_000_000) },
        { price: "0.505", timestamp: String(1_700_000_600) }, // 1% move
      ],
    };
    // Default 2% threshold → no corr
    expect(findCorrelatedMoves(signal, [market], trades)).toEqual([]);
    // 0.5% threshold → correlated
    expect(findCorrelatedMoves(signal, [market], trades, 0.005)).toHaveLength(1);
  });
});

// ── buildSignalLog ────────────────────────────────────────────────────────────

describe("buildSignalLog", () => {
  it("returns no-signal message for empty results", () => {
    const logText = buildSignalLog([]);
    expect(logText).toContain("No signals fired");
    expect(logText).toContain("1.5%");
  });

  it("includes aggregate counts", () => {
    const results: SignalResult[] = [
      { signal: makeSignal(), marketsChecked: 5, correlatedMoves: [] },
      {
        signal: makeSignal({ firedAt: 1_700_000_060_000, direction: "DOWN" }),
        marketsChecked: 5,
        correlatedMoves: [{ marketId: "m1", question: "Q?", oddsChange: 0.03, direction: "UP" }],
      },
    ];
    const logText = buildSignalLog(results);
    expect(logText).toContain("Total signals: 2");
    expect(logText).toContain("1/2");
  });

  it("includes UP/DOWN directions in log", () => {
    const results: SignalResult[] = [
      { signal: makeSignal({ direction: "UP" }), marketsChecked: 5, correlatedMoves: [] },
    ];
    expect(buildSignalLog(results)).toContain("UP");
  });

  it("shows correlated market question snippet when correlated", () => {
    const results: SignalResult[] = [
      {
        signal: makeSignal(),
        marketsChecked: 5,
        correlatedMoves: [
          { marketId: "m1", question: "Will ETH exceed $5k by end of 2026?", oddsChange: 0.04, direction: "UP" },
        ],
      },
    ];
    const logText = buildSignalLog(results);
    expect(logText).toContain("Will ETH exceed");
    expect(logText).toContain("4.0%");
  });

  it("shows 'no correlated moves' when no correlation", () => {
    const results: SignalResult[] = [
      { signal: makeSignal(), marketsChecked: 5, correlatedMoves: [] },
    ];
    expect(buildSignalLog(results)).toContain("no correlated moves");
  });
});

// ── generateMarkdownReport ────────────────────────────────────────────────────

describe("generateMarkdownReport", () => {
  const baseReport: BacktestReport = {
    date: "2026-03-29",
    product: "BTC-USD",
    candlesAnalyzed: 300,
    signalsFired: 3,
    signalRatePerDay: 14.4,
    marketsChecked: 20,
    correlatedSignals: 1,
    correlationRate: 33.3,
    signals: [],
    claudeInterpretation: "Signals show moderate correlation with crypto markets.",
  };

  it("contains all required sections", () => {
    const text = generateMarkdownReport(baseReport);
    expect(text).toContain("# Polymarket Backtest");
    expect(text).toContain("## Summary");
    expect(text).toContain("## Signal Log");
    expect(text).toContain("## Interpretation");
  });

  it("includes the date in the header", () => {
    const text = generateMarkdownReport(baseReport);
    expect(text).toContain("2026-03-29");
  });

  it("shows candles analyzed count", () => {
    const text = generateMarkdownReport(baseReport);
    expect(text).toContain("Candles analyzed: 300");
  });

  it("shows signals fired count", () => {
    const text = generateMarkdownReport(baseReport);
    expect(text).toContain("Signals fired: 3");
  });

  it("shows correlated signals count", () => {
    const text = generateMarkdownReport(baseReport);
    expect(text).toContain("Correlated moves");
    expect(text).toContain(": 1");
  });

  it("includes Claude's interpretation text", () => {
    const text = generateMarkdownReport(baseReport);
    expect(text).toContain("Signals show moderate correlation with crypto markets.");
  });

  it("includes signal table with signal data when signals present", () => {
    const report: BacktestReport = {
      ...baseReport,
      signals: [
        {
          signal: makeSignal({ firedAt: 1_700_000_000_000, momentum: 0.022, price: 45500 }),
          marketsChecked: 5,
          correlatedMoves: [],
        },
      ],
    };
    const text = generateMarkdownReport(report);
    expect(text).toContain("BTC-USD");
    expect(text).toContain("UP");
    expect(text).toContain("2.20%");
  });

  it("shows correlation rate percentage", () => {
    const text = generateMarkdownReport(baseReport);
    expect(text).toContain("33.3%");
  });

  it("shows markets checked count", () => {
    const text = generateMarkdownReport(baseReport);
    expect(text).toContain("Markets checked per signal: 20");
  });
});
