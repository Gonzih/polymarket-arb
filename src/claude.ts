import { execFile } from "child_process";
import { promisify } from "util";
import type { MomentumSignal } from "./signal.js";
import type { Contract, WhaleFadeSignal } from "./polymarket.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

export type TradeAnalysis = {
  confidence: number;
  kelly_fraction: number;
  reasoning: string;
  enter: boolean;
};

export type ExtraContext = {
  whaleFade?: WhaleFadeSignal | null;
  simulationGap?: number | null;   // pp difference: positive = consensus > market odds
  highConfidenceEdge?: boolean;
};

export async function analyzeTradeOpportunity(
  signal: MomentumSignal,
  contract: Contract,
  extra?: ExtraContext
): Promise<TradeAnalysis | null> {
  const momentumPct = (signal.momentum * 100).toFixed(3);
  const direction = signal.direction === "down" ? "dropped" : "rose";
  const contractOdds = contract.yesPrice;
  const minutesToExpiry = Math.round((contract.expiresAt - Date.now()) / 60_000);

  const impliedProb = signal.direction === contract.direction ? 0.75 : 0.35;
  const impliedEdge = Math.abs(impliedProb - contractOdds);

  let extraContext = "";
  if (extra) {
    if (extra.whaleFade) {
      extraContext += `\nWhale fade signal: $${extra.whaleFade.size.toLocaleString()} trade detected ${extra.whaleFade.minutesAgo} min ago — fade direction is ${extra.whaleFade.direction}.`;
    }
    if (extra.simulationGap !== null && extra.simulationGap !== undefined) {
      const sign = extra.simulationGap > 0 ? "+" : "";
      extraContext += `\nMulti-agent simulation consensus gap: ${sign}${extra.simulationGap.toFixed(1)} percentage points vs current market odds.`;
    }
    if (extra.highConfidenceEdge !== undefined) {
      extraContext += `\nHigh-confidence edge: ${extra.highConfidenceEdge ? "YES — whale fade and simulation both agree on direction" : "NO"}.`;
    }
  }

  const prompt = `You are a prediction market arbitrage assistant. Analyze this trade opportunity and respond in JSON only.

Signal: ${signal.symbol} ${direction} ${momentumPct}% in 30 seconds on crypto exchange
Polymarket contract: "${contract.question}" currently priced at ${(contractOdds * 100).toFixed(1)}% (${contractOdds.toFixed(2)})
Implied edge: ${(impliedEdge * 100).toFixed(1)} percentage points (estimated real probability ~${(impliedProb * 100).toFixed(0)}%)
Minutes to expiry: ${minutesToExpiry}
Recent price ticks: [${signal.recentTicks.join(", ")}]
Current price: ${signal.currentPrice}${extraContext}

Assess: Does the momentum signal justify a bet on this contract? Consider momentum strength, edge size, time to expiry, and signal-contract alignment.

Respond with JSON only, no markdown:
{"confidence": 0.0-1.0, "kelly_fraction": 0.0-0.1, "reasoning": "brief explanation", "enter": true/false}`;

  try {
    const { stdout } = await execFileAsync(
      "claude",
      ["--print", "--model", "claude-haiku-4-5-20251001", prompt],
      {
        timeout: 15000,
        env: {
          ...process.env,
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
          ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
        },
      }
    );

    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log("warn", { source: "claude", event: "no_json_in_response", text: stdout });
      return null;
    }

    const analysis = JSON.parse(jsonMatch[0]) as TradeAnalysis;
    log("info", {
      source: "claude",
      event: "analysis",
      symbol: signal.symbol,
      contract: contract.question,
      ...analysis,
    });
    return analysis;
  } catch (err) {
    log("error", { source: "claude", event: "analysis_error", error: String(err) });
    return null;
  }
}
