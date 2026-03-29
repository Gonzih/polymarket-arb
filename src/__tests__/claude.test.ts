import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { MomentumSignal } from '../signal.js';
import type { Contract } from '../polymarket.js';

// ── Mock setup ───────────────────────────────────────────────────────────────
//
// claude.ts uses spawn('claude', ['--print', '--model', model], ...) and
// writes the prompt to proc.stdin. We mock spawn to return a fake process
// that emits stdout data and an exit event after stdin.end() is called.

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('../logger.js', () => ({ log: vi.fn() }));

// Import after mocks are registered
import { analyzeTradeOpportunity } from '../claude.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Fixtures ─────────────────────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('analyzeTradeOpportunity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a TradeAnalysis object for valid JSON response', async () => {
    mockSpawn.mockReturnValue(makeProc(
      '{"confidence":0.8,"kelly_fraction":0.05,"reasoning":"strong signal","enter":true}'
    ));

    const result = await analyzeTradeOpportunity(signal, contract);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.8);
    expect(result!.kelly_fraction).toBe(0.05);
    expect(result!.enter).toBe(true);
    expect(result!.reasoning).toBe('strong signal');
  });

  it('extracts JSON embedded in surrounding text / markdown', async () => {
    mockSpawn.mockReturnValue(makeProc(
      'Here is my analysis:\n{"confidence":0.6,"kelly_fraction":0.03,"reasoning":"moderate","enter":false}\nDone.'
    ));

    const result = await analyzeTradeOpportunity(signal, contract);
    expect(result).not.toBeNull();
    expect(result!.enter).toBe(false);
    expect(result!.confidence).toBe(0.6);
  });

  it('returns null when claude output contains no JSON object', async () => {
    mockSpawn.mockReturnValue(makeProc('Sorry, I cannot analyze this right now.'));

    const result = await analyzeTradeOpportunity(signal, contract);
    expect(result).toBeNull();
  });

  it('returns null when claude output is empty', async () => {
    mockSpawn.mockReturnValue(makeProc(''));

    const result = await analyzeTradeOpportunity(signal, contract);
    expect(result).toBeNull();
  });

  it('returns null when spawn errors (process error)', async () => {
    mockSpawn.mockReturnValue(makeProc('', 0, new Error('spawn ENOENT')));

    const result = await analyzeTradeOpportunity(signal, contract);
    expect(result).toBeNull();
  });

  it('returns null when process exits with non-zero code', async () => {
    mockSpawn.mockReturnValue(makeProc('', 1));

    const result = await analyzeTradeOpportunity(signal, contract);
    expect(result).toBeNull();
  });

  it('returns null when JSON is syntactically invalid', async () => {
    mockSpawn.mockReturnValue(makeProc('{confidence: 0.8, enter: yes}')); // not valid JSON

    // The regex /\{[\s\S]*\}/ will match, but JSON.parse will throw
    const result = await analyzeTradeOpportunity(signal, contract);
    expect(result).toBeNull();
  });

  it('handles "down" direction signal correctly (direction mismatch)', async () => {
    const downSignal: MomentumSignal = { ...signal, direction: 'down' };
    mockSpawn.mockReturnValue(makeProc(
      '{"confidence":0.4,"kelly_fraction":0.02,"reasoning":"signal mismatch","enter":false}'
    ));

    const result = await analyzeTradeOpportunity(downSignal, contract);
    expect(result).not.toBeNull();
    expect(result!.enter).toBe(false);
  });

  it('passes the correct arguments to spawn and prompt to stdin', async () => {
    const proc = makeProc('{"confidence":0.7,"kelly_fraction":0.04,"reasoning":"ok","enter":true}');
    mockSpawn.mockReturnValue(proc);

    await analyzeTradeOpportunity(signal, contract);

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('claude');
    expect(args).toContain('--print');
    expect(args).toContain('--model');
    expect(args).toContain('claude-haiku-4-5-20251001');
    // Prompt goes to stdin, not as a positional arg
    expect(proc.stdin.write).toHaveBeenCalledOnce();
    expect(proc.stdin.end).toHaveBeenCalledOnce();
  });

  it('does not inject CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_AUTH_TOKEN overrides', async () => {
    const proc = makeProc('{"confidence":0.7,"kelly_fraction":0.04,"reasoning":"ok","enter":true}');
    mockSpawn.mockReturnValue(proc);

    await analyzeTradeOpportunity(signal, contract);

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    // env should be a spread of process.env — not adding extra token keys with hardcoded values
    expect(spawnOptions.env).toBeDefined();
    // The env should equal process.env (no extra overrides layered on top)
    expect(spawnOptions.env).toEqual({ ...process.env });
  });
});
