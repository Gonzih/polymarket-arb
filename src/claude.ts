import Anthropic from "@anthropic-ai/sdk";
import type { MomentumSignal } from "./signal.js";
import type { Contract } from "./polymarket.js";
import { log } from "./logger.js";

const MODEL = "claude-haiku-4-5-20251001";

export type TradeAnalysis = {
  confidence: number;
  kelly_fraction: number;
  reasoning: string;
  enter: boolean;
};

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
    client = new Anthropic({ apiKey });
  }
  return client;
}

export async function analyzeTradeOpportunity(
  signal: MomentumSignal,
  contract: Contract
): Promise<TradeAnalysis | null> {
  const momentumPct = (signal.momentum * 100).toFixed(3);
  const direction = signal.direction === "down" ? "dropped" : "rose";
  const contractOdds = contract.direction === "down" ? contract.yesPrice : contract.yesPrice;
  const minutesToExpiry = Math.round((contract.expiresAt - Date.now()) / 60_000);

  // Implied real probability based on momentum direction matching contract
  const impliedProb = signal.direction === contract.direction ? 0.75 : 0.35;
  const impliedEdge = Math.abs(impliedProb - contractOdds);

  const prompt = `You are a prediction market arbitrage assistant. Analyze this trade opportunity and respond in JSON only.

Signal: ${signal.symbol} ${direction} ${momentumPct}% in 30 seconds on crypto exchange
Polymarket contract: "${contract.question}" currently priced at ${(contractOdds * 100).toFixed(1)}% (${contractOdds.toFixed(2)})
Implied edge: ${(impliedEdge * 100).toFixed(1)} percentage points (estimated real probability ~${(impliedProb * 100).toFixed(0)}%)
Minutes to expiry: ${minutesToExpiry}
Recent price ticks: [${signal.recentTicks.join(", ")}]
Current price: ${signal.currentPrice}

Assess: Does the momentum signal justify a bet on this contract? Consider momentum strength, edge size, time to expiry, and signal-contract alignment.

Respond with JSON only:
{"confidence": 0.0-1.0, "kelly_fraction": 0.0-0.1, "reasoning": "brief explanation", "enter": true/false}`;

  try {
    const anthropic = getClient();
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });

    const content = message.content[0];
    if (content.type !== "text") {
      log("warn", { source: "claude", event: "unexpected_response_type" });
      return null;
    }

    // Extract JSON from response (may have surrounding text)
    const jsonMatch = content.text.match(/\{[^}]+\}/s);
    if (!jsonMatch) {
      log("warn", { source: "claude", event: "no_json_in_response", text: content.text });
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
