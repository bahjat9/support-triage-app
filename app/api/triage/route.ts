import { MAX_TICKET_CHARS } from "@/lib/config";
import { AppError, errorResponse, toAppError } from "@/lib/errors";
import { TriageRequestSchema } from "@/lib/schema";
import { triageV1, triageV2 } from "@/lib/triage";

// POST /api/triage { ticket, version?: "v1"|"v2", strategy?: "llm"|"dm"|"dm+llm", configId? }
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(new AppError("invalid_request", "Invalid JSON body."));
  }
  // CHECK the request against its schema before anything is forwarded.
  const parsed = TriageRequestSchema.safeParse(body);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "body").join(", ");
    return errorResponse(new AppError("invalid_request", `Invalid triage request (check: ${fields}).`));
  }
  const { ticket, version, strategy, configId } = parsed.data;
  if (!ticket.trim()) return errorResponse(new AppError("invalid_request", "The ticket is empty."));
  if (ticket.length > MAX_TICKET_CHARS) {
    // Rejected before any provider call (cost / output-length attack protection).
    return errorResponse(
      new AppError("ticket_too_long", `The ticket is too long (${ticket.length} characters, max ${MAX_TICKET_CHARS}).`),
    );
  }
  if (version === "v1" && strategy !== "llm") {
    return errorResponse(new AppError("invalid_request", "Triage v1 is LLM-only (plain text)."));
  }
  try {
    const result = version === "v1" ? await triageV1(ticket, configId) : await triageV2(ticket, strategy, configId);
    return Response.json(result);
  } catch (error) {
    return errorResponse(toAppError(error));
  }
}
