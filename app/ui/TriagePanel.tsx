"use client";

import { useState, type FormEvent } from "react";
import type { Strategy, TriageResponse, TriageV1Response } from "@/lib/schema";
import { fmtUsd, pct, postJson } from "./api";

const EXAMPLE = `CSV export fails after upgrade

Hi, since we upgraded to the Business plan yesterday every CSV export from the Sales dashboard fails with "Error 500". Our weekly board report is due tomorrow morning. Can you help urgently?`;

export default function TriagePanel({
  configId,
  strategy,
  maxChars,
}: {
  configId: string;
  strategy: Strategy;
  maxChars: number;
}) {
  const [ticket, setTicket] = useState("");
  const [version, setVersion] = useState<"v1" | "v2">("v2");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [v1, setV1] = useState<TriageV1Response | null>(null);
  const [v2, setV2] = useState<TriageResponse | null>(null);
  const [explanation, setExplanation] = useState("");
  const [explaining, setExplaining] = useState(false);

  const tooLong = ticket.length > maxChars;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !ticket.trim()) return;
    setBusy(true);
    setError(null);
    setV1(null);
    setV2(null);
    setExplanation("");
    try {
      const body = { ticket, version, strategy: version === "v1" ? "llm" : strategy, configId: configId || undefined };
      const data = await postJson<TriageResponse | TriageV1Response>("/api/triage", body);
      if (data.version === "v1") setV1(data);
      else setV2(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Triage failed.");
    } finally {
      setBusy(false);
    }
  }

  async function explain() {
    if (!v2) return;
    setExplaining(true);
    setExplanation("");
    try {
      const response = await fetch("/api/triage/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket, triage: v2.triage, configId: configId || undefined }),
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? `Explain failed (HTTP ${response.status}).`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        setExplanation((prev) => prev + decoder.decode(value, { stream: true }));
      }
    } catch (e) {
      setExplanation(e instanceof Error ? e.message : "Explain failed.");
    } finally {
      setExplaining(false);
    }
  }

  return (
    <section className="panel">
      <h2>Triage a ticket</h2>
      <form onSubmit={submit} aria-busy={busy}>
        <div className="row">
          <label>
            Version{" "}
            <select value={version} onChange={(e) => setVersion(e.target.value as "v1" | "v2")}>
              <option value="v2">v2 – validated JSON</option>
              <option value="v1">v1 – plain text (LLM only)</option>
            </select>
          </label>
          <span className="muted small">
            Strategy: <b>{version === "v1" ? "llm" : strategy}</b>
          </span>
          <button type="button" className="secondary" onClick={() => setTicket(EXAMPLE)}>
            Load example
          </button>
        </div>
        <label htmlFor="ticket">Ticket (subject, blank line, body)</label>
        <textarea
          id="ticket"
          rows={9}
          value={ticket}
          onChange={(e) => setTicket(e.target.value)}
          placeholder="Paste a customer ticket..."
          disabled={busy}
        />
        <p className={tooLong ? "small warn" : "muted small"}>
          {ticket.length} / {maxChars} characters{tooLong ? " – the server will reject this ticket (400)." : ""}
        </p>
        <button type="submit" disabled={busy || !ticket.trim()}>
          {busy ? "Triaging..." : "Triage"}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>

      {v1 && (
        <div className="result">
          <h3>Result (v1 – plain text, not validated)</h3>
          <pre className="plain">{v1.text}</pre>
          <TokenLine models={v1.models} usage={v1.usage} cost={v1.cost_usd} latency={v1.latency_ms} pv={v1.prompt_version} />
        </div>
      )}

      {v2 && (
        <div className="result">
          <h3>Result (v2 – validated)</h3>
          <dl className="fields">
            <dt>Category</dt>
            <dd>
              <span className="badge">{v2.triage.category}</span>
              {v2.confidence && <span className="muted small"> DM confidence {pct(v2.confidence.category)}</span>}
              <span className="muted small"> · decided by {v2.decided_by.category.toUpperCase()}</span>
            </dd>
            <dt>Priority</dt>
            <dd>
              <span className={`badge prio-${v2.triage.priority}`}>{v2.triage.priority}</span>
              {v2.confidence && <span className="muted small"> DM confidence {pct(v2.confidence.priority)}</span>}
              <span className="muted small"> · decided by {v2.decided_by.priority.toUpperCase()}</span>
            </dd>
            <dt>Needs human review</dt>
            <dd>
              {v2.triage.needs_human_review === null ? (
                <span className="muted">not assessed</span>
              ) : (
                <>
                  {v2.triage.needs_human_review ? "yes" : "no"}
                  {v2.confidence?.needs_human_review !== null && v2.confidence?.needs_human_review !== undefined && (
                    <span className="muted small"> (p = {pct(v2.confidence.needs_human_review)})</span>
                  )}
                </>
              )}
            </dd>
            <dt>Summary</dt>
            <dd>{v2.triage.summary ?? <span className="muted">– (a decision model chooses, it does not write)</span>}</dd>
            <dt>Suggested action</dt>
            <dd>{v2.triage.suggested_action ?? <span className="muted">–</span>}</dd>
          </dl>
          {v2.escalated && (
            <p className="warn small">
              Escalated: the decision model was not confident enough, so the LLM made the decision.
            </p>
          )}
          <TokenLine models={v2.models} usage={v2.usage} cost={v2.cost_usd} latency={v2.latency_ms} pv={v2.prompt_version} />
          {v2.calls.length > 1 && (
            <ul className="small muted">
              {v2.calls.map((c, i) => (
                <li key={i}>
                  {c.kind.toUpperCase()} {c.model}:{" "}
                  {c.usage ? `in ${c.usage.input_tokens} / out ${c.usage.output_tokens} / total ${c.usage.total_tokens}` : "usage not reported"} ·{" "}
                  {c.latency_ms} ms · {fmtUsd(c.cost_usd)}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="secondary" onClick={explain} disabled={explaining}>
            {explaining ? "Explaining..." : "Explain"}
          </button>
          {explanation && <p className="explanation">{explanation}</p>}
        </div>
      )}
    </section>
  );
}

function TokenLine({
  models,
  usage,
  cost,
  latency,
  pv,
}: {
  models: string[];
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  cost: number;
  latency: number;
  pv: string;
}) {
  return (
    <p className="tokens">
      <b>Tokens</b> – input {usage.input_tokens} · output {usage.output_tokens} · total {usage.total_tokens}
      <span className="muted">
        {" "}
        | {fmtUsd(cost)} | {latency} ms | {models.join(" + ")} | {pv}
      </span>
    </p>
  );
}
