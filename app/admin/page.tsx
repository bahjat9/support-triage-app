import Link from "next/link";
import { CALLS_LOG, readJsonl, RUNS_LOG, type CallLogLine } from "@/lib/log";
import type { SmokeSummary } from "@/lib/smoke";
import RunsTable from "./RunsTable";

export const dynamic = "force-dynamic";

type Group = {
  key: string;
  route: string;
  prompt_version: string;
  api: string;
  model: string;
  calls: number;
  errors: Record<string, number>;
  input: number;
  output: number;
  cost: number;
  latency: number;
};

function usd(n: number) {
  return n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`;
}

export default async function AdminPage() {
  const [calls, runs] = await Promise.all([readJsonl<CallLogLine>(CALLS_LOG), readJsonl<SmokeSummary>(RUNS_LOG)]);

  const groups = new Map<string, Group>();
  for (const c of calls) {
    const key = `${c.route}|${c.prompt_version}|${c.api}|${c.model}`;
    const g =
      groups.get(key) ??
      ({ key, route: c.route, prompt_version: c.prompt_version, api: c.api, model: c.model, calls: 0, errors: {}, input: 0, output: 0, cost: 0, latency: 0 } as Group);
    g.calls++;
    if (c.status !== 200) g.errors[String(c.status)] = (g.errors[String(c.status)] ?? 0) + 1;
    g.input += c.input_tokens ?? 0;
    g.output += c.output_tokens ?? 0;
    g.cost += c.cost_usd ?? 0;
    g.latency += c.latency_ms ?? 0;
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  const totals = rows.reduce(
    (t, g) => ({
      calls: t.calls + g.calls,
      errors: t.errors + Object.values(g.errors).reduce((a, b) => a + b, 0),
      input: t.input + g.input,
      output: t.output + g.output,
      cost: t.cost + g.cost,
    }),
    { calls: 0, errors: 0, input: 0, output: 0, cost: 0 },
  );

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <h1>/admin</h1>
          <p className="muted">Logged model calls (logs/llm-calls.jsonl) and smoke runs (logs/smoke-runs.jsonl)</p>
        </div>
        <Link href="/" className="adminlink">
          ← back to the app
        </Link>
      </header>

      <section className="panel">
        <h2>Smoke test runs ({runs.length})</h2>
        <p className="muted small">Tick two runs to compare them side by side.</p>
        <RunsTable runs={[...runs].reverse()} />
      </section>

      <section className="panel">
        <h2>Calls by route, prompt version, API and model</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Route</th>
                <th>Prompt version</th>
                <th>API</th>
                <th>Model</th>
                <th>Calls</th>
                <th>Errors by status</th>
                <th>Input tok.</th>
                <th>Output tok.</th>
                <th>Avg latency</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.key}>
                  <td>{g.route}</td>
                  <td>{g.prompt_version}</td>
                  <td>{g.api}</td>
                  <td>{g.model}</td>
                  <td>{g.calls}</td>
                  <td className={Object.keys(g.errors).length ? "bad" : ""}>
                    {Object.entries(g.errors).map(([s, n]) => `${s}: ${n}`).join(", ") || "–"}
                  </td>
                  <td>{g.input}</td>
                  <td>{g.output}</td>
                  <td>{Math.round(g.latency / g.calls)} ms</td>
                  <td>{usd(g.cost)}</td>
                </tr>
              ))}
              <tr className="total">
                <td colSpan={4}>Total</td>
                <td>{totals.calls}</td>
                <td>{totals.errors}</td>
                <td>{totals.input}</td>
                <td>{totals.output}</td>
                <td></td>
                <td>{usd(totals.cost)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Last 50 calls</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Route</th>
                <th>Strategy</th>
                <th>Kind</th>
                <th>Model</th>
                <th>Status</th>
                <th>ms</th>
                <th>In</th>
                <th>Out</th>
                <th>Cost</th>
                <th>Run</th>
              </tr>
            </thead>
            <tbody>
              {calls
                .slice(-50)
                .reverse()
                .map((c, i) => (
                  <tr key={i}>
                    <td className="small">{c.ts.replace("T", " ").slice(0, 19)}</td>
                    <td>{c.route}</td>
                    <td>{c.strategy ?? "–"}</td>
                    <td>{c.kind}</td>
                    <td>{c.model}</td>
                    <td className={c.status === 200 ? "" : "bad"}>
                      {c.status}
                      {c.error_code ? ` ${c.error_code}` : ""}
                    </td>
                    <td>{c.latency_ms}</td>
                    <td>{c.input_tokens ?? "n/a"}</td>
                    <td>{c.output_tokens ?? "n/a"}</td>
                    <td>{usd(c.cost_usd)}</td>
                    <td className="small">{c.run_id ? "smoke" : ""}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
