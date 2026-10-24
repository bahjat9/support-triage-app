// The only module that talks to LLM providers (OpenAI-compatible SDK).
// Routes call these functions; no SDK call anywhere else.
import "server-only";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { z } from "zod";
import { getLlmConfig, LLM_MAX_RETRIES, LLM_TIMEOUT_MS, type LlmConfig } from "./config";
import { AppError, LlmInvalidOutputError, toAppError } from "./errors";
import { logCall } from "./log";
import { toProviderJsonSchema, type CallInfo, type Usage } from "./schema";

export type CallContext = {
  route: "chat" | "triage" | "explain";
  prompt_version: string;
  strategy?: string;
  run_id?: string;
};

const clients = new Map<string, OpenAI>();

function clientFor(config: LlmConfig): OpenAI {
  let client = clients.get(config.id);
  if (!client) {
    client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      timeout: LLM_TIMEOUT_MS, // per attempt
      maxRetries: LLM_MAX_RETRIES, // SDK retries 429 / 5xx / network with backoff
    });
    clients.set(config.id, client);
  }
  return client;
}

export function resolveConfig(configId?: string): LlmConfig {
  const config = getLlmConfig(configId);
  if (!config) throw configId ? new AppError("invalid_request", "Unknown model configuration.") : new AppError("not_configured");
  return config;
}

export function costOf(usage: Usage | null, inPerM: number, outPerM: number): number {
  if (!usage) return 0;
  return (usage.input_tokens * inPerM + usage.output_tokens * outPerM) / 1_000_000;
}

function usageFrom(u: OpenAI.Completions.CompletionUsage | undefined): Usage | null {
  if (!u) return null;
  const input = u.prompt_tokens ?? 0;
  const output = u.completion_tokens ?? 0;
  return { input_tokens: input, output_tokens: output, total_tokens: u.total_tokens ?? input + output };
}

type RawResult = { text: string; usage: Usage | null; finishReason: string | null; latency: number };

async function rawCompletion(
  config: LlmConfig,
  ctx: CallContext,
  messages: ChatCompletionMessageParam[],
  extra: Partial<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming> = {},
  validate?: (r: RawResult) => void, // CHECK step: throws LlmInvalidOutputError -> logged as 502
): Promise<{ result: RawResult; call: CallInfo }> {
  const started = Date.now();
  let invalid: AppError | undefined;
  let callInfo: CallInfo | undefined;
  try {
    const completion = await clientFor(config).chat.completions.create({
      model: config.model,
      messages,
      ...extra,
      stream: false,
    });
    const latency = Date.now() - started;
    const choice = completion.choices[0];
    const usage = usageFrom(completion.usage);
    const cost = costOf(usage, config.priceInputPerM, config.priceOutputPerM);
    const result: RawResult = { text: choice?.message?.content ?? "", usage, finishReason: choice?.finish_reason ?? null, latency };
    callInfo = { kind: "llm", model: config.model, usage, latency_ms: latency, cost_usd: cost };
    try {
      validate?.(result);
    } catch (e) {
      invalid = e instanceof AppError ? e : new LlmInvalidOutputError(String(e));
    }
    await logCall({
      ts: new Date().toISOString(),
      route: ctx.route,
      api: "chat_completions",
      kind: "llm",
      strategy: ctx.strategy,
      prompt_version: ctx.prompt_version,
      config_id: config.id,
      model: config.model,
      status: invalid ? invalid.status : 200,
      error_code: invalid?.code,
      latency_ms: latency,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      cost_usd: cost,
      run_id: ctx.run_id,
    });
    if (invalid) throw invalid;
    return { result, call: callInfo };
  } catch (error) {
    if (invalid && error === invalid) {
      (invalid as AppError & { call?: CallInfo }).call = callInfo;
      throw invalid; // already logged
    }
    const appError = toAppError(error);
    console.error(`[llm] ${config.id}/${config.model} failed:`, appError.message);
    await logCall({
      ts: new Date().toISOString(),
      route: ctx.route,
      api: "chat_completions",
      kind: "llm",
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

/** Chat with history. The client resends the whole conversation each time. */
export async function chat(
  history: { role: "user" | "assistant"; content: string }[],
  systemPrompt: string,
  ctx: CallContext,
  configId?: string,
): Promise<{ answer: string; call: CallInfo }> {
  const config = resolveConfig(configId);
  const { result, call } = await rawCompletion(config, ctx, [
    { role: "system", content: systemPrompt },
    ...history,
  ]);
  if (!result.text.trim()) throw new LlmInvalidOutputError("empty chat answer");
  return { answer: result.text, call };
}

/** triage-v1: plain text straight back. */
export async function completeText(
  systemPrompt: string,
  userContent: string,
  ctx: CallContext,
  config: LlmConfig,
): Promise<{ text: string; call: CallInfo }> {
  const { result, call } = await rawCompletion(config, ctx, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ]);
  return { text: result.text, call };
}

/** Remove an optional ```json ... ``` fence (prompt-only mode). */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : trimmed;
}

/**
 * Structured output: ASK (json_schema or prompt-only) then CHECK (JSON.parse + Zod).
 * Invalid output is retried once, then surfaces as 502 invalid_model_output.
 */
export async function completeStructured<T>(
  systemPrompt: string,
  userContent: string,
  schema: z.ZodType<T>,
  schemaName: string,
  ctx: CallContext,
  config: LlmConfig,
): Promise<{ data: T; calls: CallInfo[] }> {
  const calls: CallInfo[] = [];
  const extra: Partial<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming> =
    config.structuredMode === "json_schema"
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: schemaName, strict: true, schema: toProviderJsonSchema(schema) },
          },
        }
      : {};

  for (let attempt = 0; attempt < 2; attempt++) {
    let data: T | undefined;
    try {
      const { call } = await rawCompletion(
        config,
        ctx,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        extra,
        (result) => {
          if (result.finishReason === "length") throw new LlmInvalidOutputError("cut off (finish_reason=length)");
          let raw: unknown;
          try {
            raw = JSON.parse(config.structuredMode === "prompt" ? stripCodeFence(result.text) : result.text);
          } catch {
            throw new LlmInvalidOutputError("not JSON");
          }
          const parsed = schema.safeParse(raw);
          if (!parsed.success) throw new LlmInvalidOutputError("schema mismatch: " + parsed.error.message);
          data = parsed.data;
        },
      );
      calls.push(call);
      return { data: data as T, calls };
    } catch (error) {
      if (!(error instanceof LlmInvalidOutputError)) throw error; // provider errors: no extra retry here
      const call = (error as LlmInvalidOutputError & { call?: CallInfo }).call;
      if (call) calls.push(call);
      console.warn(`[llm] invalid output from ${config.model} (attempt ${attempt + 1}):`, error.message);
      if (attempt === 1) throw error; // retried once, logged: surfaces as 502
    }
  }
  throw new LlmInvalidOutputError("invalid output");
}

/** Streamed free text (Explain button). Returns a ReadableStream of UTF-8 text. */
export async function streamText(
  systemPrompt: string,
  userContent: string,
  ctx: CallContext,
  configId?: string,
): Promise<ReadableStream<Uint8Array>> {
  const config = resolveConfig(configId);
  const started = Date.now();
  let stream;
  try {
    stream = await clientFor(config).chat.completions.create({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });
  } catch (error) {
    const appError = toAppError(error);
    await logCall({
      ts: new Date().toISOString(),
      route: ctx.route,
      api: "chat_completions",
      kind: "llm",
      prompt_version: ctx.prompt_version,
      config_id: config.id,
      model: config.model,
      status: appError.status,
      error_code: appError.code,
      latency_ms: Date.now() - started,
      input_tokens: null,
      output_tokens: null,
      cost_usd: 0,
    });
    throw appError;
  }
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let usage: Usage | null = null;
      let status = 200;
      let errorCode: string | undefined;
      try {
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) controller.enqueue(encoder.encode(delta));
          if (chunk.usage) usage = usageFrom(chunk.usage);
        }
      } catch (error) {
        // The 200 is already sent: tell the reader in-band.
        const appError = toAppError(error);
        status = appError.status;
        errorCode = appError.code;
        controller.enqueue(encoder.encode(`\n\n[explanation interrupted: ${appError.publicMessage}]`));
      } finally {
        await logCall({
          ts: new Date().toISOString(),
          route: ctx.route,
          api: "chat_completions",
          kind: "llm",
          prompt_version: ctx.prompt_version,
          config_id: config.id,
          model: config.model,
          status,
          error_code: errorCode,
          latency_ms: Date.now() - started,
          input_tokens: usage?.input_tokens ?? null, // some endpoints send no usage in streams
          output_tokens: usage?.output_tokens ?? null,
          cost_usd: costOf(usage, config.priceInputPerM, config.priceOutputPerM),
        });
        controller.close();
      }
    },
  });
}
