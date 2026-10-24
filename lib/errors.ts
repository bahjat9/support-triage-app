// One place that maps every failure to one HTTP status and one safe message.
// No stack trace and no provider detail ever reaches the browser.

export type ErrorCode =
  | "invalid_request"
  | "ticket_too_long"
  | "invalid_model_output"
  | "rate_limited"
  | "triage_unavailable"
  | "triage_timeout"
  | "internal_error"
  | "not_configured";

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  ticket_too_long: 400,
  invalid_model_output: 502,
  rate_limited: 429,
  triage_unavailable: 502,
  triage_timeout: 504,
  internal_error: 500,
  not_configured: 500,
};

const SAFE_MESSAGE: Record<ErrorCode, string> = {
  invalid_request: "The request is invalid.",
  ticket_too_long: "The ticket is too long.",
  invalid_model_output: "The model returned an answer we could not validate. Please try again.",
  rate_limited: "Too many requests to the model provider. Please wait a moment and retry.",
  triage_unavailable: "The model provider is unavailable right now. Please try again later.",
  triage_timeout: "The model took too long to answer. Please try again.",
  internal_error: "Something went wrong on our side. Please contact the administrator.",
  not_configured: "This model or strategy is not configured on the server.",
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly publicMessage: string;
  constructor(code: ErrorCode, publicMessage?: string, internalDetail?: string) {
    super(internalDetail ?? publicMessage ?? SAFE_MESSAGE[code]);
    this.code = code;
    this.status = STATUS[code];
    this.publicMessage = publicMessage ?? SAFE_MESSAGE[code];
  }
}

/** Invalid JSON or schema mismatch coming back from a model. Retried once. */
export class LlmInvalidOutputError extends AppError {
  constructor(detail: string) {
    super("invalid_model_output", undefined, detail);
  }
}

/** Map an unknown error (OpenAI SDK, fetch, our own) to an AppError. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const e = error as { status?: number; name?: string; code?: string };
  const name = e?.name ?? "";
  if (name.includes("Timeout") || e?.code === "ETIMEDOUT" || name === "AbortError" || name === "TimeoutError") {
    return new AppError("triage_timeout", undefined, String(error));
  }
  if (name.includes("APIConnectionError") || name === "TypeError") {
    // network failure (fetch throws TypeError)
    return new AppError("triage_unavailable", undefined, String(error));
  }
  const status = typeof e?.status === "number" ? e.status : undefined;
  if (status === 429) return new AppError("rate_limited", undefined, String(error));
  if (status !== undefined && status >= 500) return new AppError("triage_unavailable", undefined, String(error));
  if (status !== undefined && [400, 401, 403, 404, 413, 422].includes(status)) {
    // Wrong key, model or parameter: our configuration is wrong, do not retry.
    return new AppError("internal_error", undefined, String(error));
  }
  return new AppError("internal_error", undefined, String(error));
}

export function errorResponse(error: AppError): Response {
  return Response.json({ error: error.publicMessage, code: error.code }, { status: error.status });
}
