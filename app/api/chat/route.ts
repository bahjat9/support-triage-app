import { z } from "zod";
import { CHAT_PROMPT_VERSION, CHAT_SYSTEM_PROMPT } from "@/lib/prompt";
import { chat } from "@/lib/llm";
import { MAX_CHAT_MESSAGES, MAX_CHAT_MESSAGE_CHARS } from "@/lib/config";
import { AppError, errorResponse, toAppError } from "@/lib/errors";

// The API is stateless: the page sends the whole conversation every time.
// Only "user" and "assistant" roles are accepted: a "system" message from the
// browser is rejected with 400 (the system prompt belongs to the server).
const ChatRequest = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().min(1).max(MAX_CHAT_MESSAGE_CHARS),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CHAT_MESSAGES),
    configId: z.string().max(20).optional(),
  })
  .strict();

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body.", code: "invalid_request" }, { status: 400 });
  }
  // Backward compatible with the original skeleton: { message: "..." }
  if (body && typeof body === "object" && "message" in body && !("messages" in body)) {
    const m = (body as { message: unknown }).message;
    body = { messages: [{ role: "user", content: m }] };
  }
  const parsed = ChatRequest.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Please send a non-empty conversation of user/assistant messages.", code: "invalid_request" },
      { status: 400 },
    );
  }
  const last = parsed.data.messages[parsed.data.messages.length - 1];
  if (last.role !== "user" || !last.content.trim()) {
    return errorResponse(new AppError("invalid_request", "The last message must be a non-empty user message."));
  }
  try {
    const { answer, call } = await chat(
      parsed.data.messages,
      CHAT_SYSTEM_PROMPT,
      { route: "chat", prompt_version: CHAT_PROMPT_VERSION },
      parsed.data.configId,
    );
    return Response.json({ answer, model: call.model, usage: call.usage, cost_usd: call.cost_usd });
  } catch (error) {
    return errorResponse(toAppError(error));
  }
}
