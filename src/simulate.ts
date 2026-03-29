import { spawn } from "child_process";
import { log } from "./logger.js";
import type { WhaleFadeSignal } from "./polymarket.js";

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

const PERSONAS = [
  { name: "skeptic", prior: "You are deeply skeptical. Challenge assumptions, look for what could go wrong." },
  { name: "optimist", prior: "You are optimistic about outcomes. Look for reasons things will succeed." },
  { name: "regulator", prior: "You think like a financial regulator. Focus on compliance, risk, systemic issues." },
  { name: "trader", prior: "You are a quantitative trader. Focus on base rates, historical precedent, market signals." },
  { name: "journalist", prior: "You are an investigative journalist. Look for narrative, public perception, media dynamics." },
];

export type PersonaResult = {
  name: string;
  estimate: number;  // 0-1
  reasoning: string;
};

export type SimulationResult = {
  consensus: number;  // median of estimates, 0-1
  spread: number;     // max - min of estimates
  personas: PersonaResult[];
};

async function runPersona(
  persona: { name: string; prior: string },
  question: string,
  currentOdds: number
): Promise<PersonaResult | null> {
  const prompt = `${persona.prior}

Prediction market question: "${question}"
Current market price: ${(currentOdds * 100).toFixed(1)}% YES

What is your probability estimate (0-100) for YES? Keep it brief.
Respond with JSON only, no markdown:
{"probability": <0-100>, "reasoning": "<one sentence>"}`;

  try {
    const stdout = await askClaude(prompt, "claude-haiku-4-5-20251001", 15000);

    const jsonMatch = stdout.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { probability: number; reasoning: string };
    return {
      name: persona.name,
      estimate: Math.max(0, Math.min(100, Number(parsed.probability))) / 100,
      reasoning: String(parsed.reasoning),
    };
  } catch {
    return null;
  }
}

export function median(values: number[]): number {
  if (values.length === 0) return 0.5;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export async function simulateMarket(
  question: string,
  currentOdds: number
): Promise<SimulationResult> {
  const results = await Promise.all(
    PERSONAS.map((p) => runPersona(p, question, currentOdds))
  );

  const personas = results.filter((r): r is PersonaResult => r !== null);
  const estimates = personas.map((p) => p.estimate);
  const consensus = median(estimates);
  const spread =
    estimates.length > 1
      ? Math.max(...estimates) - Math.min(...estimates)
      : 0;

  log("info", {
    source: "simulate",
    event: "simulation_complete",
    question,
    currentOdds,
    consensus,
    spread,
    personaCount: personas.length,
  });

  const gapPp = Math.abs((consensus - currentOdds) * 100);
  if (gapPp > 8) {
    log("info", {
      source: "simulate",
      event: "simulation_edge",
      question,
      currentOdds,
      consensus,
      gapPercentagePoints: parseFloat(gapPp.toFixed(1)),
      direction: consensus > currentOdds ? "buy" : "sell",
    });
  }

  return { consensus, spread, personas };
}

/**
 * Returns true when both whale fade signal and simulation edge agree on the
 * same direction (high-conviction combined signal).
 */
export function computeHighConfidenceEdge(
  whaleFade: WhaleFadeSignal | null,
  simulationConsensus: number | null,
  currentOdds: number
): boolean {
  if (!whaleFade || simulationConsensus === null) return false;

  const gapPp = Math.abs((simulationConsensus - currentOdds) * 100);
  if (gapPp <= 8) return false;

  const simDirection = simulationConsensus > currentOdds ? "buy" : "sell";
  return whaleFade.direction === simDirection;
}
