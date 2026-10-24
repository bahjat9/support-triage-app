// Server-only configuration. Every provider setting comes from environment
// variables (.env.local); nothing is hard-coded in the logic.
// The browser only ever sees a config *id* and a label, never a URL or a key.
import "server-only";

export type StructuredMode = "json_schema" | "prompt";

export type LlmConfig = {
  id: string; // e.g. "llm1"
  label: string; // shown in the model menu
  baseURL: string;
  apiKey: string;
  model: string;
  structuredMode: StructuredMode;
  priceInputPerM: number; // USD per 1M input tokens
  priceOutputPerM: number; // USD per 1M output tokens
};

export type DmApiFormat = "systemone" | "decisions";

export type DmConfig = {
  id: string;
  label: string;
  baseURL: string;
  apiKey: string;
  model: string;
  apiFormat: DmApiFormat;
  priceInputPerM: number;
  confidenceThreshold: number; // below this, dm+llm escalates to the LLM
  timeoutMs: number;
};

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : fallback;
}

/**
 * Up to three LLM configurations: LLM_*, LLM2_*, LLM3_*.
 * A configuration is enabled only if its base URL, key and model are all set.
 */
export function getLlmConfigs(): LlmConfig[] {
  const prefixes = ["LLM", "LLM2", "LLM3"];
  const configs: LlmConfig[] = [];
  prefixes.forEach((prefix, index) => {
    const baseURL = process.env[`${prefix}_BASE_URL`];
    const apiKey = process.env[`${prefix}_API_KEY`];
    const model = process.env[`${prefix}_MODEL`];
    if (!baseURL || !apiKey || !model) return;
    const mode = process.env[`${prefix}_STRUCTURED_OUTPUT`] ?? process.env.LLM_STRUCTURED_OUTPUT;
    configs.push({
      id: `llm${index + 1}`,
      label: process.env[`${prefix}_LABEL`] || model,
      baseURL,
      apiKey,
      model,
      structuredMode: mode === "prompt" ? "prompt" : "json_schema",
      priceInputPerM: num(process.env[`${prefix}_PRICE_INPUT_PER_M`], 0),
      priceOutputPerM: num(process.env[`${prefix}_PRICE_OUTPUT_PER_M`], 0),
    });
  });
  return configs;
}

export function getLlmConfig(id?: string): LlmConfig | undefined {
  const configs = getLlmConfigs();
  if (!id) return configs[0];
  return configs.find((c) => c.id === id);
}

export function getDmConfig(): DmConfig | undefined {
  const apiKey = process.env.DM_API_KEY;
  const model = process.env.DM_MODEL || "vllm-sr/d3-flash";
  if (!apiKey) return undefined;
  return {
    id: "dm1",
    label: process.env.DM_LABEL || model,
    baseURL: (process.env.DM_BASE_URL || "https://decision.vllm-sr.ai").replace(/\/+$/, ""),
    apiKey,
    model,
    apiFormat: process.env.DM_API_FORMAT === "decisions" ? "decisions" : "systemone",
    priceInputPerM: num(process.env.DM_PRICE_INPUT_PER_M, 0),
    confidenceThreshold: num(process.env.DM_CONFIDENCE_THRESHOLD, 0.6),
    timeoutMs: num(process.env.DM_TIMEOUT_MS, 15000),
  };
}

/** Maximum ticket length accepted by the API (the dataset has tickets > 5,000 chars). */
export const MAX_TICKET_CHARS = num(process.env.MAX_TICKET_CHARS, 5000);
export const MAX_CHAT_MESSAGE_CHARS = 4000;
export const MAX_CHAT_MESSAGES = 40;
export const LLM_TIMEOUT_MS = num(process.env.LLM_TIMEOUT_MS, 30000);
export const LLM_MAX_RETRIES = num(process.env.LLM_MAX_RETRIES, 1);
