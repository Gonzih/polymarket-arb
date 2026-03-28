import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RiskManager } from '../kelly.js';

// Mock logger to avoid FS writes during tests
vi.mock('../logger.js', () => ({ log: vi.fn() }));

// Constants from kelly.ts (replicated for clarity):
//   MAX_KELLY = 0.10, MAX_POSITION = 0.08
//   DAILY_LOSS_LIMIT = -0.20, TOTAL_DRAWDOWN_LIMIT = -0.40

describe('RiskManager', () => {
  let risk: RiskManager;

  beforeEach(() => {
    risk = new RiskManager(1_000);
  });

  // ── sizePosition ──────────────────────────────────────────────────────────

  describe('sizePosition', () => {
    it('calculates contracts correctly (kelly below cap)', () => {
      // kelly=0.05, price=0.7
      // kellySize = 1000 * 0.05 = 50
      // maxByPortfolio = 1000 * 0.08 = 80
      // size = min(50, 80) = 50
      // contracts = floor(50/0.7 * 100) / 100 = floor(7142.85) / 100 = 71.42
      const contracts = risk.sizePosition(0.05, 0.7);
      expect(contracts).toBe(71.42);
    });

    it('caps position at 8% of portfolio regardless of kelly', () => {
      // kelly=0.20 → cappedKelly=0.10 → kellySize=100
      // maxByPortfolio = 80
      // size = min(100, 80) = 80; price=1.0 → contracts=80
      const contracts = risk.sizePosition(0.20, 1.0);
      expect(contracts).toBe(80);
    });

    it('respects MAX_KELLY cap at 10%', () => {
      // kelly=0.10 exactly (cap boundary), price=1.0
      // kellySize = 100, maxByPortfolio = 80 → size = 80
      const contracts = risk.sizePosition(0.10, 1.0);
      expect(contracts).toBe(80);
    });

    it('returns 0 when price is 0 (division guard)', () => {
      expect(risk.sizePosition(0.05, 0)).toBe(0);
    });

    it('returns 0 when kelly fraction is 0', () => {
      // size = min(0, 80) = 0 → contracts = 0
      expect(risk.sizePosition(0, 0.5)).toBe(0);
    });

    it('floors to 2 decimal places', () => {
      // kelly=0.05, price=0.3
      // kellySize = 50; maxByPortfolio = 80; size = 50
      // contracts = floor(50/0.3 * 100) / 100 = floor(16666.6) / 100 = 166.66
      const contracts = risk.sizePosition(0.05, 0.3);
      expect(contracts).toBe(166.66);
    });

    it('scales with portfolio size', () => {
      const bigRisk = new RiskManager(10_000);
      // kelly=0.05, price=1.0 → size = min(500, 800) = 500 → contracts = 500
      expect(bigRisk.sizePosition(0.05, 1.0)).toBe(500);
    });
  });

  // ── checkLimits ──────────────────────────────────────────────────────────

  describe('checkLimits', () => {
    it('returns ok=true when no losses', () => {
      const result = risk.checkLimits();
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('halts when daily loss reaches exactly -20%', () => {
      risk.recordTrade(-200); // portfolio = 800; dailyReturn = -0.20
      const result = risk.checkLimits();
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('Daily loss limit');
      expect(risk.isHalted()).toBe(true);
    });

    it('does NOT halt at -19% daily loss (below limit)', () => {
      risk.recordTrade(-190); // dailyReturn = -0.19
      expect(risk.checkLimits().ok).toBe(true);
      expect(risk.isHalted()).toBe(false);
    });

    it('halts when total drawdown reaches -40%', () => {
      // Spread losses across 3 days so no single day hits the -20% daily limit.
      risk.recordTrade(500);  // portfolio=1500, peak=1500
      risk.resetDay();
      risk.recordTrade(-200); // portfolio=1300, daily=-13.3% (safe), peak=1500
      risk.resetDay();
      risk.recordTrade(-200); // portfolio=1100, daily=-15.4% (safe), peak=1500
      risk.resetDay();
      risk.recordTrade(-200); // portfolio=900,  daily=-18.2% (safe)
      // drawdown = (900-1500)/1500 = -0.40 → kill switch fires
      const result = risk.checkLimits();
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('drawdown');
      expect(risk.isHalted()).toBe(true);
    });

    it('does NOT halt at -39% drawdown (below kill switch)', () => {
      // Same multi-day erosion but stop at -39% from peak.
      risk.recordTrade(500);  // portfolio=1500, peak=1500
      risk.resetDay();
      risk.recordTrade(-200); // portfolio=1300, daily=-13.3% (safe)
      risk.resetDay();
      risk.recordTrade(-200); // portfolio=1100, daily=-15.4% (safe)
      risk.resetDay();
      risk.recordTrade(-185); // portfolio=915,  daily=-16.8% (safe)
      // drawdown = (915-1500)/1500 = -0.39 → -0.39 > -0.40 → ok
      expect(risk.checkLimits().ok).toBe(true);
    });

    it('daily loss limit takes precedence over no-halt scenario', () => {
      // Lose 25% — exceeds daily limit
      risk.recordTrade(-250);
      const result = risk.checkLimits();
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('Daily loss limit');
    });
  });

  // ── resetDay ─────────────────────────────────────────────────────────────

  describe('resetDay', () => {
    it('resets start-of-day portfolio so prior losses are forgiven', () => {
      risk.recordTrade(-100); // portfolio=900; dailyReturn=-0.10
      risk.resetDay();         // startOfDay=900
      // Now dailyReturn = 0 → no halt
      expect(risk.checkLimits().ok).toBe(true);
    });

    it('does not reset the peak portfolio', () => {
      risk.recordTrade(200);  // portfolio=1200, peak=1200
      risk.resetDay();
      risk.recordTrade(-600); // portfolio=600; drawdown=(600-1200)/1200=-0.50
      const result = risk.checkLimits();
      expect(result.ok).toBe(false); // drawdown kill switch fires
    });
  });

  // ── recordTrade & getPortfolio ────────────────────────────────────────────

  describe('recordTrade', () => {
    it('increases portfolio on profit', () => {
      risk.recordTrade(250);
      expect(risk.getPortfolio()).toBe(1_250);
    });

    it('decreases portfolio on loss', () => {
      risk.recordTrade(-150);
      expect(risk.getPortfolio()).toBe(850);
    });

    it('updates peak when portfolio hits new high', () => {
      risk.recordTrade(500); // portfolio=1500 → new peak
      risk.recordTrade(-100); // portfolio=1400
      // drawdown = (1400-1500)/1500 = -0.0667 → safe
      expect(risk.checkLimits().ok).toBe(true);
    });

    it('does not lower peak on loss', () => {
      risk.recordTrade(500);  // peak=1500
      risk.recordTrade(-200); // portfolio=1300, peak still 1500
      risk.recordTrade(300);  // portfolio=1600 → new peak=1600
      // drawdown from new peak is tiny → safe
      expect(risk.checkLimits().ok).toBe(true);
    });
  });

  // ── isHalted ─────────────────────────────────────────────────────────────

  describe('isHalted', () => {
    it('starts not halted', () => {
      expect(risk.isHalted()).toBe(false);
    });

    it('stays halted after limit is triggered', () => {
      risk.recordTrade(-200);
      risk.checkLimits();
      risk.resetDay(); // reset day does NOT clear halt flag
      expect(risk.isHalted()).toBe(true);
    });
  });
});
