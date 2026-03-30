import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAppendFileSync = vi.hoisted(() => vi.fn());
vi.mock('fs', () => ({
  default: {
    appendFileSync: mockAppendFileSync,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
  },
  appendFileSync: mockAppendFileSync,
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  log: vi.fn(),
  logDir: () => '/tmp/test-calibration',
}));

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

import { CalibrationLogger } from '../calibrationLogger.js';
import type { CalibrationEvent } from '../calibrationLogger.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<CalibrationEvent> = {}): CalibrationEvent {
  return {
    ts: Date.now(),
    signalType: 'debate',
    marketId: 'market-abc',
    question: 'Will BTC reach $100k?',
    syntheticProb: 0.65,
    marketOddsT0: 0.55,
    newsBoosted: false,
    ...overrides,
  };
}

function mockFetchPrice(price: number): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ tokens: [{ outcome: 'Yes', price }] }),
  });
}

// ── logEvent ──────────────────────────────────────────────────────────────────

describe('CalibrationLogger.logEvent', () => {
  let logger: CalibrationLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = new CalibrationLogger('/tmp/test-dir');
  });

  it('appends a JSON line to the calibration file', () => {
    const event = makeEvent();
    logger.logEvent(event);

    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const [filePath, content] = mockAppendFileSync.mock.calls[0] as [string, string];
    expect(filePath).toContain('calibration.jsonl');
    const parsed = JSON.parse(content.trim());
    expect(parsed.type).toBe('event');
    expect(parsed.marketId).toBe('market-abc');
    expect(parsed.syntheticProb).toBe(0.65);
  });

  it('includes agentBreakdown when provided', () => {
    const event = makeEvent({ agentBreakdown: { Bull: 0.7, Bear: 0.4 } });
    logger.logEvent(event);

    const [, content] = mockAppendFileSync.mock.calls[0] as [string, string];
    const parsed = JSON.parse(content.trim());
    expect(parsed.agentBreakdown).toEqual({ Bull: 0.7, Bear: 0.4 });
  });

  it('increments pendingCount after logging an event', () => {
    expect(logger.pendingCount).toBe(0);
    logger.logEvent(makeEvent());
    expect(logger.pendingCount).toBe(1);
    logger.logEvent(makeEvent({ marketId: 'market-xyz', ts: Date.now() + 1 }));
    expect(logger.pendingCount).toBe(2);
  });
});

// ── poll — checkpoint timing ──────────────────────────────────────────────────

describe('CalibrationLogger.poll — checkpoint timing', () => {
  let logger: CalibrationLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = new CalibrationLogger('/tmp/test-dir');
  });

  it('does not fetch when no checkpoints have been reached yet', async () => {
    // Event just created — no checkpoint reached
    logger.logEvent(makeEvent({ ts: Date.now() }));
    mockAppendFileSync.mockClear();

    await logger.poll();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('fetches odds and writes outcome when T+5 checkpoint is reached', async () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000 - 1000;
    logger.logEvent(makeEvent({ ts: fiveMinutesAgo }));
    mockAppendFileSync.mockClear();
    mockFetchPrice(0.62);

    await logger.poll();

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const [, content] = mockAppendFileSync.mock.calls[0] as [string, string];
    const parsed = JSON.parse(content.trim());
    expect(parsed.type).toBe('outcome');
    expect(parsed.oddsT5).toBe(0.62);
  });

  it('fills multiple checkpoints if enough time has passed', async () => {
    const sixtyMinutesAgo = Date.now() - 60 * 60 * 1000 - 1000;
    logger.logEvent(makeEvent({ ts: sixtyMinutesAgo }));
    mockAppendFileSync.mockClear();
    // All 4 checkpoints will be fetched in one poll pass
    mockFetchPrice(0.60); // T+5
    mockFetchPrice(0.61); // T+15
    mockFetchPrice(0.63); // T+30
    mockFetchPrice(0.65); // T+60

    await logger.poll();

    expect(mockFetch).toHaveBeenCalledTimes(4);
    const [, content] = mockAppendFileSync.mock.calls[0] as [string, string];
    const parsed = JSON.parse(content.trim());
    expect(parsed.oddsT5).toBe(0.60);
    expect(parsed.oddsT15).toBe(0.61);
    expect(parsed.oddsT30).toBe(0.63);
    expect(parsed.oddsT60).toBe(0.65);
  });

  it('removes event from pending after all checkpoints are filled', async () => {
    const sixtyMinutesAgo = Date.now() - 60 * 60 * 1000 - 1000;
    logger.logEvent(makeEvent({ ts: sixtyMinutesAgo }));
    mockFetchPrice(0.60);
    mockFetchPrice(0.61);
    mockFetchPrice(0.63);
    mockFetchPrice(0.65);

    await logger.poll();

    expect(logger.pendingCount).toBe(0);
  });

  it('does not re-fetch checkpoints already filled', async () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000 - 1000;
    logger.logEvent(makeEvent({ ts: fiveMinutesAgo }));
    mockAppendFileSync.mockClear();

    // First poll — fills T+5
    mockFetchPrice(0.62);
    await logger.poll();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();

    // Second poll — T+5 already filled, nothing new to fetch
    await logger.poll();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── poll — error handling ─────────────────────────────────────────────────────

describe('CalibrationLogger.poll — error handling', () => {
  let logger: CalibrationLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = new CalibrationLogger('/tmp/test-dir');
  });

  it('does not crash when fetch fails', async () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000 - 1000;
    logger.logEvent(makeEvent({ ts: fiveMinutesAgo }));
    mockAppendFileSync.mockClear();
    mockFetch.mockRejectedValueOnce(new Error('network error'));

    await expect(logger.poll()).resolves.toBeUndefined();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('does not write outcome when fetch returns non-ok status', async () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000 - 1000;
    logger.logEvent(makeEvent({ ts: fiveMinutesAgo }));
    mockAppendFileSync.mockClear();
    mockFetch.mockResolvedValueOnce({ ok: false });

    await logger.poll();

    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('prunes events older than 90 minutes + poll interval', async () => {
    const tooOld = Date.now() - (90 + 6) * 60 * 1000;
    logger.logEvent(makeEvent({ ts: tooOld }));
    mockAppendFileSync.mockClear();

    await logger.poll();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(logger.pendingCount).toBe(0);
  });
});

// ── start / stop ──────────────────────────────────────────────────────────────

describe('CalibrationLogger start/stop', () => {
  it('start sets up an interval and stop clears it', () => {
    const logger = new CalibrationLogger('/tmp/test-dir');
    logger.start();
    logger.stop();
    // No assertion needed beyond not throwing; confirms lifecycle methods work
  });

  it('calling start twice does not create duplicate intervals', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const logger = new CalibrationLogger('/tmp/test-dir');
    logger.start();
    logger.start(); // second call should be no-op
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    logger.stop();
    setIntervalSpy.mockRestore();
  });
});
