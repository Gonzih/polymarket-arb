import { spawn } from "child_process";
import type { MomentumSignal } from "./signal.js";
import type { Contract, WhaleFadeSignal } from "./polymarket.js";
import type { SimulationResult } from "./simulationSignal.js";
import { log } from "./logger.js";

function askClaude(prompt: string, model: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["--print", "--model", model], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    const t = setTimeout(() => { proc.kill(); reject(new Error("claude timeout")); }, timeoutMs);
    proc.on("exit", () => clearTimeout(t));
  });
}

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
  simulation?: SimulationResult;
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
    if (extra.simulation) {
      const sim = extra.simulation;
      const edgeSign = sim.edge > 0 ? "+" : "";
      extraContext += `\n4-agent debate signal: ${sim.signal} | Synthetic P(YES)=${(sim.syntheticProb * 100).toFixed(1)}% | Edge=${edgeSign}${(sim.edge * 100).toFixed(1)}pp | Spread=${(sim.spread * 100).toFixed(1)}pp`;
      const breakdown = sim.agents.map((a) => `${a.agent}=${(a.prob * 100).toFixed(0)}%`).join(", ");
      extraContext += `\n  Agent breakdown: ${breakdown}`;
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
    const stdout = await askClaude(prompt, "claude-haiku-4-5-20251001", 15000);

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
