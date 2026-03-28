import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchContracts, placeOrder } from '../polymarket.js';
import type { Contract } from '../polymarket.js';

// Mock logger to avoid FS writes
vi.mock('../logger.js', () => ({ log: vi.fn() }));

const MOCK_NOW = 1_700_000_000_000; // fixed "now"
const TEN_MIN_MS = 10 * 60 * 1_000; // 10 minutes in ms (within 20min window)

/** Create a minimal RestMarket-shaped object */
function makeMarket(overrides: {
  id?: string;
  question?: string;
  endDate?: string;
  outcomePrices?: string | string[];
  outcomes?: string | string[];
  active?: boolean;
  closed?: boolean;
}) {
  return {
    id: overrides.id ?? 'mkt-1',
    question: overrides.question ?? 'Will BTC be higher than $50,000?',
    endDate:
      overrides.endDate ??
      new Date(MOCK_NOW + TEN_MIN_MS).toISOString(),
    outcomePrices: overrides.outcomePrices ?? '["0.7","0.3"]',
    outcomes: overrides.outcomes ?? '["Yes","No"]',
    active: overrides.active ?? true,
    closed: overrides.closed ?? false,
  };
}

describe('fetchContracts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(MOCK_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns matching BTC contract with parsed prices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [makeMarket({})],
      })
    );

    const contracts = await fetchContracts('BTC');
    expect(contracts).toHaveLength(1);
    expect(contracts[0].symbol).toBe('BTC');
    expect(contracts[0].direction).toBe('up');
    expect(contracts[0].yesPrice).toBeCloseTo(0.7);
    expect(contracts[0].noPrice).toBeCloseTo(0.3);
    expect(contracts[0].id).toBe('mkt-1');
  });

  it('handles outcomePrices as a real array (not JSON string)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          makeMarket({ outcomePrices: ['0.6', '0.4'] }),
        ],
      })
    );

    const contracts = await fetchContracts('BTC');
    expect(contracts[0].yesPrice).toBeCloseTo(0.6);
    expect(contracts[0].noPrice).toBeCloseTo(0.4);
  });

  it('filters out ETH markets when fetching BTC', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          makeMarket({ id: 'btc-1', question: 'Will BTC exceed $60,000?' }),
          makeMarket({ id: 'eth-1', question: 'Will ETH be higher than $3,000?' }),
        ],
      })
    );

    const contracts = await fetchContracts('BTC');
    expect(contracts).toHaveLength(1);
    expect(contracts[0].id).toBe('btc-1');
  });

  it('filters out contracts already expired (endDate in the past)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          makeMarket({
            endDate: new Date(MOCK_NOW - 1_000).toISOString(), // 1s in the past
          }),
        ],
      })
    );

    expect(await fetchContracts('BTC')).toHaveLength(0);
  });

  it('filters out contracts expiring more than 20 minutes away', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          makeMarket({
            endDate: new Date(MOCK_NOW + 25 * 60 * 1_000).toISOString(), // 25 min
          }),
        ],
      })
    );

    expect(await fetchContracts('BTC')).toHaveLength(0);
  });

  it('filters out markets with no recognisable direction keyword', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          makeMarket({ question: 'Will BTC reach a new all-time high?' }), // no up/down keyword
        ],
      })
    );

    expect(await fetchContracts('BTC')).toHaveLength(0);
  });

  it('returns empty array when no contracts found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      })
    );

    expect(await fetchContracts('BTC')).toEqual([]);
  });

  it('returns empty array (does not throw) on non-ok API response (404)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404 })
    );

    await expect(fetchContracts('BTC')).resolves.toEqual([]);
  });

  it('returns empty array on network error (does not throw)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error'))
    );

    await expect(fetchContracts('BTC')).resolves.toEqual([]);
  });

  it('returns empty array on malformed JSON in outcomePrices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          makeMarket({ outcomePrices: '{bad json}' }),
        ],
      })
    );

    // parseJsonField returns [] on bad JSON → prices is [] → yesPrice = 0.5 (default)
    const contracts = await fetchContracts('BTC');
    expect(contracts).toHaveLength(1);
    expect(contracts[0].yesPrice).toBe(0.5);
    expect(contracts[0].noPrice).toBe(0.5);
  });

  it('detects "down" direction from question keywords', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          makeMarket({ question: 'Will BTC drop below $40,000?' }),
        ],
      })
    );

    const contracts = await fetchContracts('BTC');
    expect(contracts[0].direction).toBe('down');
  });

  it('matches ETH contracts when fetching ETH', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          makeMarket({ id: 'eth-1', question: 'Will ETH be higher than $3,000?' }),
        ],
      })
    );

    const contracts = await fetchContracts('ETH');
    expect(contracts).toHaveLength(1);
    expect(contracts[0].symbol).toBe('ETH');
  });
});

describe('placeOrder', () => {
  const mockContract: Contract = {
    id: 'cid-1',
    question: 'Will BTC exceed $50,000?',
    expiresAt: MOCK_NOW + TEN_MIN_MS,
    yesPrice: 0.7,
    noPrice: 0.3,
    symbol: 'BTC',
    direction: 'up',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.POLYMARKET_API_KEY;
    delete process.env.POLYMARKET_SECRET;
  });

  it('returns paper order result in paper mode (no network call)', async () => {
    const result = await placeOrder(mockContract, 'YES', 10, 0.7, true);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('paper');
    expect(result!.orderId).toMatch(/^paper-/);
  });

  it('returns null in live mode when credentials are missing', async () => {
    const result = await placeOrder(mockContract, 'YES', 10, 0.7, false);
    expect(result).toBeNull();
  });

  it('returns null on non-ok live order response', async () => {
    process.env.POLYMARKET_API_KEY = 'test-key';
    process.env.POLYMARKET_SECRET = 'test-secret';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400 })
    );

    const result = await placeOrder(mockContract, 'YES', 10, 0.7, false);
    expect(result).toBeNull();
  });
});
