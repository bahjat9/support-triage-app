// Triage logic: v1 (plain text) and v2 (validated object) with three strategies:
//  - "llm":    the LLM decides everything and writes the summary/action.
//  - "dm":     the decision model decides category, priority and human review.
//              No summary / action: a decision model chooses, it does not write.
//  - "dm+llm": the DM decides the labels (fast, calibrated probabilities); the LLM
//              writes the summary and action. If the DM's confidence on category or
//              priority is below DM_CONFIDENCE_THRESHOLD, the ticket is escalated
//              and the LLM makes the full decision instead.
import "server-only";
import { getDmConfig } from "./config";
import { decide } from "./dm";
import { completeStructured, completeText, resolveConfig } from "./llm";
import {
  DM_PROMPT_VERSION,
  PROMPT_VERSION,
  PROMPT_VERSION_V1,
  TRIAGE_V1_SYSTEM_PROMPT,
  triageV2SystemPrompt,
  wrapTicket,
  writeupSystemPrompt,
} from "./prompt";
import {
  TriageResponseSchema,
  TriageSchema,
  TriageV1ResponseSchema,
  WriteupSchema,
  type CallInfo,
  type Strategy,
  type TriageResponse,
  type TriageV1Response,
  type Usage,
} from "./schema";

function sumUsage(calls: CallInfo[]): Usage {
  return calls.reduce<Usage>(
    (acc, c) => ({
      input_tokens: acc.input_tokens + (c.usage?.input_tokens ?? 0),
      output_tokens: acc.output_tokens + (c.usage?.output_tokens ?? 0),
      total_tokens: acc.total_tokens + (c.usage?.total_tokens ?? 0),
    }),
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  );
}

export function promptVersionFor(strategy: Strategy): string {
  if (strategy === "llm") return PROMPT_VERSION;
  if (strategy === "dm") return DM_PROMPT_VERSION;
  return `${DM_PROMPT_VERSION}+${PROMPT_VERSION}`;
}

export async function triageV1(ticket: string, configId?: string, runId?: string): Promise<TriageV1Response> {
  const config = resolveConfig(configId);
  const started = Date.now();
  const { text, call } = await completeText(
    TRIAGE_V1_SYSTEM_PROMPT,
    wrapTicket(ticket),
    { route: "triage", prompt_version: PROMPT_VERSION_V1, strategy: "llm", run_id: runId },
    config,
  );
  return TriageV1ResponseSchema.parse({
    version: "v1",
    prompt_version: PROMPT_VERSION_V1,
    text,
    models: [config.model],
    usage: sumUsage([call]),
    cost_usd: call.cost_usd,
    latency_ms: Date.now() - started,
  });
}

export async function triageV2(
  ticket: string,
  strategy: Strategy,
  configId?: string,
  runId?: string,
): Promise<TriageResponse> {
  const started = Date.now();
  const promptVersion = promptVersionFor(strategy);
  const ctx = { route: "triage" as const, prompt_version: promptVersion, strategy, run_id: runId };
  const calls: CallInfo[] = [];
  const models = new Set<string>();

  let result: Omit<TriageResponse, "calls" | "usage" | "cost_usd" | "latency_ms" | "models">;

  if (strategy === "llm") {
    const config = resolveConfig(configId);
    models.add(config.model);
    const { data, calls: c } = await completeStructured(
      triageV2SystemPrompt(config.structuredMode),
      wrapTicket(ticket),
      TriageSchema,
      "support_triage",
      ctx,
      config,
    );
    calls.push(...c);
    result = {
      version: "v2",
      prompt_version: promptVersion,
      strategy,
      triage: { ...data, needs_human_review: null },
      confidence: null,
      decided_by: { category: "llm", priority: "llm" },
      escalated: false,
    };
  } else {
    const dm = await decide(ticket, ctx);
    calls.push(dm.call);
    models.add(dm.call.model);
    const review = dm.needs_human_review_probability;
    const confidence = {
      category: dm.category_confidence,
      priority: dm.priority_confidence,
      needs_human_review: review,
    };
    const triageBase = {
      category: dm.category,
      priority: dm.priority,
      needs_human_review: review === null ? null : review >= 0.5,
    };

    if (strategy === "dm") {
      result = {
        version: "v2",
        prompt_version: promptVersion,
        strategy,
        triage: { ...triageBase, summary: null, suggested_action: null },
        confidence,
        decided_by: { category: "dm", priority: "dm" },
        escalated: false,
      };
    } else {
      // dm+llm
      const config = resolveConfig(configId);
      models.add(config.model);
      const threshold = getDmConfig()?.confidenceThreshold ?? 0.6;
      const confident = dm.category_confidence >= threshold && dm.priority_confidence >= threshold;
      if (confident) {
        const { data, calls: c } = await completeStructured(
          writeupSystemPrompt(config.structuredMode, dm.category, dm.priority),
          wrapTicket(ticket),
          WriteupSchema,
          "support_triage_writeup",
          ctx,
          config,
        );
        calls.push(...c);
        result = {
          version: "v2",
          prompt_version: promptVersion,
          strategy,
          triage: { ...triageBase, ...data },
          confidence,
          decided_by: { category: "dm", priority: "dm" },
          escalated: false,
        };
      } else {
        const { data, calls: c } = await completeStructured(
          triageV2SystemPrompt(config.structuredMode),
          wrapTicket(ticket),
          TriageSchema,
          "support_triage",
          ctx,
          config,
        );
        calls.push(...c);
        result = {
          version: "v2",
          prompt_version: promptVersion,
          strategy,
          triage: { ...data, needs_human_review: triageBase.needs_human_review },
          confidence,
          decided_by: { category: "llm", priority: "llm" },
          escalated: true,
        };
      }
    }
  }

  // CHECK our own response too before it leaves the server.
  return TriageResponseSchema.parse({
    ...result,
    models: [...models],
    calls,
    usage: sumUsage(calls),
    cost_usd: calls.reduce((s, c) => s + c.cost_usd, 0),
    latency_ms: Date.now() - started,
  });
}
