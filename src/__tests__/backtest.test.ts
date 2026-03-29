import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchResolvedMarkets,
  fetchPriceHistory,
  fetchPriceHistoryFromTrades,
  fetchActiveMarkets,
  replaySignals,
  kellySize,
  computePnl,
  generateReport,
  formatReport,
  type PricePoint,
  type BacktestResult,
} from "../backtest.js";

vi.mock("../logger.js", () => ({ log: vi.fn() }));

// Mock child_process so askClaude tests don't spawn real processes
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMarket(overrides: Record<string, unknown> = {}) {
  return {
    id: "mkt1",
    conditionId: "cond1",
    question: "Will BTC exceed $100k by end of year?",
    volume: "100000",
    startDate: "2025-11-01T00:00:00Z",
    endDate: "2026-02-01T00:00:00Z",
    resolutionTime: "2026-02-01T00:00:00Z",
    closed: true,
    resolved: true,
    outcomePrices: '["1","0"]', // YES won
    outcomes: '["Yes","No"]',
    ...overrides,
  };
}

// ── fetchResolvedMarkets ──────────────────────────────────────────────────────

describe("fetchResolvedMarkets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses resolved markets and filters by volume and resolution clarity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            makeMarket({ id: "m1", volume: "100000", outcomePrices: '["1","0"]' }),
            makeMarket({ id: "m2", volume: "200000", outcomePrices: '["0","1"]' }), // NO won
            makeMarket({ id: "m3", volume: "10000" }), // below $50k threshold
            makeMarket({ id: "m4", volume: "75000", outcomePrices: '["0.65","0.35"]' }), // not resolved cleanly
          ],
        })
        .mockResolvedValueOnce({ ok: true, json: async () => [] })
    );

    const markets = await fetchResolvedMarkets(10);
    expect(markets.length).toBe(2);
    expect(markets[0].id).toBe("m1");
    expect(markets[0].resolution).toBe(1);
    expect(markets[1].id).toBe("m2");
    expect(markets[1].resolution).toBe(0);
  });

  it("returns empty array when API fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const markets = await fetchResolvedMarkets(10);
    expect(markets).toEqual([]);
  });

  it("filters out markets older than 6 months", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            makeMarket({ id: "old", endDate: "2020-01-01T00:00:00Z" }),
          ],
        })
        .mockResolvedValueOnce({ ok: true, json: async () => [] })
    );

    const markets = await fetchResolvedMarkets(10);
    expect(markets.length).toBe(0);
  });

  it("handles array outcomePrices (not JSON-encoded string)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            makeMarket({ outcomePrices: ["1", "0"] }), // already an array
          ],
        })
        .mockResolvedValueOnce({ ok: true, json: async () => [] })
    );

    const markets = await fetchResolvedMarkets(10);
    expect(markets.length).toBe(1);
    expect(markets[0].resolution).toBe(1);
  });

  it("stops pagination when API returns fewer than batchSize", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [makeMarket()], // only 1 item — ends pagination
    }));

    const markets = await fetchResolvedMarkets(100);
    expect(markets.length).toBe(1);
  });
});

// ── fetchPriceHistory ─────────────────────────────────────────────────────────

describe("fetchPriceHistory", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns price history sorted by timestamp ascending", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        history: [
          { t: 1700000300, p: 0.60 },
          { t: 1700000100, p: 0.50 },
          { t: 1700000200, p: 0.55 },
        ],
      }),
    }));

    const history = await fetchPriceHistory("cond1");
    expect(history[0].t).toBe(1700000100);
    expect(history[1].t).toBe(1700000200);
    expect(history[2].t).toBe(1700000300);
  });

  it("handles top-level array response (no history wrapper)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { t: 1700000100, p: 0.40 },
        { t: 1700000200, p: 0.45 },
      ],
    }));

    const history = await fetchPriceHistory("cond1");
    expect(history.length).toBe(2);
  });

  it("returns empty array on HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const history = await fetchPriceHistory("cond1");
    expect(history).toEqual([]);
  });

  it("returns empty array on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const history = await fetchPriceHistory("cond1");
    expect(history).toEqual([]);
  });
});

// ── replaySignals ─────────────────────────────────────────────────────────────

describe("replaySignals", () => {
  it("returns empty array for history shorter than window", () => {
    const short: PricePoint[] = [
      { t: 1000, p: 0.5 },
      { t: 2000, p: 0.55 },
    ];
    expect(replaySignals(short)).toEqual([]);
  });

  it("fires a YES signal when price rises > 5% in 4 hours", () => {
    const base = 1_700_000_000;
    const h = 3600;
    const history: PricePoint[] = [
      { t: base, p: 0.50 },          // window start
      { t: base + h, p: 0.51 },
      { t: base + 2 * h, p: 0.52 },
      { t: base + 3 * h, p: 0.53 },
      { t: base + 4 * h, p: 0.53 }, // 6% rise → fires
    ];
    const signals = replaySignals(history);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].direction).toBe("YES");
    expect(signals[0].momentum).toBeGreaterThan(0.05);
  });

  it("does not fire when momentum is below 5% threshold", () => {
    const base = 1_700_000_000;
    const h = 3600;
    const history: PricePoint[] = [
      { t: base, p: 0.50 },
      { t: base + h, p: 0.501 },
      { t: base + 2 * h, p: 0.502 },
      { t: base + 3 * h, p: 0.503 },
      { t: base + 4 * h, p: 0.504 }, // 0.8% — below threshold
    ];
    expect(replaySignals(history)).toEqual([]);
  });

  it("fires a NO signal on downward momentum > 5%", () => {
    const base = 1_700_000_000;
    const h = 3600;
    const history: PricePoint[] = [
      { t: base, p: 0.70 },
      { t: base + h, p: 0.67 },
      { t: base + 2 * h, p: 0.64 },
      { t: base + 3 * h, p: 0.61 },
      { t: base + 4 * h, p: 0.60 }, // ~14% drop
    ];
    const signals = replaySignals(history);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].direction).toBe("NO");
  });

  it("enforces 12-hour cooldown between signals", () => {
    const base = 1_700_000_000;
    const h = 3600;
    // Build enough history that two signals would fire close together
    const history: PricePoint[] = [];
    for (let i = 0; i <= 6; i++) {
      history.push({ t: base + i * h, p: 0.50 + i * 0.015 }); // ~3% per hour
    }
    // Only one signal should fire due to cooldown
    const signals = replaySignals(history);
    // If multiple fired, they should be >= 12h apart
    for (let i = 1; i < signals.length; i++) {
      expect(signals[i].firedAt - signals[i - 1].firedAt).toBeGreaterThanOrEqual(
        12 * 60 * 60 * 1000
      );
    }
  });

  it("skips window positions where windowStart price is 0", () => {
    const base = 1_700_000_000;
    const h = 3600;
    const history: PricePoint[] = [
      { t: base, p: 0 },            // zero price — should skip
      { t: base + h, p: 0.51 },
      { t: base + 2 * h, p: 0.52 },
      { t: base + 3 * h, p: 0.53 },
      { t: base + 4 * h, p: 0.99 },
    ];
    // Should not throw; might fire from later windows
    expect(() => replaySignals(history)).not.toThrow();
  });
});

// ── kellySize ─────────────────────────────────────────────────────────────────

describe("kellySize", () => {
  it("returns 0 for odds = 0", () => expect(kellySize(0, 0.6)).toBe(0));
  it("returns 0 for odds = 1", () => expect(kellySize(1, 0.6)).toBe(0));

  it("returns positive size for positive edge", () => {
    // At 50/50 odds with 70% win prob → strong Kelly
    const k = kellySize(0.5, 0.7);
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThanOrEqual(0.1);
  });

  it("returns 0 when win prob equals breakeven", () => {
    // At odds=0.5 breakeven is exactly 50% win prob
    expect(kellySize(0.5, 0.5)).toBe(0);
  });

  it("caps at 10% regardless of edge size", () => {
    expect(kellySize(0.1, 0.99)).toBe(0.1);
    expect(kellySize(0.05, 0.99)).toBe(0.1);
  });

  it("returns 0 for negative edge (expected to lose)", () => {
    expect(kellySize(0.5, 0.3)).toBe(0);
  });
});

// ── computePnl ────────────────────────────────────────────────────────────────

describe("computePnl", () => {
  it("returns 0 for PASS", () => expect(computePnl("PASS", 0.5, 1, 0.05)).toBe(0));
  it("returns 0 for ERROR", () => expect(computePnl("ERROR", 0.5, 1, 0.05)).toBe(0));

  it("returns positive P&L for correct BUY_YES", () => {
    const pnl = computePnl("BUY_YES", 0.5, 1, 0.05);
    expect(pnl).toBeGreaterThan(0);
  });

  it("returns -kelly for wrong BUY_YES", () => {
    const pnl = computePnl("BUY_YES", 0.5, 0, 0.05);
    expect(pnl).toBe(-0.05);
  });

  it("returns positive P&L for correct BUY_NO", () => {
    const pnl = computePnl("BUY_NO", 0.5, 0, 0.05);
    expect(pnl).toBeGreaterThan(0);
  });

  it("returns -kelly for wrong BUY_NO", () => {
    const pnl = computePnl("BUY_NO", 0.5, 1, 0.05);
    expect(pnl).toBe(-0.05);
  });

  it("scales profit correctly by implied odds", () => {
    // BUY_YES at 0.4 odds (underdog), winning = larger profit
    const pnlLong = computePnl("BUY_YES", 0.4, 1, 0.05);
    // BUY_YES at 0.8 odds (favourite), winning = smaller profit
    const pnlShort = computePnl("BUY_YES", 0.8, 1, 0.05);
    expect(pnlLong).toBeGreaterThan(pnlShort);
  });
});

// ── generateReport ────────────────────────────────────────────────────────────

describe("generateReport", () => {
  const mockResults: BacktestResult[] = [
    {
      marketId: "m1",
      question: "Q1",
      signalFiredAt: 1700000000000,
      oddsAtSignal: 0.6,
      claudeDecision: "BUY_YES",
      claudeLatencyMs: 2000,
      actualResolution: 1,
      correct: true,
      kellySizePct: 0.05,
      hypotheticalPnl: 0.033,
    },
    {
      marketId: "m2",
      question: "Q2",
      signalFiredAt: 1700000000000,
      oddsAtSignal: 0.4,
      claudeDecision: "BUY_NO",
      claudeLatencyMs: 1500,
      actualResolution: 0,
      correct: true,
      kellySizePct: 0.05,
      hypotheticalPnl: 0.042,
    },
    {
      marketId: "m3",
      question: "Q3",
      signalFiredAt: 1700000000000,
      oddsAtSignal: 0.5,
      claudeDecision: "PASS",
      claudeLatencyMs: 1800,
      actualResolution: 1,
      correct: false,
      kellySizePct: 0,
      hypotheticalPnl: 0,
    },
    {
      marketId: "m4",
      question: "Q4",
      signalFiredAt: 1700000000000,
      oddsAtSignal: 0.5,
      claudeDecision: "ERROR",
      claudeLatencyMs: 30000,
      actualResolution: 1,
      correct: false,
      kellySizePct: 0,
      hypotheticalPnl: 0,
    },
  ];

  it("computes correct aggregate stats", () => {
    const report = generateReport(mockResults, 10);
    expect(report.marketsAnalyzed).toBe(10);
    expect(report.signalsFired).toBe(4);
    expect(report.buyYesTotal).toBe(1);
    expect(report.buyYesCorrect).toBe(1);
    expect(report.buyNoTotal).toBe(1);
    expect(report.buyNoCorrect).toBe(1);
    expect(report.passCount).toBe(1);
    expect(report.claudeErrors).toBe(1);
    expect(report.claudeSuccesses).toBe(3);
    expect(report.totalPnl).toBeCloseTo(0.075, 3);
  });

  it("computes average latency correctly", () => {
    const report = generateReport(mockResults, 10);
    const expected = (2000 + 1500 + 1800 + 30000) / 4;
    expect(report.avgLatencyMs).toBeCloseTo(expected, 0);
  });

  it("computes max latency correctly", () => {
    const report = generateReport(mockResults, 10);
    expect(report.maxLatencyMs).toBe(30000);
  });

  it("handles empty results", () => {
    const report = generateReport([], 5);
    expect(report.signalsFired).toBe(0);
    expect(report.totalPnl).toBe(0);
    expect(report.avgLatencyMs).toBe(0);
    expect(report.maxLatencyMs).toBe(0);
  });
});

// ── formatReport ──────────────────────────────────────────────────────────────

describe("formatReport", () => {
  const base = {
    marketsAnalyzed: 20,
    signalsFired: 5,
    claudeSuccesses: 4,
    claudeErrors: 1,
    avgLatencyMs: 2300,
    maxLatencyMs: 4100,
    buyYesTotal: 3,
    buyYesCorrect: 2,
    buyNoTotal: 1,
    buyNoCorrect: 1,
    passCount: 1,
    avgKellyPct: 0.082,
    totalPnl: 0.124,
    results: [],
  };

  it("includes all required sections", () => {
    const text = formatReport(base, "2026-01-01");
    expect(text).toContain("POLYMARKET-ARB BACKTEST REPORT");
    expect(text).toContain("Markets analyzed: 20");
    expect(text).toContain("Signals fired: 5");
    expect(text).toContain("SIGNAL ACCURACY");
    expect(text).toContain("EDGE vs RANDOM");
    expect(text).toContain("CLAUDE CODE INTEGRATION");
    expect(text).toContain("VERDICT");
  });

  it("shows error count in Claude integration section", () => {
    const text = formatReport(base, "2026-01-01");
    expect(text).toContain("✗ 1 error");
  });

  it("shows all-success message when no errors", () => {
    const text = formatReport({ ...base, claudeErrors: 0, claudeSuccesses: 5 }, "2026-01-01");
    expect(text).toContain("✓ All 5 calls succeeded");
    expect(text).not.toContain("✗");
  });

  it("shows INSUFFICIENT DATA verdict for zero decisions", () => {
    const text = formatReport(
      { ...base, buyYesTotal: 0, buyYesCorrect: 0, buyNoTotal: 0, buyNoCorrect: 0 },
      "2026-01-01"
    );
    expect(text).toContain("INSUFFICIENT DATA");
  });

  it("shows TOO FEW TRADES verdict for small sample", () => {
    const text = formatReport(
      { ...base, buyYesTotal: 2, buyYesCorrect: 2, buyNoTotal: 1, buyNoCorrect: 1 },
      "2026-01-01"
    );
    expect(text).toContain("TOO FEW TRADES");
  });

  it("formats P&L percentage correctly", () => {
    const text = formatReport(base, "2026-01-01");
    expect(text).toContain("+12.4% of bankroll");
  });

  it("includes the date in the report", () => {
    const text = formatReport(base, "2026-03-28");
    expect(text).toContain("Date: 2026-03-28");
  });
});

// ── fetchPriceHistoryFromTrades ───────────────────────────────────────────────

describe("fetchPriceHistoryFromTrades", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reconstructs hourly buckets from trade array, last price wins", async () => {
    // Both timestamps fall in the same hour bucket (floor(ts/3600)*3600 = 1700000000 for these)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { price: "0.60", timestamp: "1700001800" }, // hour bucket 1700000000
        { price: "0.62", timestamp: "1700002400" }, // same hour bucket, last price wins
      ],
    }));

    const history = await fetchPriceHistoryFromTrades("token1");
    expect(history.length).toBe(1);
    expect(history[0].p).toBeCloseTo(0.62);
  });

  it("handles {data: [...]} wrapper shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ price: "0.70", timestamp: "1700000100" }] }),
    }));

    const history = await fetchPriceHistoryFromTrades("token1");
    expect(history.length).toBe(1);
    expect(history[0].p).toBeCloseTo(0.70);
  });

  it("returns empty array on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const history = await fetchPriceHistoryFromTrades("token1");
    expect(history).toEqual([]);
  });

  it("returns empty array on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const history = await fetchPriceHistoryFromTrades("token1");
    expect(history).toEqual([]);
  });

  it("handles millisecond timestamps (ts >= 1e12 converted to seconds)", async () => {
    // 1700000000000 ms → 1700000000 s → bucket 1699999200 (floor(1700000000/3600)*3600)
    // 1700000000 s → same bucket
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { price: "0.55", timestamp: "1700000000000" }, // ms timestamp
        { price: "0.57", timestamp: "1700000000" },    // same bucket, seconds timestamp
      ],
    }));

    const history = await fetchPriceHistoryFromTrades("token1");
    // Both map to the same hour bucket
    expect(history.length).toBe(1);
    expect(history[0].p).toBeCloseTo(0.57);
  });

  it("returns result sorted ascending by t", async () => {
    // Trades in reverse chronological order (newer first)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { price: "0.80", timestamp: "1700010000" }, // later hour bucket
        { price: "0.70", timestamp: "1700003600" }, // earlier hour bucket
        { price: "0.60", timestamp: "1700000000" }, // earliest hour bucket
      ],
    }));

    const history = await fetchPriceHistoryFromTrades("token1");
    expect(history.length).toBe(3);
    expect(history[0].t).toBeLessThan(history[1].t);
    expect(history[1].t).toBeLessThan(history[2].t);
  });
});

// ── fetchActiveMarkets ────────────────────────────────────────────────────────

describe("fetchActiveMarkets", () => {
  afterEach(() => vi.unstubAllGlobals());

  function makeActiveMarket(overrides: Record<string, unknown> = {}) {
    return {
      id: "active1",
      conditionId: "cond_active1",
      question: "Will ETH exceed $5k by Q2?",
      volume: "100000",
      endDate: "2026-06-01T00:00:00Z",
      closed: false,
      resolved: false,
      outcomePrices: '["0.6","0.4"]',
      clobTokenIds: '["tok1","tok2"]',
      ...overrides,
    };
  }

  it("returns active markets filtered by volume and yesPrice range", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            makeActiveMarket({ id: "a1", volume: "100000", outcomePrices: '["0.6","0.4"]' }), // valid
            makeActiveMarket({ id: "a2", volume: "100000", outcomePrices: '["0.02","0.98"]' }), // yesPrice too low
            makeActiveMarket({ id: "a3", volume: "100000", outcomePrices: '["0.97","0.03"]' }), // yesPrice too high
            makeActiveMarket({ id: "a4", volume: "10000", outcomePrices: '["0.5","0.5"]' }),   // volume too low
          ],
        })
        .mockResolvedValueOnce({ ok: true, json: async () => [] })
    );

    const markets = await fetchActiveMarkets(10);
    expect(markets.length).toBe(1);
    expect(markets[0].id).toBe("a1");
    expect(markets[0].yesPrice).toBeCloseTo(0.6);
  });

  it("returns empty array on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const markets = await fetchActiveMarkets(10);
    expect(markets).toEqual([]);
  });

  it("stops pagination when fewer than batchSize markets are returned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          // Return only 1 item (less than batchSize=100) — should stop after this page
          json: async () => [makeActiveMarket({ id: "a1" })],
        })
    );

    const markets = await fetchActiveMarkets(50);
    // Only one fetch call should have been made
    expect(markets.length).toBe(1);
  });
});
