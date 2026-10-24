// One JSON line per model call in logs/llm-calls.jsonl, one line per smoke
// run in logs/smoke-runs.jsonl. Never log the key, never log the ticket text.
import "server-only";
import { promises as fs } from "fs";
import path from "path";

export const LOG_DIR = path.join(process.cwd(), "logs");
export const RUNS_DIR = path.join(process.cwd(), "runs");
export const CALLS_LOG = path.join(LOG_DIR, "llm-calls.jsonl");
export const RUNS_LOG = path.join(LOG_DIR, "smoke-runs.jsonl");

export type CallLogLine = {
  ts: string;
  route: "chat" | "triage" | "explain";
  api: "chat_completions" | "systemone" | "decisions";
  kind: "llm" | "dm";
  strategy?: string;
  prompt_version: string;
  config_id: string;
  model: string;
  status: number; // HTTP status we returned for this call
  error_code?: string;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number;
  run_id?: string; // set when the call belongs to a smoke run
};

async function append(file: string, line: unknown): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(line) + "\n", "utf8");
  } catch (error) {
    // Logging must never break the feature.
    console.error("log write failed", error);
  }
}

export function logCall(line: CallLogLine): Promise<void> {
  return append(CALLS_LOG, line);
}

export function logRun(summary: unknown): Promise<void> {
  return append(RUNS_LOG, summary);
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const text = await fs.readFile(file, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as T];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
