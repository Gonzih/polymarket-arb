import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock child_process + logger ──────────────────────────────────────────────

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => {
  const execFileMock = vi.fn();
  (execFileMock as any)[Symbol.for('nodejs.util.promisify.custom')] = mockExecFile;
  return { execFile: execFileMock };
});

const mockLog = vi.hoisted(() => vi.fn());
vi.mock('../logger.js', () => ({ log: mockLog }));

import {
  runSimulation,
  shouldRunSimulation,
  kellyAdjustment,
  logSimulationResult,
} from '../simulationSignal.js';
import type { SimulationTrigger, SimulationResult, SimulationSignal } from '../simulationSignal.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function agentResponse(prob: number, agentName: string, reasoning = 'test reason'): { stdout: string; stderr: string } {
  return {
    stdout: `P(YES)=${prob.toFixed(2)} | ${agentName}: ${reasoning}`,
    stderr: '',
  };
}

const baseTrigger: SimulationTrigger = {
  type: 'scheduled',
  marketId: 'market-1',
  marketQuestion: 'Will BTC exceed $60,000 by end of month?',
  marketOdds: 0.50,
  volume: 500_000,
  hoursToResolution: 48,
};

// ── 1. Debate engine returns 4 estimates ─────────────────────────────────────

describe('runSimulation — debate engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls execFile 4 times (one per agent) and returns 4 agent estimates', async () => {
    mockExecFile
      .mockResolvedValueOnce(agentResponse(0.60, 'Bull'))
      .mockResolvedValueOnce(agentResponse(0.40, 'Bear'))
      .mockResolvedValueOnce(agentResponse(0.55, 'Regulator'))
      .mockResolvedValueOnce(agentResponse(0.45, 'Contrarian'));

    const result = await runSimulation(baseTrigger);

    expect(mockExecFile).toHaveBeenCalledTimes(4);
    expect(result.agents).toHaveLength(4);
    expect(result.agents.map((a) => a.agent)).toEqual(['Bull', 'Bear', 'Regulator', 'Contrarian']);
  });

  it('includes parsed probability and reasoning for each agent', async () => {
    mockExecFile
      .mockResolvedValueOnce(agentResponse(0.70, 'Bull', 'Strong institutional flow'))
      .mockResolvedValueOnce(agentResponse(0.30, 'Bear', 'Retail decay visible'))
      .mockResolvedValueOnce(agentResponse(0.50, 'Regulator', 'Regulatory neutral'))
      .mockResolvedValueOnce(agentResponse(0.45, 'Contrarian', 'Fading consensus'));

    const result = await runSimulation(baseTrigger);

    expect(result.agents[0].prob).toBeCloseTo(0.70);
    expect(result.agents[1].prob).toBeCloseTo(0.30);
    expect(result.agents[0].reasoning).toContain('Bull');
    expect(result.agents[1].reasoning).toContain('Bear');
  });

  it('uses fallback prob 0.5 when an agent fails, without crashing', async () => {
    mockExecFile
      .mockResolvedValueOnce(agentResponse(0.60, 'Bull'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(agentResponse(0.55, 'Regulator'))
      .mockRejectedValueOnce(new Error('timeout'));

    const result = await runSimulation(baseTrigger);

    expect(result.agents).toHaveLength(4);
    // Failed agents get fallback prob of 0.5
    expect(result.agents[1].prob).toBe(0.5);
    expect(result.agents[3].prob).toBe(0.5);
  });

  it('uses claude-haiku-4-5-20251001 model for all agents', async () => {
    mockExecFile.mockResolvedValue(agentResponse(0.50, 'Agent'));

    await runSimulation(baseTrigger);

    for (const call of mockExecFile.mock.calls) {
      const args = call[1] as string[];
      expect(args).toContain('--model');
      expect(args).toContain('claude-haiku-4-5-20251001');
    }
  });
});

// ── 2. Aggregation math ───────────────────────────────────────────────────────

describe('runSimulation — aggregation math', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('computes syntheticProb as median of 4 estimates', async () => {
    // [0.40, 0.50, 0.60, 0.70] → sorted → median = (0.50+0.60)/2 = 0.55
    mockExecFile
      .mockResolvedValueOnce(agentResponse(0.70, 'Bull'))
      .mockResolvedValueOnce(agentResponse(0.40, 'Bear'))
      .mockResolvedValueOnce(agentResponse(0.60, 'Regulator'))
      .mockResolvedValueOnce(agentResponse(0.50, 'Contrarian'));

    const result = await runSimulation(baseTrigger);
    expect(result.syntheticProb).toBeCloseTo(0.55);
  });

  it('computes spread as max - min of agent probs', async () => {
    // max=0.80, min=0.20 → spread=0.60
    mockExecFile
      .mockResolvedValueOnce(agentResponse(0.80, 'Bull'))
      .mockResolvedValueOnce(agentResponse(0.20, 'Bear'))
      .mockResolvedValueOnce(agentResponse(0.50, 'Regulator'))
      .mockResolvedValueOnce(agentResponse(0.50, 'Contrarian'));

    const result = await runSimulation(baseTrigger);
    expect(result.spread).toBeCloseTo(0.60);
  });

  it('computes edge as syntheticProb - marketOdds', async () => {
    // syntheticProb = median([0.55, 0.55, 0.65, 0.65]) = 0.60, marketOdds = 0.50 → edge = 0.10
    mockExecFile
      .mockResolvedValueOnce(agentResponse(0.65, 'Bull'))
      .mockResolvedValueOnce(agentResponse(0.55, 'Bear'))
      .mockResolvedValueOnce(agentResponse(0.65, 'Regulator'))
      .mockResolvedValueOnce(agentResponse(0.55, 'Contrarian'));

    const result = await runSimulation(baseTrigger);
    expect(result.edge).toBeCloseTo(0.10);
    expect(result.marketOdds).toBe(0.50);
  });

  it('classifies DIRECTIONAL when edge>10% and spread<20%', async () => {
    // edge = 0.12 (12%), spread = 0.05 (5%) → DIRECTIONAL
    mockExecFile
      .mockResolvedValueOnce(agentResponse(0.64, 'Bull'))
      .mockResolvedValueOnce(agentResponse(0.60, 'Bear'))
      .mockResolvedValueOnce(agentResponse(0.64, 'Regulator'))
      .mockResolvedValueOnce(agentResponse(0.60, 'Contrarian'));

    const result = await runSimulation(baseTrigger);
    // median([0.60, 0.60, 0.64, 0.64]) = (0.60+0.64)/2 = 0.62, edge = 0.12, spread = 0.04
    expect(result.signal).toBe('DIRECTIONAL' as SimulationSignal);
  });

  it('classifies VOLATILITY when spread>30%', async () => {
    // spread = 0.80 → VOLATILITY
    mockExecFile
      .mockResolvedValueOnce(agentResponse(0.90, 'Bull'))
      .mockResolvedValueOnce(agentResponse(0.10, 'Bear'))
      .mockResolvedValueOnce(agentResponse(0.50, 'Regulator'))
      .mockResolvedValueOnce(agentResponse(0.50, 'Contrarian'));

    const result = await runSimulation(baseTrigger);
    expect(result.signal).toBe('VOLATILITY' as SimulationSignal);
  });

  it('classifies PASS when edge<=10% and spread<=30%', async () => {
    // All agree near market odds → small edge, small spread → PASS
    mockExecFile
      .mockResolvedValueOnce(agentResponse(0.52, 'Bull'))
      .mockResolvedValueOnce(agentResponse(0.50, 'Bear'))
      .mockResolvedValueOnce(agentResponse(0.52, 'Regulator'))
      .mockResolvedValueOnce(agentResponse(0.50, 'Contrarian'));

    const result = await runSimulation(baseTrigger);
    expect(result.signal).toBe('PASS' as SimulationSignal);
  });

  it('includes timestamp in result', async () => {
    mockExecFile.mockResolvedValue(agentResponse(0.50, 'Agent'));
    const before = Date.now();
    const result = await runSimulation(baseTrigger);
    const after = Date.now();
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });
});

// ── 3. shouldRunSimulation ────────────────────────────────────────────────────

describe('shouldRunSimulation', () => {
  it('returns true when volume>250k and hoursToResolution>24', () => {
    expect(shouldRunSimulation(300_000, 48)).toBe(true);
  });

  it('returns false when volume<=250k', () => {
    expect(shouldRunSimulation(250_000, 48)).toBe(false);
    expect(shouldRunSimulation(100_000, 48)).toBe(false);
  });

  it('returns false when hoursToResolution<=24', () => {
    expect(shouldRunSimulation(300_000, 24)).toBe(false);
    expect(shouldRunSimulation(300_000, 12)).toBe(false);
  });

  it('returns false when both conditions fail', () => {
    expect(shouldRunSimulation(100_000, 10)).toBe(false);
  });

  it('returns true at boundary: volume=250001 and hours=24.1', () => {
    expect(shouldRunSimulation(250_001, 24.1)).toBe(true);
  });
});

// ── 4. Kelly adjustment ───────────────────────────────────────────────────────

describe('kellyAdjustment', () => {
  function makeResult(signal: SimulationSignal, spread: number): SimulationResult {
    return {
      signal,
      edge: 0.12,
      spread,
      syntheticProb: 0.62,
      marketOdds: 0.50,
      agents: [],
      timestamp: Date.now(),
    };
  }

  it('returns 1.0 for DIRECTIONAL with low spread (<20%)', () => {
    expect(kellyAdjustment(makeResult('DIRECTIONAL', 0.10))).toBe(1.0);
  });

  it('returns 0.5 for DIRECTIONAL with high spread (>=20%)', () => {
    expect(kellyAdjustment(makeResult('DIRECTIONAL', 0.20))).toBe(0.5);
    expect(kellyAdjustment(makeResult('DIRECTIONAL', 0.25))).toBe(0.5);
  });

  it('returns 0.0 for VOLATILITY signal', () => {
    expect(kellyAdjustment(makeResult('VOLATILITY', 0.35))).toBe(0.0);
  });

  it('returns 1.0 for PASS with low spread', () => {
    expect(kellyAdjustment(makeResult('PASS', 0.10))).toBe(1.0);
  });

  it('returns 0.5 for PASS with high spread', () => {
    expect(kellyAdjustment(makeResult('PASS', 0.20))).toBe(0.5);
  });
});

// ── 5. logSimulationResult ────────────────────────────────────────────────────

describe('logSimulationResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls log with level "info"', () => {
    const result: SimulationResult = {
      signal: 'DIRECTIONAL',
      edge: 0.12,
      spread: 0.08,
      syntheticProb: 0.62,
      marketOdds: 0.50,
      agents: [
        { agent: 'Bull', prob: 0.70, reasoning: 'strong bull' },
        { agent: 'Bear', prob: 0.30, reasoning: 'bear case' },
        { agent: 'Regulator', prob: 0.65, reasoning: 'regulatory upside' },
        { agent: 'Contrarian', prob: 0.60, reasoning: 'fading downside' },
      ],
      timestamp: 1_700_000_000_000,
    };

    logSimulationResult(result, 'Will BTC exceed $60k?');

    expect(mockLog).toHaveBeenCalledOnce();
    const [level, data] = mockLog.mock.calls[0] as [string, Record<string, unknown>];
    expect(level).toBe('info');
    expect(data.event).toBe('simulation_result');
  });

  it('includes signal, edge, spread, syntheticProb, marketOdds, agents, and timestamp', () => {
    const result: SimulationResult = {
      signal: 'VOLATILITY',
      edge: -0.05,
      spread: 0.40,
      syntheticProb: 0.45,
      marketOdds: 0.50,
      agents: [
        { agent: 'Bull', prob: 0.70, reasoning: 'bull case' },
        { agent: 'Bear', prob: 0.30, reasoning: 'bear case' },
        { agent: 'Regulator', prob: 0.40, reasoning: 'regulatory bearish' },
        { agent: 'Contrarian', prob: 0.50, reasoning: 'neutral' },
      ],
      timestamp: 1_700_000_000_000,
    };

    logSimulationResult(result, 'Test market question');

    const [, data] = mockLog.mock.calls[0] as [string, Record<string, unknown>];
    expect(data.signal).toBe('VOLATILITY');
    expect(data.marketQuestion).toBe('Test market question');
    expect(data.syntheticProb).toBeDefined();
    expect(data.marketOdds).toBe(0.50);
    expect(data.agents).toHaveLength(4);
    expect(data.timestamp).toBe(1_700_000_000_000);
  });

  it('logs edge and spread as percentage points (numbers)', () => {
    const result: SimulationResult = {
      signal: 'PASS',
      edge: 0.05,
      spread: 0.15,
      syntheticProb: 0.55,
      marketOdds: 0.50,
      agents: [],
      timestamp: Date.now(),
    };

    logSimulationResult(result, 'Test?');

    const [, data] = mockLog.mock.calls[0] as [string, Record<string, unknown>];
    // edge logged as pp: 5.00
    expect(data.edge).toBeCloseTo(5.0);
    // spread logged as pp: 15.00
    expect(data.spread).toBeCloseTo(15.0);
  });

  it('includes source "simulationSignal" in log data', () => {
    const result: SimulationResult = {
      signal: 'PASS',
      edge: 0,
      spread: 0.10,
      syntheticProb: 0.50,
      marketOdds: 0.50,
      agents: [],
      timestamp: Date.now(),
    };

    logSimulationResult(result, 'Anything?');

    const [, data] = mockLog.mock.calls[0] as [string, Record<string, unknown>];
    expect(data.source).toBe('simulationSignal');
  });
});
