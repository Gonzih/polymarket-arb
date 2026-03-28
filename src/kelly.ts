import { log } from "./logger.js";

const MAX_KELLY = 0.10;       // cap at 10%
const MAX_POSITION = 0.08;    // 8% of portfolio
const DAILY_LOSS_LIMIT = -0.20; // -20%
const TOTAL_DRAWDOWN_LIMIT = -0.40; // -40%

export class RiskManager {
  private portfolio: number;
  private startOfDayPortfolio: number;
  private peakPortfolio: number;
  private halted = false;

  constructor(initialBalance: number) {
    this.portfolio = initialBalance;
    this.startOfDayPortfolio = initialBalance;
    this.peakPortfolio = initialBalance;
  }

  isHalted(): boolean {
    return this.halted;
  }

  getPortfolio(): number {
    return this.portfolio;
  }

  checkLimits(): { ok: boolean; reason?: string } {
    const dailyReturn = (this.portfolio - this.startOfDayPortfolio) / this.startOfDayPortfolio;
    const drawdown = (this.portfolio - this.peakPortfolio) / this.peakPortfolio;

    if (dailyReturn <= DAILY_LOSS_LIMIT) {
      this.halted = true;
      return { ok: false, reason: `Daily loss limit hit: ${(dailyReturn * 100).toFixed(1)}%` };
    }

    if (drawdown <= TOTAL_DRAWDOWN_LIMIT) {
      this.halted = true;
      return { ok: false, reason: `Total drawdown kill switch: ${(drawdown * 100).toFixed(1)}%` };
    }

    return { ok: true };
  }

  sizePosition(kellyFraction: number, price: number): number {
    const cappedKelly = Math.min(kellyFraction, MAX_KELLY);
    const maxByPortfolio = this.portfolio * MAX_POSITION;
    const kellySize = this.portfolio * cappedKelly;
    const size = Math.min(kellySize, maxByPortfolio);

    // Convert dollars to number of contracts (each contract is $1 face value at price)
    const contracts = price > 0 ? size / price : 0;
    return Math.floor(contracts * 100) / 100; // round to 2 decimal places
  }

  recordTrade(pnl: number): void {
    this.portfolio += pnl;
    if (this.portfolio > this.peakPortfolio) {
      this.peakPortfolio = this.portfolio;
    }
    log("info", {
      event: "portfolio_update",
      portfolio: this.portfolio,
      pnl,
      peakPortfolio: this.peakPortfolio,
    });
  }

  resetDay(): void {
    this.startOfDayPortfolio = this.portfolio;
    log("info", { event: "day_reset", portfolio: this.portfolio });
  }
}
