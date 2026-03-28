import fs from "fs";
import path from "path";
import os from "os";

const LOG_DIR = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.join(os.homedir(), ".polymarket-arb");

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const logFile = path.join(LOG_DIR, "polymarket-arb.log");

export function log(level: "info" | "warn" | "error" | "trade", data: Record<string, unknown>): void {
  const entry = { timestamp: new Date().toISOString(), level, ...data };
  const line = JSON.stringify(entry);
  console.log(line);
  fs.appendFileSync(logFile, line + "\n");
}

export function logDir(): string {
  return LOG_DIR;
}
