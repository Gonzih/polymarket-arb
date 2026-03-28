import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MomentumSignal } from '../signal.js';
import type { Contract } from '../polymarket.js';

// ── Mock setup ──────────────────────────────────────────────────────────────
//
// claude.ts does: const execFileAsync = promisify(execFile)  at module level.
// Node's promisify checks for [util.promisify.custom] on the function — if
// present it uses that as the async implementation directly.
// We attach our mock as that custom symbol so execFileAsync === mockExecFile.

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => {
  const execFileMock = vi.fn();
  // Attach as the promisify custom implementation: resolves { stdout, stderr }
  (execFileMock as any)[Symbol.for('nodejs.util.promisify.custom')] =
    mockExecFile;
  return { execFile: execFileMock };
});

vi.mock('../logger.js', () => ({ log: vi.fn() }));

// Import after mocks are registered
import { analyzeTradeOpportunity } from '../claude.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const signal: MomentumSignal = {
  symbol: 'BTC',
  direction: 'up',
  momentum: 0.004,
  currentPrice: 50_200,
  recentTicks: [50_000, 50_050, 50_100, 50_150, 50_200],
  timestamp: Date.now(),
};

const contract: Contract = {
  id: 'cid-1',
  question: 'Will BTC exceed $50,000?',
  expiresAt: Date.now() + 10 * 60_000,
  yesPrice: 0.7,
  noPrice: 0.3,
  symbol: 'BTC',
  direction: 'up',
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('analyzeTradeOpportunity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a TradeAnalysis object for valid JSON response', async () => {
    mockExecFile.mockResolvedValue({
      stdout:
        '{"confidence":0.8,"kelly_fraction":0.05,"reasoning":"strong signal","enter":true}',
      stderr: '',
    });

    const result = await analyzeTradeOpportunity(signal, contract);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.8);
    expect(result!.kelly_fraction).toBe(0.05);
    expect(result!.enter).toBe(true);
    expect(result!.reasoning).toBe('strong signal');
  });

  it('extracts JSON embedded in surrounding text / markdown', async () => {
    mockExecFile.mockResolvedValue({
      stdout:
        'Here is my analysis:\n{"confidence":0.6,"kelly_fraction":0.03,"reasoning":"moderate","enter":false}\nDone.',
      stderr: '',
    });

    const result = await analyzeTradeOpportunity(signal, contract);
    expect(result).not.toBeNull();
    expect(result!.enter).toBe(false);
    expect(result!.confidence).toBe(0.6);
  });

  it('returns null when claude output contains no JSON object', async () => {
    mockExecFile.mockResolvedValue({
      stdout: 'Sorry, I cannot analyze this right now.',
      stderr: '',
    });

    const result = await analyzeTradeOpportunity(signal, contract);
    expect(result).toBeNull();
  });

  it('returns null when claude output is empty', async () => {
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await analyzeTradeOpportunity(signal, contract);
    expect(result).toBeNull();
  });

  it('returns null when execFile throws (timeout / process error)', async () => {
    mockExecFile.mockRejectedValue(new Error('Command timed out after 15000ms'));

    const result = await analyzeTradeOpportunity(signal, contract);
    expect(result).toBeNull();
  });

  it('returns null when JSON is syntactically invalid', async () => {
    mockExecFile.mockResolvedValue({
      stdout: '{confidence: 0.8, enter: yes}', // not valid JSON
      stderr: '',
    });

    // The regex /\{[\s\S]*\}/ will match, but JSON.parse will throw
    const result = await analyzeTradeOpportunity(signal, contract);
    expect(result).toBeNull();
  });

  it('handles "down" direction signal correctly (direction mismatch)', async () => {
    const downSignal: MomentumSignal = { ...signal, direction: 'down' };
    mockExecFile.mockResolvedValue({
      stdout:
        '{"confidence":0.4,"kelly_fraction":0.02,"reasoning":"signal mismatch","enter":false}',
      stderr: '',
    });

    const result = await analyzeTradeOpportunity(downSignal, contract);
    expect(result).not.toBeNull();
    expect(result!.enter).toBe(false);
  });

  it('passes the correct prompt arguments to execFile', async () => {
    mockExecFile.mockResolvedValue({
      stdout: '{"confidence":0.7,"kelly_fraction":0.04,"reasoning":"ok","enter":true}',
      stderr: '',
    });

    await analyzeTradeOpportunity(signal, contract);

    // execFileAsync is mockExecFile directly (via promisify.custom)
    expect(mockExecFile).toHaveBeenCalledOnce();
    const [cmd, args] = mockExecFile.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe('claude');
    expect(args).toContain('--print');
    expect(args).toContain('--model');
    expect(args).toContain('claude-haiku-4-5-20251001');
  });
});
