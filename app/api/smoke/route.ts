import { z } from "zod";
import { getDmConfig, getLlmConfig } from "@/lib/config";
import { AppError, errorResponse } from "@/lib/errors";
import { STRATEGIES } from "@/lib/schema";
import { runSmoke, type SmokeEvent } from "@/lib/smoke";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const SmokeRequest = z
  .object({
    dataset: z.enum(["labelled100", "all500"]),
    sampleSize: z.number().int().min(1).max(500),
    strategy: z.enum(STRATEGIES).default("llm"),
    configId: z.string().max(20).optional(),
  })
  .strict();

// POST /api/smoke -> NDJSON stream of progress events, then the summary.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(new AppError("invalid_request", "Invalid JSON body."));
  }
  const parsed = SmokeRequest.safeParse(body);
  if (!parsed.success) return errorResponse(new AppError("invalid_request", "Invalid smoke test request."));
  const opts = parsed.data;
  if (opts.strategy !== "dm" && !getLlmConfig(opts.configId)) return errorResponse(new AppError("not_configured"));
  if (opts.strategy !== "llm" && !getDmConfig()) {
    return errorResponse(new AppError("not_configured", "No decision model is configured on the server (DM_API_KEY)."));
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: SmokeEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        await runSmoke(opts, emit);
      } catch (error) {
        console.error("[smoke] run failed", error);
        emit({ type: "error", error: "The smoke test failed. Check the server logs." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
