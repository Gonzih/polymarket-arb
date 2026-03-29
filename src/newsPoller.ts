import { log } from "./logger.js";

export type NewsEvent = {
  headline: string;
  matchedKeywords: string[];
  timestamp: number;
  confidence: number;
};

const KEYWORDS = [
  "election",
  "crypto ban",
  "SEC",
  "CFTC",
  "hack",
  "exploit",
  "regulation",
  "ETF",
  "approval",
  "polymarket",
] as const;

// Higher-impact keywords get higher base confidence
const KEYWORD_WEIGHTS: Record<string, number> = {
  hack: 1.0,
  exploit: 1.0,
  "crypto ban": 0.95,
  SEC: 0.85,
  CFTC: 0.85,
  ETF: 0.85,
  approval: 0.80,
  election: 0.75,
  regulation: 0.75,
  polymarket: 0.70,
};

const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes
const NEWS_URL = "https://r.jina.ai/https://cryptopanic.com/news/bitcoin/";

export function parseHeadlines(html: string): string[] {
  const headlines: string[] = [];

  // Match common headline patterns: title tags, h1-h3, or anchor text in news listings
  const patterns = [
    /<title[^>]*>([^<]+)<\/title>/gi,
    /<h[1-3][^>]*>([^<]+)<\/h[1-3]>/gi,
    /<a[^>]+class="[^"]*title[^"]*"[^>]*>([^<]+)<\/a>/gi,
    /^#{1,3}\s+(.+)$/gm, // markdown headings (jina returns markdown)
    /\*\*(.+?)\*\*/g,    // bold text often used for headlines in markdown
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const text = match[1].trim();
      if (text.length > 10 && text.length < 300) {
        headlines.push(text);
      }
    }
  }

  // Deduplicate
  return [...new Set(headlines)];
}

export function matchKeywords(headline: string): string[] {
  const lower = headline.toLowerCase();
  return KEYWORDS.filter((kw) => lower.includes(kw.toLowerCase()));
}

export function computeConfidence(matchedKeywords: string[]): number {
  if (matchedKeywords.length === 0) return 0.6;

  const weights = matchedKeywords.map((kw) => KEYWORD_WEIGHTS[kw] ?? 0.6);
  const maxWeight = Math.max(...weights);

  // Boost slightly for multiple keyword matches
  const boost = Math.min(0.1, (matchedKeywords.length - 1) * 0.05);
  return Math.min(1.0, maxWeight + boost);
}

export function extractNewsEvents(html: string): NewsEvent[] {
  const headlines = parseHeadlines(html);
  const events: NewsEvent[] = [];

  for (const headline of headlines) {
    const matched = matchKeywords(headline);
    if (matched.length > 0) {
      events.push({
        headline,
        matchedKeywords: matched,
        timestamp: Date.now(),
        confidence: computeConfidence(matched),
      });
    }
  }

  return events;
}

export class NewsPoller {
  private recentEvents: NewsEvent[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private handlers: Array<(event: NewsEvent) => void> = [];

  onNews(handler: (event: NewsEvent) => void): void {
    this.handlers.push(handler);
  }

  getRecentEvents(windowMs = 120_000): NewsEvent[] {
    const cutoff = Date.now() - windowMs;
    return this.recentEvents.filter((e) => e.timestamp >= cutoff);
  }

  start(): void {
    // Poll immediately, then on interval
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const html = await fetch(NEWS_URL).then((r) => r.text());
      const events = extractNewsEvents(html);

      // Trim stale events (keep last 10 minutes)
      const cutoff = Date.now() - 10 * 60_000;
      this.recentEvents = this.recentEvents.filter((e) => e.timestamp >= cutoff);

      for (const event of events) {
        // Avoid duplicate headlines within the same poll window
        const isDuplicate = this.recentEvents.some(
          (e) => e.headline === event.headline
        );
        if (!isDuplicate) {
          this.recentEvents.push(event);
          log("info", {
            event: "news_event",
            headline: event.headline,
            matchedKeywords: event.matchedKeywords,
            confidence: event.confidence,
          });
          for (const handler of this.handlers) {
            handler(event);
          }
        }
      }
    } catch (err) {
      log("warn", { event: "news_poll_error", error: String(err) });
    }
  }
}
