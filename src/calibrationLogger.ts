import fs from "fs";
import path from "path";
import { logDir } from "./logger.js";

export interface CalibrationEvent {
  ts: number;
  signalType: "momentum" | "whale_fade" | "news_boost" | "debate";
  marketId: string;
  question: string;
  syntheticProb: number;      // from simulation
  marketOddsT0: number;       // at signal time
  newsBoosted: boolean;
  agentBreakdown?: Record<string, number>;  // agent name → prob
}

export interface CalibrationOutcome extends CalibrationEvent {
  oddsT5?: number;
  oddsT15?: number;
  oddsT30?: number;
  oddsT60?: number;
  resolved?: boolean;
  resolution?: "YES" | "NO";
}

const CHECKPOINTS_MIN = [5, 15, 30, 60] as const;
type CheckpointMin = typeof CHECKPOINTS_MIN[number];

const MAX_AGE_MS = 90 * 60 * 1000;      // 90 minutes
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchMarketYesPrice(marketId: string): Promise<number | null> {
  try {
    const url = `https://clob.polymarket.com/markets/${encodeURIComponent(marketId)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as { tokens?: Array<{ outcome: string; price: number }> };
    const yes = data.tokens?.find((t) => t.outcome === "Yes");
    return yes != null ? Number(yes.price) : null;
  } catch {
    return null;
  }
}

export class CalibrationLogger {
  private pendingEvents = new Map<string, CalibrationOutcome>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private calibrationFile: string;

  constructor(dir?: string) {
    this.calibrationFile = path.join(dir ?? logDir(), "calibration.jsonl");
  }

  logEvent(event: CalibrationEvent): void {
    const record = { type: "event" as const, ...event };
    this.append(record);
    const key = `${event.marketId}:${event.ts}`;
    this.pendingEvents.set(key, { ...event });
  }

  async poll(): Promise<void> {
    const now = Date.now();
    for (const [key, event] of this.pendingEvents.entries()) {
      const ageMs = now - event.ts;
      // Prune events that are too old to have any remaining checkpoints
      if (ageMs > MAX_AGE_MS + POLL_INTERVAL_MS) {
        this.pendingEvents.delete(key);
        continue;
      }
      let updated = false;
      for (const minOffset of CHECKPOINTS_MIN) {
        const field = `oddsT${minOffset}` as `oddsT${CheckpointMin}`;
        if ((event as Record<string, unknown>)[field] !== undefined) continue;
        if (now < event.ts + minOffset * 60 * 1000) continue;
        const odds = await fetchMarketYesPrice(event.marketId);
        if (odds !== null) {
          (event as Record<string, unknown>)[field] = odds;
          updated = true;
        }
      }
      if (updated) {
        this.append({ type: "outcome" as const, ...event });
      }
      // Remove when all checkpoints are filled
      if (CHECKPOINTS_MIN.every((m) => (event as Record<string, unknown>)[`oddsT${m}`] !== undefined)) {
        this.pendingEvents.delete(key);
      }
    }
  }

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => { this.poll().catch(() => {}); }, POLL_INTERVAL_MS);
    // Allow process to exit naturally without waiting for the timer
    if (typeof this.pollTimer.unref === "function") this.pollTimer.unref();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  get pendingCount(): number {
    return this.pendingEvents.size;
  }

  private append(record: unknown): void {
    fs.appendFileSync(this.calibrationFile, JSON.stringify(record) + "\n");
  }
}

export const calibrationLogger = new CalibrationLogger();
