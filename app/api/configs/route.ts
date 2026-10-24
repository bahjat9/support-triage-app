import { getDmConfig, getLlmConfigs, MAX_TICKET_CHARS } from "@/lib/config";

export const dynamic = "force-dynamic";

// Only ids and labels: never a URL or a key.
export async function GET() {
  const dm = getDmConfig();
  return Response.json({
    llm: getLlmConfigs().map((c) => ({ id: c.id, label: c.label, structuredMode: c.structuredMode })),
    dm: dm ? { label: dm.label, apiFormat: dm.apiFormat, threshold: dm.confidenceThreshold } : null,
    maxTicketChars: MAX_TICKET_CHARS,
  });
}
