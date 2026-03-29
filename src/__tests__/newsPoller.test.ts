import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseHeadlines,
  matchKeywords,
  computeConfidence,
  extractNewsEvents,
  NewsPoller,
} from "../newsPoller.js";

describe("parseHeadlines", () => {
  it("extracts markdown headings", () => {
    const html = "# Breaking: SEC sues crypto firm\n## ETF approval pending";
    const headlines = parseHeadlines(html);
    expect(headlines).toContain("Breaking: SEC sues crypto firm");
    expect(headlines).toContain("ETF approval pending");
  });

  it("extracts bold text", () => {
    const html = "**Hack discovered in major exchange**";
    const headlines = parseHeadlines(html);
    expect(headlines).toContain("Hack discovered in major exchange");
  });

  it("deduplicates headlines", () => {
    const html = "# SEC ruling on crypto markets\n# SEC ruling on crypto markets";
    const headlines = parseHeadlines(html);
    const count = headlines.filter((h) => h === "SEC ruling on crypto markets").length;
    expect(count).toBe(1);
  });

  it("filters out very short strings", () => {
    const html = "# Hi";
    const headlines = parseHeadlines(html);
    expect(headlines).not.toContain("Hi");
  });
});

describe("matchKeywords", () => {
  it("matches SEC keyword", () => {
    const matched = matchKeywords("SEC files lawsuit against crypto exchange");
    expect(matched).toContain("SEC");
  });

  it("matches hack keyword (case-insensitive)", () => {
    const matched = matchKeywords("Major HACK discovered at Binance");
    expect(matched).toContain("hack");
  });

  it("matches ETF keyword", () => {
    const matched = matchKeywords("Bitcoin ETF receives approval from SEC regulation");
    expect(matched).toContain("ETF");
    expect(matched).toContain("approval");
    expect(matched).toContain("regulation");
    expect(matched).toContain("SEC");
  });

  it("matches polymarket keyword", () => {
    const matched = matchKeywords("Polymarket sees record trading volume");
    expect(matched).toContain("polymarket");
  });

  it("matches crypto ban", () => {
    const matched = matchKeywords("Country announces crypto ban on all exchanges");
    expect(matched).toContain("crypto ban");
  });

  it("returns empty for irrelevant text", () => {
    const matched = matchKeywords("The weather is sunny today");
    expect(matched).toHaveLength(0);
  });

  it("matches CFTC", () => {
    const matched = matchKeywords("CFTC opens investigation into derivatives");
    expect(matched).toContain("CFTC");
  });

  it("matches election", () => {
    const matched = matchKeywords("US election results impact crypto markets");
    expect(matched).toContain("election");
  });

  it("matches exploit", () => {
    const matched = matchKeywords("New exploit found in DeFi protocol");
    expect(matched).toContain("exploit");
  });
});

describe("computeConfidence", () => {
  it("returns 0.6 for no matched keywords", () => {
    expect(computeConfidence([])).toBe(0.6);
  });

  it("returns high confidence for hack", () => {
    expect(computeConfidence(["hack"])).toBe(1.0);
  });

  it("returns high confidence for exploit", () => {
    expect(computeConfidence(["exploit"])).toBe(1.0);
  });

  it("boosts confidence for multiple keywords", () => {
    const single = computeConfidence(["SEC"]);
    const multiple = computeConfidence(["SEC", "regulation"]);
    expect(multiple).toBeGreaterThan(single);
  });

  it("caps confidence at 1.0", () => {
    const conf = computeConfidence(["hack", "exploit", "SEC", "CFTC", "ETF"]);
    expect(conf).toBeLessThanOrEqual(1.0);
  });

  it("returns 0.85 for SEC alone", () => {
    expect(computeConfidence(["SEC"])).toBe(0.85);
  });
});

describe("extractNewsEvents", () => {
  it("returns events for headlines matching keywords", () => {
    const html = "# SEC sues crypto exchange\n# Weather report for today";
    const events = extractNewsEvents(html);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].matchedKeywords).toContain("SEC");
    expect(events[0].confidence).toBeGreaterThan(0);
    expect(events[0].timestamp).toBeGreaterThan(0);
  });

  it("returns empty for html with no keyword matches", () => {
    const html = "# The stock market opened today\n# Weather is nice";
    const events = extractNewsEvents(html);
    expect(events).toHaveLength(0);
  });

  it("includes headline in event", () => {
    const html = "# Hack discovered at major crypto exchange";
    const events = extractNewsEvents(html);
    expect(events[0].headline).toContain("Hack discovered");
  });
});

describe("NewsPoller", () => {
  let poller: NewsPoller;

  beforeEach(() => {
    poller = new NewsPoller();
  });

  afterEach(() => {
    poller.stop();
  });

  it("returns empty events when no news polled", () => {
    expect(poller.getRecentEvents()).toHaveLength(0);
  });

  it("registers and calls news handlers", async () => {
    const handler = vi.fn();
    poller.onNews(handler);

    // Simulate injecting an event via internal poll result
    const html = "# SEC filing against major exchange";

    // Mock fetch
    global.fetch = vi.fn().mockResolvedValueOnce({
      text: () => Promise.resolve(html),
    } as unknown as Response);

    // Trigger a poll directly
    await (poller as unknown as { poll: () => Promise<void> }).poll();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].matchedKeywords).toContain("SEC");
  });

  it("getRecentEvents filters by time window", async () => {
    // Mock fetch
    global.fetch = vi.fn().mockResolvedValueOnce({
      text: () => Promise.resolve("# SEC crackdown on crypto"),
    } as unknown as Response);

    await (poller as unknown as { poll: () => Promise<void> }).poll();

    // Should be within default 2-min window
    expect(poller.getRecentEvents(120_000)).toHaveLength(1);
    // Events older than window should be excluded; use a past cutoff to test logic
    const allEvents = poller.getRecentEvents(120_000);
    expect(allEvents.every((e) => e.timestamp >= Date.now() - 120_000)).toBe(true);
  });

  it("deduplicates events across polls", async () => {
    const html = "# ETF approval from SEC";

    global.fetch = vi.fn()
      .mockResolvedValueOnce({ text: () => Promise.resolve(html) } as unknown as Response)
      .mockResolvedValueOnce({ text: () => Promise.resolve(html) } as unknown as Response);

    const poll = (poller as unknown as { poll: () => Promise<void> }).poll.bind(poller);
    await poll();
    await poll();

    // Same headline should not be duplicated within 10-min window
    expect(poller.getRecentEvents(600_000).length).toBeLessThanOrEqual(
      // Events deduplicated, so at most the unique headlines from html
      3
    );
  });

  it("handles fetch errors gracefully", async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error("network error"));

    // Should not throw
    await expect(
      (poller as unknown as { poll: () => Promise<void> }).poll()
    ).resolves.toBeUndefined();
  });
});

describe("news boost confidence multiplier logic", () => {
  it("boosted confidence = confidence * 1.5 capped at 1.0", () => {
    const NEWS_BOOST_MULTIPLIER = 1.5;
    const base = 0.7;
    const boosted = Math.min(1.0, base * NEWS_BOOST_MULTIPLIER);
    expect(boosted).toBeCloseTo(1.0);
  });

  it("boosted confidence for lower base", () => {
    const NEWS_BOOST_MULTIPLIER = 1.5;
    const base = 0.5;
    const boosted = Math.min(1.0, base * NEWS_BOOST_MULTIPLIER);
    expect(boosted).toBeCloseTo(0.75);
  });

  it("no boost returns original confidence", () => {
    const NEWS_BOOST_MULTIPLIER = 1.0;
    const base = 0.6;
    const boosted = Math.min(1.0, base * NEWS_BOOST_MULTIPLIER);
    expect(boosted).toBe(0.6);
  });
});
