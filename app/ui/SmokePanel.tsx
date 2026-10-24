"use client";

import { useState } from "react";
import type { Strategy } from "@/lib/schema";
import type { SmokeEvent, SmokeRow, SmokeSummary } from "@/lib/smoke";
import { fmtUsd, pct } from "./api";
import { ConfusionTable } from "./ConfusionTable";

export default function SmokePanel({ configId, strategy }: { configId: string; strategy: Strategy }) {
  const [dataset, setDataset] = useState<"labelled100" | "all500">("labelled100");
  const [sampleSize, setSampleSize] = useState(20);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<SmokeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<SmokeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const max = dataset === "labelled100" ? 100 : 500;
  const labelled = dataset === "labelled100";

  async function run() {
    setRunning(true);
    setRows([]);
    setSummary(null);
    setError(null);
    setTotal(0);
    try {
      const response = await fetch("/api/smoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset, sampleSize: Math.min(max, Math.max(1, sampleSize)), strategy, configId: configId || undefined }),
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? `Smoke test failed (HTTP ${response.status}).`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as SmokeEvent;
          if (event.type === "start") setTotal(event.total);
          else if (event.type === "row") setRows((prev) => [...prev, event.row]);
          else if (event.type === "summary") setSummary(event.summary);
          else if (event.type === "error") setError(event.error);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Smoke test failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="panel">
      <h2>Smoke test</h2>
      <div className="row">
        <label>
          Dataset{" "}
          <select value={dataset} onChange={(e) => setDataset(e.target.value as "labelled100" | "all500")} disabled={running}>
            <option value="labelled100">Labelled 100 tickets</option>
            <option value="all500">500 tickets (unlabelled)</option>
          </select>
        </label>
        <label>
          Tickets to sample{" "}
          <input
            type="number"
            min={1}
            max={max}
            value={sampleSize}
            onChange={(e) => setSampleSize(Number(e.target.value))}
            disabled={running}
          />
        </label>
        <button type="button" onClick={() => setSampleSize(max)} className="secondary" disabled={running}>
          All {max}
        </button>
        <button type="button" onClick={run} disabled={running || sampleSize < 1}>
          {running ? `Running ${rows.length}/${total || "…"}` : `Run smoke test (${strategy})`}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}

      {summary && (
        <div className="result">
          <h3>Summary</h3>
          <div className="stats">
            <Stat label="Outcomes" value={Object.entries(summary.outcomes).map(([k, v]) => `${k}: ${v}`).join(" · ")} />
            {summary.labelled && (
              <>
                <Stat label="Category mismatches" value={`${summary.category_mismatches} / ${summary.evaluated}`} sub={pct(summary.category_accuracy) + " accuracy"} />
                <Stat label="Priority mismatches" value={`${summary.priority_mismatches} / ${summary.evaluated}`} sub={pct(summary.priority_accuracy) + " accuracy"} />
                {summary.review_accuracy !== null && <Stat label="Human-review accuracy" value={pct(summary.review_accuracy)} />}
              </>
            )}
            <Stat label="Latency" value={`${summary.avg_latency_ms} ms avg`} sub={`p50 ${summary.p50_latency_ms} · p95 ${summary.p95_latency_ms}`} />
            <Stat label="Cost" value={fmtUsd(summary.total_cost_usd)} sub={`${summary.input_tokens} in / ${summary.output_tokens} out tokens`} />
            <Stat label="Models" value={summary.models} sub={`${summary.strategy} · ${summary.prompt_version}`} />
            {summary.strategy === "dm+llm" && <Stat label="Escalated to LLM" value={String(summary.escalations)} />}
          </div>
          <p className="muted small">Saved to runs/{summary.file} and listed on /admin.</p>
          {summary.category_confusion && (
            <div className="row top">
              <ConfusionTable title="Category (rows = expected, cols = predicted)" matrix={summary.category_confusion} />
              {summary.priority_confusion && <ConfusionTable title="Priority" matrix={summary.priority_confusion} />}
            </div>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Outcome</th>
                <th>Category (predicted)</th>
                {labelled && <th>Category (label)</th>}
                <th>Priority (predicted)</th>
                {labelled && <th>Priority (label)</th>}
                <th>Tags</th>
                <th>ms</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ticket_id}>
                  <td>{r.ticket_id}</td>
                  <td className={r.outcome === 200 ? "" : "bad"}>
                    {r.outcome}
                    {r.error_code ? ` ${r.error_code}` : ""}
                    {r.escalated ? " ↑LLM" : ""}
                  </td>
                  <td className={r.category_match === false ? "bad" : r.category_match ? "good" : ""}>
                    {r.category ?? "–"}
                    {r.confidence_category !== null && <span className="muted small"> {pct(r.confidence_category)}</span>}
                  </td>
                  {labelled && <td>{r.expected_category}</td>}
                  <td className={r.priority_match === false ? "bad" : r.priority_match ? "good" : ""}>
                    {r.priority ?? "–"}
                    {r.confidence_priority !== null && <span className="muted small"> {pct(r.confidence_priority)}</span>}
                  </td>
                  {labelled && <td>{r.expected_priority}</td>}
                  <td className="small">{r.tags.join(", ")}</td>
                  <td>{r.latency_ms}</td>
                  <td>{r.input_tokens + r.output_tokens}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="statvalue">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}
