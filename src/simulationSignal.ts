// 4-agent async debate engine
// Triggers: scheduled (4-6h) + whale trade + odds delta (7%)
// Output: { signal: 'DIRECTIONAL'|'VOLATILITY'|'PASS', edge, spread, syntheticProb, agents }

import { runClaude } from "./claude.js";
import { log } from "./logger.js";

export type SimulationSignal = 'DIRECTIONAL' | 'VOLATILITY' | 'PASS';

export interface AgentEstimate {
  agent: string;
  prob: number;
  reasoning: string;
}

export interface SimulationResult {
  signal: SimulationSignal;
  edge: number;
  spread: number;
  syntheticProb: number;
  marketOdds: number;
  agents: AgentEstimate[];
  timestamp: number;
}

export interface SimulationTrigger {
  type: 'scheduled' | 'whale' | 'odds_delta';
  marketId: string;
  marketQuestion: string;
  marketOdds: number;  // 0-1
  volume: number;
  hoursToResolution: number;
}

const AGENTS = [
  {
    name: 'Bull',
    system: `You are an institutional investor and prediction market bull. You look for institutional flow, narrative momentum, structural tailwinds, convexity. You find reasons YES is underpriced. Output: P(YES)=0.XX | Bull: [2 sentences]`,
  },
  {
    name: 'Bear',
    system: `You are a contrarian focused on retail participation decay. You track volume trends, whale vs retail mix, thin liquidity masking, post-hype base rates. You find reasons YES is overpriced. Output: P(YES)=0.XX | Bear: [2 sentences]`,
  },
  {
    name: 'Regulator',
    system: `You analyze from institutional power structure lens. What do regulatory bodies want? Who benefits from YES vs NO? You weight regulatory incentives heavily. Output: P(YES)=0.XX | Regulator: [2 sentences]`,
  },
  {
    name: 'Contrarian',
    system: `You are a professional contrarian. Markets overshoot on news, undershoot on slow change. You fade current consensus. Above 75%? Find the break narrative. Below 25%? Find the flip catalyst. Output: P(YES)=0.XX | Contrarian: [2 sentences]`,
  },
];

function parseAgentResponse(agentName: string, text: string): AgentEstimate {
  const match = text.match(/P\(YES\)=(\d+\.?\d*)/i);
  const prob = match ? Math.max(0, Math.min(1, parseFloat(match[1]))) : 0.5;

  // Extract reasoning: everything after the pipe separator
  const pipeIdx = text.indexOf('|');
  const reasoning = pipeIdx >= 0 ? text.slice(pipeIdx + 1).trim() : text.trim();

  return { agent: agentName, prob, reasoning };
}

async function runAgent(
  agent: { name: string; system: string },
  question: string,
  marketOdds: number
): Promise<AgentEstimate> {
  const prompt = `${agent.system}

Prediction market question: "${question}"
Current market price: ${(marketOdds * 100).toFixed(1)}% YES

Provide your probability estimate and reasoning.`;

  try {
    const stdout = await runClaude(prompt, "claude-haiku-4-5-20251001", 15000);
    return parseAgentResponse(agent.name, stdout);
  } catch {
    return { agent: agent.name, prob: 0.5, reasoning: 'Agent failed — using fallback probability.' };
  }
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0.5;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function classifySignal(edge: number, spread: number): SimulationSignal {
  if (spread > 0.30) return 'VOLATILITY';
  if (Math.abs(edge) > 0.10 && spread < 0.20) return 'DIRECTIONAL';
  return 'PASS';
}

/**
 * Runs the 4-agent debate and returns a SimulationResult.
 */
export async function runSimulation(trigger: SimulationTrigger): Promise<SimulationResult> {
  const agents = await Promise.all(
    AGENTS.map((a) => runAgent(a, trigger.marketQuestion, trigger.marketOdds))
  );

  const probs = agents.map((a) => a.prob);
  const syntheticProb = computeMedian(probs);
  const spread = Math.max(...probs) - Math.min(...probs);
  const edge = syntheticProb - trigger.marketOdds;
  const signal = classifySignal(edge, spread);

  const result: SimulationResult = {
    signal,
    edge,
    spread,
    syntheticProb,
    marketOdds: trigger.marketOdds,
    agents,
    timestamp: Date.now(),
  };

  log("info", {
    source: "simulationSignal",
    event: "simulation_complete",
    triggerType: trigger.type,
    marketId: trigger.marketId,
    question: trigger.marketQuestion,
    signal,
    edge: parseFloat((edge * 100).toFixed(2)),
    spread: parseFloat((spread * 100).toFixed(2)),
    syntheticProb: parseFloat(syntheticProb.toFixed(4)),
    marketOdds: trigger.marketOdds,
  });

  return result;
}

/**
 * Checks whether a market qualifies to run simulation.
 * Requires volume > 250k and hoursToResolution > 24.
 */
export function shouldRunSimulation(volume: number, hoursToResolution: number): boolean {
  return volume > 250_000 && hoursToResolution > 24;
}

/**
 * Adjusts Kelly fraction based on simulation result.
 * Returns multiplier: 1.0 (DIRECTIONAL low-spread), 0.5 (high spread), 0.0 (VOLATILITY).
 */
export function kellyAdjustment(result: SimulationResult): number {
  if (result.signal === 'VOLATILITY') return 0.0;
  if (result.spread >= 0.20) return 0.5;
  return 1.0;
}

/**
 * Logs simulation result to the log system.
 */
export function logSimulationResult(result: SimulationResult, marketQuestion: string): void {
  log("info", {
    source: "simulationSignal",
    event: "simulation_result",
    marketQuestion,
    signal: result.signal,
    edge: parseFloat((result.edge * 100).toFixed(2)),
    spread: parseFloat((result.spread * 100).toFixed(2)),
    syntheticProb: parseFloat(result.syntheticProb.toFixed(4)),
    marketOdds: result.marketOdds,
    agents: result.agents.map((a) => ({
      agent: a.agent,
      prob: parseFloat(a.prob.toFixed(4)),
      reasoning: a.reasoning,
    })),
    timestamp: result.timestamp,
  });
}
