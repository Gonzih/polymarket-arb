import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectWhaleFade, fetchRecentTrades } from '../polymarket.js';
import type { TradeEvent } from '../polymarket.js';

vi.mock('../logger.js', () => ({ log: vi.fn() }));

const MOCK_NOW = 1_700_000_000_000;

describe('detectWhaleFade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(MOCK_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when no trades', () => {
    expect(detectWhaleFade([])).toBeNull();
  });

  it('returns null when all trades are below $10k', () => {
    const trades: TradeEvent[] = [
      { size: 5000, side: 'buy', price: 0.7, timestamp: MOCK_NOW - 1000 },
      { size: 9999, side: 'sell', price: 0.65, timestamp: MOCK_NOW - 2000 },
    ];
    expect(detectWhaleFade(trades)).toBeNull();
  });

  it('detects whale buy and returns sell fade direction', () => {
    const trades: TradeEvent[] = [
      { size: 15000, side: 'buy', price: 0.7, timestamp: MOCK_NOW - 5 * 60_000 },
    ];
    const result = detectWhaleFade(trades);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('sell');
    expect(result!.size).toBe(15000);
    expect(result!.minutesAgo).toBe(5);
  });

  it('detects whale sell and returns buy fade direction', () => {
    const trades: TradeEvent[] = [
      { size: 50000, side: 'sell', price: 0.4, timestamp: MOCK_NOW - 10 * 60_000 },
    ];
    const result = detectWhaleFade(trades);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('buy');
    expect(result!.size).toBe(50000);
    expect(result!.minutesAgo).toBe(10);
  });

  it('returns null when whale trade is older than 30 minutes', () => {
    const trades: TradeEvent[] = [
      { size: 20000, side: 'buy', price: 0.7, timestamp: MOCK_NOW - 31 * 60_000 },
    ];
    expect(detectWhaleFade(trades)).toBeNull();
  });

  it('returns null when whale trade is exactly 30 minutes ago (boundary)', () => {
    const trades: TradeEvent[] = [
      { size: 20000, side: 'buy', price: 0.7, timestamp: MOCK_NOW - 30 * 60_000 },
    ];
    expect(detectWhaleFade(trades)).toBeNull();
  });

  it('uses the first (most recent) whale trade when multiple exist', () => {
    const trades: TradeEvent[] = [
      { size: 12000, side: 'sell', price: 0.5, timestamp: MOCK_NOW - 2 * 60_000 },
      { size: 25000, side: 'buy', price: 0.6, timestamp: MOCK_NOW - 15 * 60_000 },
    ];
    const result = detectWhaleFade(trades);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('buy');   // fade the first whale (sell → buy)
    expect(result!.size).toBe(12000);
    expect(result!.minutesAgo).toBe(2);
  });

  it('treats a $10,001 trade as a whale (threshold is >$10k)', () => {
    const trades: TradeEvent[] = [
      { size: 10001, side: 'buy', price: 0.55, timestamp: MOCK_NOW - 1000 },
    ];
    const result = detectWhaleFade(trades);
    expect(result).not.toBeNull();
  });

  it('treats a $10,000 trade as non-whale (must be strictly >$10k)', () => {
    const trades: TradeEvent[] = [
      { size: 10000, side: 'buy', price: 0.55, timestamp: MOCK_NOW - 1000 },
    ];
    expect(detectWhaleFade(trades)).toBeNull();
  });
});

describe('fetchRecentTrades', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns empty array on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const result = await fetchRecentTrades('market-1');
    expect(result).toEqual([]);
  });

  it('returns empty array on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));
    const result = await fetchRecentTrades('market-1');
    expect(result).toEqual([]);
  });

  it('parses array response and converts unix seconds timestamps to ms', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { size: '15000', side: 'BUY', price: '0.65', timestamp: '1700000000' },
        ],
      })
    );

    const trades = await fetchRecentTrades('market-1');
    expect(trades).toHaveLength(1);
    expect(trades[0].size).toBe(15000);
    expect(trades[0].side).toBe('buy');
    expect(trades[0].price).toBe(0.65);
    expect(trades[0].timestamp).toBe(1_700_000_000_000); // converted to ms
  });

  it('parses { data: [...] } wrapped response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { size: '8000', side: 'SELL', price: '0.4', timestamp: '1700000100' },
          ],
        }),
      })
    );

    const trades = await fetchRecentTrades('market-1');
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe('sell');
    expect(trades[0].size).toBe(8000);
  });

  it('preserves millisecond timestamps (>=1e12) without doubling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { size: '1000', side: 'BUY', price: '0.5', timestamp: '1700000000000' },
        ],
      })
    );

    const trades = await fetchRecentTrades('market-1');
    expect(trades[0].timestamp).toBe(1_700_000_000_000);
  });
});
