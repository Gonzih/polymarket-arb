import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WhaleFadeSignal } from '../polymarket.js';

// ── Mock child_process + logger ───────────────────────────────────────────────
//
// simulate.ts uses spawn('claude', ...) and writes prompts to stdin.
// We mock spawn to return fake processes that emit stdout and exit events.

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('../logger.js', () => ({ log: vi.fn() }));

import { simulateMarket, median, computeHighConfidenceEdge } from '../simulate.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProc(stdoutData: string, exitCode = 0, throwError?: Error) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.stdin = {
    write: vi.fn(),
    end: vi.fn().mockImplementation(() => {
      setImmediate(() => {
        if (throwError) {
          proc.emit('error', throwError);
        } else {
          if (stdoutData) proc.stdout.emit('data', Buffer.from(stdoutData));
          proc.emit('exit', exitCode);
        }
      });
    }),
  };
  return proc;
}

function personaProc(probability: number, reasoning = 'test reason') {
  return makeProc(JSON.stringify({ probability, reasoning }));
}

// ── median() ──────────────────────────────────────────────────────────────────

describe('median', () => {
  it('returns 0.5 for empty array', () => {
    expect(median([])).toBe(0.5);
  });

  it('returns the only element for a single-element array', () => {
    expect(median([0.7])).toBe(0.7);
  });

  it('returns the middle element for odd-length sorted array', () => {
    expect(median([0.2, 0.5, 0.8])).toBe(0.5);
  });

  it('handles unsorted input correctly', () => {
    expect(median([0.8, 0.2, 0.5])).toBe(0.5);
  });

  it('returns average of two middle elements for even-length array', () => {
    expect(median([0.2, 0.4, 0.6, 0.8])).toBeCloseTo(0.5);
  });

  it('handles all same values', () => {
    expect(median([0.6, 0.6, 0.6])).toBe(0.6);
  });
});

// ── simulateMarket() ──────────────────────────────────────────────────────────

describe('simulateMarket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns consensus as median of 5 persona estimates', async () => {
    // Persona estimates: 30, 40, 50, 60, 70 → median = 50
    mockSpawn
      .mockReturnValueOnce(personaProc(30))
      .mockReturnValueOnce(personaProc(40))
      .mockReturnValueOnce(personaProc(50))
      .mockReturnValueOnce(personaProc(60))
      .mockReturnValueOnce(personaProc(70));

    const result = await simulateMarket('Will BTC exceed $60k?', 0.5);
    expect(result.consensus).toBeCloseTo(0.5);
    expect(result.personas).toHaveLength(5);
  });

  it('calculates spread as max minus min of estimates', async () => {
    // estimates: 20, 40, 60, 80, 100 → spread = 0.8
    mockSpawn
      .mockReturnValueOnce(personaProc(20))
      .mockReturnValueOnce(personaProc(40))
      .mockReturnValueOnce(personaProc(60))
      .mockReturnValueOnce(personaProc(80))
      .mockReturnValueOnce(personaProc(100));

    const result = await simulateMarket('Will ETH exceed $3k?', 0.5);
    expect(result.spread).toBeCloseTo(0.8);
  });

  it('includes persona names in result', async () => {
    mockSpawn.mockReturnValue(personaProc(50));

    const result = await simulateMarket('Will BTC be higher?', 0.5);
    const names = result.personas.map((p) => p.name);
    expect(names).toContain('skeptic');
    expect(names).toContain('optimist');
    expect(names).toContain('trader');
    expect(names).toContain('regulator');
    expect(names).toContain('journalist');
  });

  it('filters out personas that fail (error results)', async () => {
    // 2 succeed, 3 fail
    mockSpawn
      .mockReturnValueOnce(personaProc(40))
      .mockReturnValueOnce(makeProc('', 0, new Error('timeout')))
      .mockReturnValueOnce(personaProc(60))
      .mockReturnValueOnce(makeProc('', 0, new Error('timeout')))
      .mockReturnValueOnce(makeProc('', 0, new Error('timeout')));

    const result = await simulateMarket('Will BTC drop?', 0.5);
    expect(result.personas).toHaveLength(2);
    expect(result.consensus).toBeCloseTo(0.5); // median of [0.4, 0.6]
  });

  it('clamps probability estimates to 0-100 range', async () => {
    mockSpawn
      .mockReturnValueOnce(personaProc(-10))   // should clamp to 0
      .mockReturnValueOnce(personaProc(150))   // should clamp to 100
      .mockReturnValueOnce(personaProc(50))
      .mockReturnValueOnce(personaProc(50))
      .mockReturnValueOnce(personaProc(50));

    const result = await simulateMarket('Test?', 0.5);
    const estimates = result.personas.map((p) => p.estimate);
    expect(Math.min(...estimates)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...estimates)).toBeLessThanOrEqual(1);
  });

  it('returns spread of 0 when only one persona responds', async () => {
    mockSpawn
      .mockReturnValueOnce(personaProc(60))
      .mockReturnValue(makeProc('', 0, new Error('fail')));

    const result = await simulateMarket('Test?', 0.5);
    expect(result.spread).toBe(0);
    expect(result.personas).toHaveLength(1);
  });

  it('returns null-safe result when all personas fail', async () => {
    mockSpawn.mockReturnValue(makeProc('', 0, new Error('all fail')));

    const result = await simulateMarket('Test?', 0.5);
    expect(result.personas).toHaveLength(0);
    expect(result.spread).toBe(0);
    expect(result.consensus).toBe(0.5); // median of empty = 0.5
  });
});

// ── computeHighConfidenceEdge() ───────────────────────────────────────────────

describe('computeHighConfidenceEdge', () => {
  it('returns false when whaleFade is null', () => {
    expect(computeHighConfidenceEdge(null, 0.7, 0.5)).toBe(false);
  });

  it('returns false when simulationConsensus is null', () => {
    const wf: WhaleFadeSignal = { direction: 'buy', size: 20000, minutesAgo: 5 };
    expect(computeHighConfidenceEdge(wf, null, 0.5)).toBe(false);
  });

  it('returns false when simulation gap is ≤8pp', () => {
    const wf: WhaleFadeSignal = { direction: 'buy', size: 20000, minutesAgo: 5 };
    // consensus 57% vs odds 50% → gap = 7pp ≤ 8
    expect(computeHighConfidenceEdge(wf, 0.57, 0.5)).toBe(false);
  });

  it('returns false when gap is exactly 8pp (boundary)', () => {
    const wf: WhaleFadeSignal = { direction: 'buy', size: 20000, minutesAgo: 5 };
    expect(computeHighConfidenceEdge(wf, 0.58, 0.5)).toBe(false);
  });

  it('returns true when whale fade and simulation agree on buy direction', () => {
    // Whale sold → fade = buy. Consensus 65% > odds 50% → sim says buy.
    const wf: WhaleFadeSignal = { direction: 'buy', size: 20000, minutesAgo: 5 };
    expect(computeHighConfidenceEdge(wf, 0.65, 0.5)).toBe(true);
  });

  it('returns true when whale fade and simulation agree on sell direction', () => {
    // Whale bought → fade = sell. Consensus 35% < odds 50% → sim says sell.
    const wf: WhaleFadeSignal = { direction: 'sell', size: 20000, minutesAgo: 5 };
    expect(computeHighConfidenceEdge(wf, 0.35, 0.5)).toBe(true);
  });

  it('returns false when whale and simulation disagree on direction', () => {
    // Whale sold → fade = buy. But consensus 35% < odds 50% → sim says sell.
    const wf: WhaleFadeSignal = { direction: 'buy', size: 20000, minutesAgo: 5 };
    expect(computeHighConfidenceEdge(wf, 0.35, 0.5)).toBe(false);
  });

  it('works with 9pp gap (just above threshold)', () => {
    const wf: WhaleFadeSignal = { direction: 'sell', size: 15000, minutesAgo: 2 };
    // consensus 40% vs odds 50% → gap = 10pp > 8, sim says sell, whale says sell
    expect(computeHighConfidenceEdge(wf, 0.40, 0.50)).toBe(true);
  });
});
