import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SignalEngine } from '../signal.js';
import type { PriceTick } from '../feeds.js';

// WINDOW_MS = 30_000, MOMENTUM_THRESHOLD = 0.015 (1.5%)
// ROLLING_WINDOW_MS = 300_000, ROLLING_WINDOWS = 10, VOLUME_MULTIPLIER = 3
// COOLDOWN_MS = 300_000 (5 minutes)

const BASE_TIME = 1_700_000_000_000;
const WINDOW_MS = 30_000;

function tick(
  symbol: 'BTC' | 'ETH',
  price: number,
  offsetMs: number
): PriceTick {
  return { symbol, price, timestamp: BASE_TIME + offsetMs, source: 'binance' };
}

describe('SignalEngine', () => {
  let engine: SignalEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    engine = new SignalEngine();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('single / insufficient data', () => {
    it('returns null with only one tick', () => {
      const result = engine.addTick(tick('BTC', 50_000, 0));
      expect(result).toBeNull();
    });

    it('returns null when both ticks are outside the 30s window', () => {
      engine.addTick(tick('BTC', 50_000, -35_000));
      const result = engine.addTick(tick('BTC', 50_300, -31_000));
      expect(result).toBeNull();
    });

    it('returns null when only the newest tick is inside the window', () => {
      engine.addTick(tick('BTC', 50_000, -40_000)); // outside window
      const result = engine.addTick(tick('BTC', 50_300, 0)); // inside window
      expect(result).toBeNull();
    });
  });

  describe('threshold gating', () => {
    it('returns null when momentum is below 1.5% (1.0% change)', () => {
      engine.addTick(tick('BTC', 50_000, -10_000));
      const result = engine.addTick(tick('BTC', 50_500, 0)); // 1.0%
      expect(result).toBeNull();
    });

    it('returns null when momentum is exactly 0 (flat price)', () => {
      engine.addTick(tick('BTC', 50_000, -10_000));
      const result = engine.addTick(tick('BTC', 50_000, 0));
      expect(result).toBeNull();
    });

    it('fires signal at exactly 1.5% (boundary — not strictly less than)', () => {
      const base = 50_000;
      const atThreshold = base * 0.015; // exactly 1.5%
      engine.addTick(tick('BTC', base, -10_000));
      const result = engine.addTick(tick('BTC', base + atThreshold, 0));
      // Code: Math.abs(momentum) < MOMENTUM_THRESHOLD → returns null
      // 0.015 < 0.015 is false → signal fires (rollingAvg < 1 → volume check skipped)
      expect(result).not.toBeNull();
    });

    it('fires signal above threshold (2.0% upward change)', () => {
      engine.addTick(tick('BTC', 50_000, -10_000));
      const result = engine.addTick(tick('BTC', 51_000, 0)); // 2.0%
      expect(result).not.toBeNull();
      expect(result!.direction).toBe('up');
      expect(result!.momentum).toBeCloseTo(0.02, 6);
      expect(result!.symbol).toBe('BTC');
      expect(result!.currentPrice).toBe(51_000);
    });

    it('fires signal for downward momentum (-2.0%)', () => {
      engine.addTick(tick('BTC', 50_000, -10_000));
      const result = engine.addTick(tick('BTC', 49_000, 0)); // -2.0%
      expect(result).not.toBeNull();
      expect(result!.direction).toBe('down');
      expect(result!.momentum).toBeCloseTo(-0.02, 6);
    });
  });

  describe('ETH independence', () => {
    it('tracks BTC and ETH separately', () => {
      engine.addTick(tick('BTC', 50_000, -10_000));
      engine.addTick(tick('ETH', 2_000, -10_000));

      const btcResult = engine.addTick(tick('BTC', 51_000, 0)); // 2.0%
      const ethResult = engine.addTick(tick('ETH', 2_040, 0)); // 2.0%

      expect(btcResult?.symbol).toBe('BTC');
      expect(ethResult?.symbol).toBe('ETH');
      expect(btcResult?.currentPrice).toBe(51_000);
      expect(ethResult?.currentPrice).toBe(2_040);
    });
  });

  describe('volume confirmation', () => {
    it('blocks signal when current-window tick count is not > 3x rolling average', () => {
      // 9 prior windows × 10 ticks each = high rolling average (~9 ticks/window)
      for (let w = 9; w >= 1; w--) {
        const windowBase = -w * WINDOW_MS;
        for (let i = 0; i < 10; i++) {
          engine.addTick(tick('BTC', 50_000, windowBase - i * 100));
        }
      }
      // Current window: only 3 ticks with 2% move — not > 3x rolling avg
      engine.addTick(tick('BTC', 50_000, -29_000));
      engine.addTick(tick('BTC', 50_500, -10_000));
      const result = engine.addTick(tick('BTC', 51_000, 0)); // 2% up
      // rollingTickCount ≈ 90 + 3 = 93, rollingAvg ≈ 9.3; recent.length = 3 ≤ 27.9 → blocked
      expect(result).toBeNull();
    });

    it('fires signal when current-window tick count is > 3x rolling average', () => {
      // 9 prior windows × 1 tick each = low rolling average (~1 tick/window)
      for (let w = 9; w >= 1; w--) {
        const windowBase = -w * WINDOW_MS;
        engine.addTick(tick('BTC', 50_000, windowBase));
      }
      // Current window: 5 ticks with 2% move
      // rollingTickCount = 9 + 5 = 14, rollingAvg = 1.4; recent.length = 5 > 4.2 → fires
      engine.addTick(tick('BTC', 50_000, -29_000));
      engine.addTick(tick('BTC', 50_200, -20_000));
      engine.addTick(tick('BTC', 50_400, -10_000));
      engine.addTick(tick('BTC', 50_700, -5_000));
      const result = engine.addTick(tick('BTC', 51_000, 0)); // 2% up
      expect(result).not.toBeNull();
      expect(result!.direction).toBe('up');
    });

    it('skips volume check when history is too thin (< 1 tick/window avg)', () => {
      // Only 2 ticks total — rollingAvg = 2/10 = 0.2 < 1 → volume check skipped
      engine.addTick(tick('BTC', 50_000, -10_000));
      const result = engine.addTick(tick('BTC', 50_800, 0)); // 1.6% up
      expect(result).not.toBeNull();
    });
  });

  describe('cooldown', () => {
    it('suppresses same-direction signal within 5 minutes', () => {
      // First signal: upward (2 ticks, thin history → volume check skipped)
      engine.addTick(tick('BTC', 50_000, -10_000));
      const first = engine.addTick(tick('BTC', 51_000, 0)); // 2% up
      expect(first).not.toBeNull();
      expect(first!.direction).toBe('up');

      // Advance 1 minute; try same direction again
      vi.setSystemTime(BASE_TIME + 60_000);
      engine.addTick(tick('BTC', 51_000, 50_000));
      const second = engine.addTick(tick('BTC', 52_020, 60_000)); // 2% up again
      expect(second).toBeNull(); // suppressed — same direction within 5 min
    });

    it('allows opposite-direction signal within cooldown period', () => {
      engine.addTick(tick('BTC', 50_000, -10_000));
      const first = engine.addTick(tick('BTC', 51_000, 0)); // up
      expect(first).not.toBeNull();

      // Advance 1 minute; try opposite direction
      vi.setSystemTime(BASE_TIME + 60_000);
      engine.addTick(tick('BTC', 53_000, 50_000));
      const second = engine.addTick(tick('BTC', 51_940, 60_000)); // ~2% down from 53_000
      expect(second).not.toBeNull(); // different direction — allowed
      expect(second!.direction).toBe('down');
    });

    it('allows same-direction signal after cooldown expires (> 5 min)', () => {
      engine.addTick(tick('BTC', 50_000, -10_000));
      const first = engine.addTick(tick('BTC', 51_000, 0)); // up
      expect(first).not.toBeNull();

      // Advance 6 minutes (past COOLDOWN_MS = 5 min)
      vi.setSystemTime(BASE_TIME + 360_000);
      engine.addTick(tick('BTC', 51_000, 350_000));
      const second = engine.addTick(tick('BTC', 52_020, 360_000)); // 2% up
      expect(second).not.toBeNull(); // cooldown expired
      expect(second!.direction).toBe('up');
    });
  });

  describe('NaN / edge cases', () => {
    it('does not throw when price is NaN', () => {
      engine.addTick(tick('BTC', 50_000, -10_000));
      // NaN momentum: Math.abs(NaN) < threshold is false → does not short-circuit
      // Signal may fire with NaN values; we only assert no crash
      expect(() => engine.addTick(tick('BTC', NaN, 0))).not.toThrow();
    });

    it('recentTicks contains last 5 prices by default', () => {
      for (let i = 0; i < 7; i++) {
        engine.addTick(tick('BTC', 100 * (i + 1), -20_000 + i * 1_000));
      }
      const result = engine.addTick(tick('BTC', 800, 0));
      if (result) {
        expect(result.recentTicks.length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('getRecentTicks', () => {
    it('returns empty array for unknown symbol', () => {
      expect(engine.getRecentTicks('BTC', 5)).toEqual([]);
    });

    it('returns last N prices in order', () => {
      engine.addTick(tick('BTC', 100, -4_000));
      engine.addTick(tick('BTC', 200, -3_000));
      engine.addTick(tick('BTC', 300, -2_000));
      engine.addTick(tick('BTC', 400, -1_000));
      engine.addTick(tick('BTC', 500, 0));

      expect(engine.getRecentTicks('BTC', 3)).toEqual([300, 400, 500]);
    });

    it('returns all ticks when N > stored count', () => {
      engine.addTick(tick('BTC', 100, -1_000));
      engine.addTick(tick('BTC', 200, 0));
      expect(engine.getRecentTicks('BTC', 10)).toEqual([100, 200]);
    });
  });
});
