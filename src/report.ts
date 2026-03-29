import fs from "fs";
import path from "path";
import os from "os";
import { log } from "./logger.js";

const REPORT_DIR = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.join(os.homedir(), ".polymarket-arb");

export type DailyReport = {
  date: string;
  signalsFired: number;
  newsBoostApplied: number;
  avgLatencyMs: number;
  paperPnl: number;
  signalBreakdown: {
    priceOnly: number;
    newsBoosted: number;
  };
};

export class ReportCollector {
  private signalsFired = 0;
  private newsBoostApplied = 0;
  private latencySamples: number[] = [];
  private paperPnl = 0;
  private reportTimer: NodeJS.Timeout | null = null;

  recordSignal(newsBoosted: boolean): void {
    this.signalsFired++;
    if (newsBoosted) this.newsBoostApplied++;
  }

  recordLatency(latencyMs: number): void {
    this.latencySamples.push(latencyMs);
  }

  recordPnl(pnl: number): void {
    this.paperPnl += pnl;
  }

  start(): void {
    // Write report every 24 hours
    this.reportTimer = setInterval(() => this.writeReport(), 24 * 60 * 60 * 1000);
  }

  stop(): void {
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
  }

  writeReport(): void {
    const date = new Date().toISOString().slice(0, 10);
    const avgLatencyMs =
      this.latencySamples.length > 0
        ? Math.round(
            this.latencySamples.reduce((a, b) => a + b, 0) /
              this.latencySamples.length
          )
        : 0;

    const report: DailyReport = {
      date,
      signalsFired: this.signalsFired,
      newsBoostApplied: this.newsBoostApplied,
      avgLatencyMs,
      paperPnl: parseFloat(this.paperPnl.toFixed(2)),
      signalBreakdown: {
        priceOnly: this.signalsFired - this.newsBoostApplied,
        newsBoosted: this.newsBoostApplied,
      },
    };

    const filePath = path.join(REPORT_DIR, `daily-report-${date}.json`);

    try {
      if (!fs.existsSync(REPORT_DIR)) {
        fs.mkdirSync(REPORT_DIR, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
      log("info", { event: "daily_report_written", path: filePath, ...report });
    } catch (err) {
      log("error", { event: "daily_report_write_error", error: String(err) });
    }

    // Reset counters for next day
    this.signalsFired = 0;
    this.newsBoostApplied = 0;
    this.latencySamples = [];
    this.paperPnl = 0;
  }
}
