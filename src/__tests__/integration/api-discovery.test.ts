/**
 * @integration
 *
 * Live canary test — hits gamma-api.polymarket.com for real.
 * Run with: npm run test:integration
 *
 * If this test fails the API schema has changed and fetchContracts() needs updating.
 */
import { describe, it, expect } from 'vitest';

const GAMMA_API = 'https://gamma-api.polymarket.com';

describe('gamma-api schema (@integration canary)', () => {
  it('GET /markets?limit=5 returns 200 and expected field shapes', async () => {
    const res = await fetch(`${GAMMA_API}/markets?limit=5`);

    expect(res.status, `Expected 200 but got ${res.status} — API may be down or URL changed`).toBe(200);

    const markets = await res.json();
    expect(Array.isArray(markets), 'Response should be an array').toBe(true);

    if (markets.length === 0) {
      // No markets returned — schema can't be validated but API is alive
      return;
    }

    const m = markets[0];

    // Fields required by fetchContracts()
    expect(m, 'Market missing "id"').toHaveProperty('id');
    expect(m, 'Market missing "question"').toHaveProperty('question');
    expect(m, 'Market missing "endDate"').toHaveProperty('endDate');
    expect(m, 'Market missing "active"').toHaveProperty('active');
    expect(m, 'Market missing "closed"').toHaveProperty('closed');
    expect(m, 'Market missing "outcomePrices"').toHaveProperty('outcomePrices');
    expect(m, 'Market missing "outcomes"').toHaveProperty('outcomes');

    // endDate must be parseable as a date
    const endMs = new Date(m.endDate).getTime();
    expect(Number.isFinite(endMs), `endDate "${m.endDate}" is not a parseable date`).toBe(true);

    // outcomePrices should be either a JSON-encoded string array or a real array
    const prices =
      typeof m.outcomePrices === 'string'
        ? JSON.parse(m.outcomePrices)
        : m.outcomePrices;
    expect(Array.isArray(prices), 'outcomePrices should be an array (or JSON string of array)').toBe(true);

    // Each price element should be numeric (as string or number)
    for (const p of prices) {
      const n = Number(p);
      expect(Number.isFinite(n), `outcomePrices element "${p}" is not numeric`).toBe(true);
    }
  });

  it('active=true&closed=false filter is honoured by the API', async () => {
    const res = await fetch(`${GAMMA_API}/markets?active=true&closed=false&limit=10`);
    expect(res.status).toBe(200);

    const markets = await res.json();
    expect(Array.isArray(markets)).toBe(true);

    for (const m of markets) {
      // If the API honours the filter, every returned market should be active
      if ('active' in m) {
        expect(m.active, `Market ${m.id} has active=false but was returned by active=true filter`).toBe(true);
      }
    }
  });
});
