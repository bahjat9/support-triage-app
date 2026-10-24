// Small client helper: POST JSON, turn any failure into a readable message.
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Network error: could not reach the server.");
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // fall through
  }
  if (!response.ok) {
    const msg =
      data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `Request failed (HTTP ${response.status}).`;
    const code = data && typeof data === "object" && "code" in data ? ` [${String((data as { code: unknown }).code)}]` : "";
    throw new Error(`${msg}${code} (HTTP ${response.status})`);
  }
  return data as T;
}

export function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`;
}

export function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : `${(n * 100).toFixed(1)}%`;
}
