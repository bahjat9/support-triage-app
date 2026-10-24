// The triage contract, defined once with Zod and reused:
//  - Use 1 (ASK): converted to JSON Schema and sent to the provider.
//  - Use 2 (CHECK): every payload is validated before it reaches the user.
import { z } from "zod";

export const CATEGORIES = ["billing", "technical_bug", "account", "feature_request"] as const;
export const PRIORITIES = ["low", "medium", "high"] as const;
export const STRATEGIES = ["llm", "dm", "dm+llm"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Strategy = (typeof STRATEGIES)[number];

/** What the LLM must return (triage-v2). */
export const TriageSchema = z
  .object({
    category: z.enum(CATEGORIES),
    priority: z.enum(PRIORITIES),
    summary: z.string().min(1).max(300),
    suggested_action: z.string().min(1).max(500),
  })
  .strict();
export type TriageLlmOutput = z.infer<typeof TriageSchema>;

/** What the LLM must return in dm+llm mode: only the text, labels are already decided. */
export const WriteupSchema = z
  .object({
    summary: z.string().min(1).max(300),
    suggested_action: z.string().min(1).max(500),
  })
  .strict();
export type WriteupOutput = z.infer<typeof WriteupSchema>;

/** Incoming request to POST /api/triage. */
export const TriageRequestSchema = z
  .object({
    ticket: z.string(),
    version: z.enum(["v1", "v2"]).default("v2"),
    strategy: z.enum(STRATEGIES).default("llm"),
    configId: z.string().max(20).optional(),
  })
  .strict();
export type TriageRequest = z.infer<typeof TriageRequestSchema>;

export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

/** One model call made while answering a triage request. */
export const CallInfoSchema = z.object({
  kind: z.enum(["llm", "dm"]),
  model: z.string(),
  usage: UsageSchema.nullable(), // null when the endpoint reports no usage
  latency_ms: z.number(),
  cost_usd: z.number(),
});
export type CallInfo = z.infer<typeof CallInfoSchema>;

/** The response of POST /api/triage (v2), validated before it is sent. */
export const TriageResponseSchema = z.object({
  version: z.literal("v2"),
  prompt_version: z.string(),
  strategy: z.enum(STRATEGIES),
  triage: z.object({
    category: z.enum(CATEGORIES),
    priority: z.enum(PRIORITIES),
    summary: z.string().nullable(), // null in pure "dm" mode: a DM cannot write
    suggested_action: z.string().nullable(),
    needs_human_review: z.boolean().nullable(),
  }),
  confidence: z
    .object({
      category: z.number().min(0).max(1),
      priority: z.number().min(0).max(1),
      needs_human_review: z.number().min(0).max(1).nullable(),
    })
    .nullable(), // null when only the LLM decided
  decided_by: z.object({ category: z.enum(["llm", "dm"]), priority: z.enum(["llm", "dm"]) }),
  escalated: z.boolean(), // dm+llm: true when DM confidence was too low and the LLM decided
  models: z.array(z.string()),
  calls: z.array(CallInfoSchema),
  usage: UsageSchema, // summed over all calls
  cost_usd: z.number(),
  latency_ms: z.number(),
});
export type TriageResponse = z.infer<typeof TriageResponseSchema>;

export const TriageV1ResponseSchema = z.object({
  version: z.literal("v1"),
  prompt_version: z.string(),
  text: z.string(),
  models: z.array(z.string()),
  usage: UsageSchema,
  cost_usd: z.number(),
  latency_ms: z.number(),
});
export type TriageV1Response = z.infer<typeof TriageV1ResponseSchema>;

/** JSON Schema for the provider (strict mode needs additionalProperties: false). */
export function toProviderJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
  return jsonSchema;
}
