"use client";

import { useState } from "react";
import type { SmokeSummary } from "@/lib/smoke";
import { ConfusionTable } from "../ui/ConfusionTable";

function pct(n: number | null) {
  return n === null ? "–" : `${(n * 100).toFixed(1)}%`;
}
function usd(n: number) {
  return n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`;
}
function outcomes(o: Record<string, number>) {
  return Object.entries(o)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}

export default function RunsTable({ runs }: { runs: SmokeSummary[] }) {
  const [selected, setSelected] = useState<string[]>([]);

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-2)));
  }

  const compared = selected.map((id) => runs.find((r) => r.run_id === id)).filter(Boolean) as SmokeSummary[];

  if (!runs.length) return <p className="muted">No smoke run yet. Run one from the Smoke test tab.</p>;

  const lines: [string, (r: SmokeSummary) => string][] = [
    ["Date", (r) => r.ts.replace("T", " ").slice(0, 19)],
    ["Strategy", (r) => r.strategy],
    ["Model(s)", (r) => r.models],
    ["Prompt version", (r) => r.prompt_version],
    ["Dataset / sample", (r) => `${r.dataset} / ${r.sample_size}`],
    ["Outcomes", (r) => outcomes(r.outcomes)],
    ["Category accuracy", (r) => `${pct(r.category_accuracy)} (${r.category_mismatches ?? "–"} mismatches)`],
    ["Priority accuracy", (r) => `${pct(r.priority_accuracy)} (${r.priority_mismatches ?? "–"} mismatches)`],
    ["Human-review accuracy", (r) => pct(r.review_accuracy)],
    ["Escalations (dm+llm)", (r) => String(r.escalations)],
    ["Avg / p50 / p95 latency", (r) => `${r.avg_latency_ms} / ${r.p50_latency_ms} / ${r.p95_latency_ms} ms`],
    ["Tokens in / out", (r) => `${r.input_tokens} / ${r.output_tokens}`],
    ["Total cost", (r) => usd(r.total_cost_usd)],
    ["Cost per ticket", (r) => usd(r.sample_size ? r.total_cost_usd / r.sample_size : 0)],
    ["Run file", (r) => `runs/${r.file}`],
  ];

  return (
    <>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Compare</th>
              <th>Date</th>
              <th>Strategy</th>
              <th>Model(s)</th>
              <th>Prompt</th>
              <th>Dataset</th>
              <th>N</th>
              <th>Outcomes</th>
              <th>Category acc.</th>
              <th>Priority acc.</th>
              <th>Avg latency</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.run_id} className={selected.includes(r.run_id) ? "selected" : ""}>
                <td>
                  <input type="checkbox" checked={selected.includes(r.run_id)} onChange={() => toggle(r.run_id)} aria-label={`compare ${r.run_id}`} />
                </td>
                <td className="small">{r.ts.replace("T", " ").slice(0, 19)}</td>
                <td>{r.strategy}</td>
                <td>{r.models}</td>
                <td className="small">{r.prompt_version}</td>
                <td>{r.dataset}</td>
                <td>{r.sample_size}</td>
                <td className="small">{outcomes(r.outcomes)}</td>
                <td>{pct(r.category_accuracy)}</td>
                <td>{pct(r.priority_accuracy)}</td>
                <td>{r.avg_latency_ms} ms</td>
                <td>{usd(r.total_cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {compared.length === 2 && (
        <div className="result">
          <h3>Side-by-side comparison</h3>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Run A</th>
                  <th>Run B</th>
                </tr>
              </thead>
              <tbody>
                {lines.map(([label, f]) => (
                  <tr key={label}>
                    <th>{label}</th>
                    <td>{f(compared[0])}</td>
                    <td>{f(compared[1])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row top">
            {compared.map((r, i) =>
              r.category_confusion ? (
                <ConfusionTable key={r.run_id} title={`Run ${i === 0 ? "A" : "B"} – category confusion`} matrix={r.category_confusion} />
              ) : null,
            )}
          </div>
        </div>
      )}
    </>
  );
}
