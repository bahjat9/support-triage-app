// The only module that talks to the decision model (DM).
// Default provider: vLLM Semantic Router "Decision 3.0" free hosted API,
// POST https://decision.vllm-sr.ai/v1/systemone (System One / Jev format).
// The OpenAI-style /v1/decisions contract is also supported (DM_API_FORMAT=decisions).
// The chat SDK does not apply here: this is a plain HTTPS + JSON call.
import "server-only";
import { z } from "zod";
import { getDmConfig, type DmConfig } from "./config";
import { AppError, LlmInvalidOutputError, toAppError } from "./errors";
import { logCall } from "./log";
import { CATEGORY_GUIDANCE, DM_INSTRUCTIONS, PRIORITY_GUIDANCE } from "./prompt";
import { CATEGORIES, PRIORITIES, type CallInfo, type Category, type Priority, type Usage } from "./schema";
import type { CallContext } from "./llm";

export type DmDecision = {
  category: Category;
  category_confidence: number;
  category_probabilities: Record<string, number>;
  priority: Priority;
  priority_confidence: number;
  priority_probabilities: Record<string, number>;
  needs_human_review_probability: number | null;
  call: CallInfo;
};

// ---------- System One format (vLLM SR, TypeSafe Jev, OpenRouter /api/v1/systemone) ----------

function systemOneRequest(model: string, ticket: string) {
  return {
    model,
    state: ticket,
    questions: {
      category: { type: "choice", instructions: DM_INSTRUCTIONS.category, criteria: CATEGORY_GUIDANCE },
      priority: { type: "choice", instructions: DM_INSTRUCTIONS.priority, criteria: PRIORITY_GUIDANCE },
      needs_human_review: { type: "noul", instructions: DM_INSTRUCTIONS.needs_human_review },
    },
  };
}

const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  probabilities: z.record(z.string(), z.number()),
});

const SystemOneResponse = z.object({
  model: z.string().optional(),
  answers: z.object({
    category: ChoiceAnswer,
    priority: ChoiceAnswer,
    needs_human_review: z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }).optional(),
  }),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number().optional() }).optional(),
});

// ---------- OpenAI Decisions format (/v1/decisions) ----------

function decisionsRequest(model: string, ticket: string) {
  const toChoices = (g: Record<string, string>) => Object.entries(g).map(([value, description]) => ({ value, description }));
  return {
    model,
    input: ticket,
    questions: [
      { type: "choice", name: "category", instructions: DM_INSTRUCTIONS.category, choices: toChoices(CATEGORY_GUIDANCE) },
      { type: "choice", name: "priority", instructions: DM_INSTRUCTIONS.priority, choices: toChoices(PRIORITY_GUIDANCE) },
      { type: "predicate", name: "needs_human_review", instructions: DM_INSTRUCTIONS.needs_human_review },
    ],
  };
}

const DecisionsResponse = z.object({
  answers: z.array(
    z.object({
      type: z.string(),
      name: z.string(),
      choice: z.union([z.string(), z.boolean()]).optional(),
      probabilities: z.record(z.string(), z.number()).optional(),
      confidence: z.number().optional(),
      probability: z.number().optional(),
    }),
  ),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number().optional() }).optional(),
});

type Normalised = {
  category: { choice: string; confidence?: number; probabilities: Record<string, number> };
  priority: { choice: string; confidence?: number; probabilities: Record<string, number> };
  review: number | null;
  usage: Usage | null;
};

function normalise(format: DmConfig["apiFormat"], raw: unknown): Normalised {
  if (format === "systemone") {
    const parsed = SystemOneResponse.safeParse(raw);
    if (!parsed.success) throw new LlmInvalidOutputError("DM schema mismatch: " + parsed.error.message);
    const a = parsed.data.answers;
    const u = parsed.data.usage;
    return {
      category: a.category,
      priority: a.priority,
      review: a.needs_human_review?.noul ?? null,
      usage: u ? { input_tokens: u.input_tokens, output_tokens: u.output_tokens ?? 0, total_tokens: u.input_tokens + (u.output_tokens ?? 0) } : null,
    };
  }
  const parsed = DecisionsResponse.safeParse(raw);
  if (!parsed.success) throw new LlmInvalidOutputError("DM schema mismatch: " + parsed.error.message);
  const byName = new Map(parsed.data.answers.map((x) => [x.name, x]));
  const pick = (name: string) => {
    const x = byName.get(name);
    if (!x || x.type === "refusal" || x.choice === undefined) throw new LlmInvalidOutputError(`DM refused or missed ${name}`);
    return { choice: String(x.choice), confidence: x.confidence, probabilities: x.probabilities ?? {} };
  };
  const u = parsed.data.usage;
  return {
    category: pick("category"),
    priority: pick("priority"),
    review: byName.get("needs_human_review")?.probability ?? null,
    usage: u ? { input_tokens: u.input_tokens, output_tokens: u.output_tokens ?? 0, total_tokens: u.input_tokens + (u.output_tokens ?? 0) } : null,
  };
}

/** Our code validates what comes back: the DM can only answer inside the options we gave. */
function checkLabel<T extends string>(value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) throw new LlmInvalidOutputError(`DM returned unknown label ${value}`);
  return value as T;
}

function confidenceOf(a: { choice: string; confidence?: number; probabilities: Record<string, number> }): number {
  const c = a.confidence ?? a.probabilities[a.choice] ?? Math.max(0, ...Object.values(a.probabilities));
  return Math.min(1, Math.max(0, c));
}

export function resolveDmConfig(): DmConfig {
  const config = getDmConfig();
  if (!config) throw new AppError("not_configured", "No decision model is configured on the server (DM_API_KEY).");
  return config;
}

async function postOnce(config: DmConfig, body: unknown): Promise<unknown> {
  const path = config.apiFormat === "systemone" ? "/v1/systemone" : "/v1/decisions";
  const response = await fetch(config.baseURL + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const err = new Error(`DM HTTP ${response.status}: ${detail.slice(0, 300)}`) as Error & {
      status: number;
      retryAfter?: number;
    };
    err.status = response.status;
    const ra = Number(response.headers.get("retry-after"));
    if (Number.isFinite(ra)) err.retryAfter = ra;
    throw err;
  }
  try {
    return await response.json();
  } catch {
    throw new LlmInvalidOutputError("DM answer is not JSON");
  }
}

export async function decide(ticket: string, ctx: CallContext): Promise<DmDecision> {
  const config = resolveDmConfig();
  const body = config.apiFormat === "systemone" ? systemOneRequest(config.model, ticket) : decisionsRequest(config.model, ticket);
  const started = Date.now();
  const api = config.apiFormat;
  try {
    let raw: unknown;
    try {
      raw = await postOnce(config, body);
    } catch (error) {
      // One bounded retry for 429 / 5xx / network, honouring a short Retry-After.
      const e = error as { status?: number; retryAfter?: number; name?: string };
      const retryable = e.status === 429 || (e.status !== undefined && e.status >= 500) || e.name === "TypeError";
      if (!retryable) throw error;
      const waitMs = Math.min((e.retryAfter ?? 1) * 1000, 3000);
      await new Promise((r) => setTimeout(r, waitMs));
      raw = await postOnce(config, body);
    }
    const n = normalise(config.apiFormat, raw);
    const latency = Date.now() - started;
    const cost = n.usage ? (n.usage.input_tokens * config.priceInputPerM) / 1_000_000 : 0;
    const call: CallInfo = { kind: "dm", model: config.model, usage: n.usage, latency_ms: latency, cost_usd: cost };
    await logCall({
      ts: new Date().toISOString(),
      route: ctx.route,
      api,
      kind: "dm",
      strategy: ctx.strategy,
      prompt_version: ctx.prompt_version,
      config_id: config.id,
      model: config.model,
      status: 200,
      latency_ms: latency,
      input_tokens: n.usage?.input_tokens ?? null,
      output_tokens: n.usage?.output_tokens ?? null,
      cost_usd: cost,
      run_id: ctx.run_id,
    });
    return {
      category: checkLabel(n.category.choice, CATEGORIES),
      category_confidence: confidenceOf(n.category),
      category_probabilities: n.category.probabilities,
      priority: checkLabel(n.priority.choice, PRIORITIES),
      priority_confidence: confidenceOf(n.priority),
      priority_probabilities: n.priority.probabilities,
      needs_human_review_probability: n.review,
      call,
    };
  } catch (error) {
    const appError = toAppError(error);
    console.error(`[dm] ${config.model} failed:`, appError.message);
    await logCall({
      ts: new Date().toISOString(),
      route: ctx.route,
      api,
      kind: "dm",
      strategy: ctx.strategy,
      prompt_version: ctx.prompt_version,
      config_id: config.id,
      model: config.model,
      status: appError.status,
      error_code: appError.code,
      latency_ms: Date.now() - started,
      input_tokens: null,
      output_tokens: null,
      cost_usd: 0,
      run_id: ctx.run_id,
    });
    throw appError;
  }
}
