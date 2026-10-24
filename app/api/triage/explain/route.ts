import { z } from "zod";
import { MAX_TICKET_CHARS } from "@/lib/config";
import { AppError, errorResponse, toAppError } from "@/lib/errors";
import { streamText } from "@/lib/llm";
import { EXPLAIN_PROMPT_VERSION, EXPLAIN_SYSTEM_PROMPT, wrapTicket } from "@/lib/prompt";
import { CATEGORIES, PRIORITIES } from "@/lib/schema";

// POST /api/triage/explain { ticket, triage } -> streamed text for the support agent.
const ExplainRequest = z.object({
  ticket: z.string().min(1).max(MAX_TICKET_CHARS),
  triage: z.object({ category: z.enum(CATEGORIES), priority: z.enum(PRIORITIES) }).passthrough(),
  configId: z.string().max(20).optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(new AppError("invalid_request", "Invalid JSON body."));
  }
  const parsed = ExplainRequest.safeParse(body);
  if (!parsed.success) return errorResponse(new AppError("invalid_request", "Invalid explain request."));
  const { ticket, triage, configId } = parsed.data;
  try {
    const stream = await streamText(
      EXPLAIN_SYSTEM_PROMPT,
      `${wrapTicket(ticket)}\n\nTriage result: category=${triage.category}, priority=${triage.priority}`,
      { route: "explain", prompt_version: EXPLAIN_PROMPT_VERSION },
      configId,
    );
    return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(toAppError(error));
  }
}
