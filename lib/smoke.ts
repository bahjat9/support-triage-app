// Smoke test runner: sample tickets from a dataset, run them through the same
// triage code path as the API, compare with labels, save and log the run.
import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { getDmConfig, getLlmConfig, MAX_TICKET_CHARS } from "./config";
import { toAppError } from "./errors";
import { logRun, RUNS_DIR } from "./log";
import { CATEGORIES, PRIORITIES, type Strategy } from "./schema";
import { promptVersionFor, triageV2 } from "./triage";

export type DatasetId = "labelled100" | "all500";

type Ticket = {
  ticket_id: string;
  subject: string;
  body: string;
  customer_plan?: string;
  language?: string;
  category?: string;
  priority?: string;
  needs_human_review?: boolean;
  tags?: string;
};

export type SmokeRow = {
  ticket_id: string;
  tags: string[];
  outcome: number; // HTTP status the API would have returned
  error_code?: string;
  expected_category: string | null;
  expected_priority: string | null;
  expected_review: boolean | null;
  category: string | null;
  priority: string | null;
  needs_human_review: boolean | null;
  category_match: boolean | null;
  priority_match: boolean | null;
  confidence_category: number | null;
  confidence_priority: number | null;
  escalated: boolean;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

export type Confusion = Record<string, Record<string, number>>; // expected -> predicted -> count

export type SmokeSummary = {
  run_id: string;
  ts: string;
  file: string;
  dataset: DatasetId;
  labelled: boolean;
  sample_size: number;
  strategy: Strategy;
  prompt_version: string;
  config_id: string | null;
  llm_model: string | null;
  dm_model: string | null;
  models: string;
  outcomes: Record<string, number>;
  evaluated: number; // 200 responses with a label
  category_mismatches: number | null;
  priority_mismatches: number | null;
  category_accuracy: number | null;
  priority_accuracy: number | null;
  review_accuracy: number | null;
  escalations: number;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  total_latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
  category_confusion: Confusion | null;
  priority_confusion: Confusion | null;
  slices: Record<string, { n: number; category_accuracy: number | null; priority_accuracy: number | null }>;
};

export async function loadDataset(id: DatasetId): Promise<Ticket[]> {
  const file = id === "labelled100" ? "support_tickets_100_labelled.json" : "support_tickets_500.json";
  const text = await fs.readFile(path.join(process.cwd(), "data", file), "utf8");
  return JSON.parse(text) as Ticket[];
}

function sample<T>(items: T[], n: number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function emptyConfusion(labels: readonly string[]): Confusion {
  return Object.fromEntries(labels.map((e) => [e, Object.fromEntries(labels.map((p) => [p, 0]))]));
}

export function ticketText(t: Ticket): string {
  return `${t.subject}\n\n${t.body}`;
}

async function runOne(t: Ticket, strategy: Strategy, configId: string | undefined, runId: string): Promise<SmokeRow> {
  const labelled = t.category !== undefined;
  const base = {
    ticket_id: t.ticket_id,
    tags: (t.tags ?? "").split("|").filter(Boolean),
    expected_category: labelled ? t.category! : null,
    expected_priority: labelled ? t.priority! : null,
    expected_review: labelled ? Boolean(t.needs_human_review) : null,
  };
  const text = ticketText(t);
  const started = Date.now();
  if (text.length > MAX_TICKET_CHARS) {
    // Same rule as the API: rejected with 400 before any provider call.
    return {
      ...base,
      outcome: 400,
      error_code: "ticket_too_long",
      category: null,
      priority: null,
      needs_human_review: null,
      category_match: null,
      priority_match: null,
      confidence_category: null,
      confidence_priority: null,
      escalated: false,
      latency_ms: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    };
  }
  try {
    const r = await triageV2(text, strategy, configId, runId);
    return {
      ...base,
      outcome: 200,
      category: r.triage.category,
      priority: r.triage.priority,
      needs_human_review: r.triage.needs_human_review,
      category_match: labelled ? r.triage.category === t.category : null,
      priority_match: labelled ? r.triage.priority === t.priority : null,
      confidence_category: r.confidence?.category ?? null,
      confidence_priority: r.confidence?.priority ?? null,
      escalated: r.escalated,
      latency_ms: r.latency_ms,
      input_tokens: r.usage.input_tokens,
      output_tokens: r.usage.output_tokens,
      cost_usd: r.cost_usd,
    };
  } catch (error) {
    const e = toAppError(error);
    return {
      ...base,
      outcome: e.status,
      error_code: e.code,
      category: null,
      priority: null,
      needs_human_review: null,
      category_match: null,
      priority_match: null,
      confidence_category: null,
      confidence_priority: null,
      escalated: false,
      latency_ms: Date.now() - started,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    };
  }
}

export function summarise(
  rows: SmokeRow[],
  meta: Pick<SmokeSummary, "run_id" | "ts" | "file" | "dataset" | "strategy" | "prompt_version" | "config_id" | "llm_model" | "dm_model">,
): SmokeSummary {
  const labelled = meta.dataset === "labelled100";
  const outcomes: Record<string, number> = {};
  for (const r of rows) outcomes[String(r.outcome)] = (outcomes[String(r.outcome)] ?? 0) + 1;
  const ok = rows.filter((r) => r.outcome === 200);
  const evaluated = labelled ? ok : [];
  const catOk = evaluated.filter((r) => r.category_match).length;
  const prioOk = evaluated.filter((r) => r.priority_match).length;
  const reviewRows = evaluated.filter((r) => r.needs_human_review !== null);
  const reviewOk = reviewRows.filter((r) => r.needs_human_review === r.expected_review).length;

  let catConf: Confusion | null = null;
  let prioConf: Confusion | null = null;
  if (labelled) {
    catConf = emptyConfusion(CATEGORIES);
    prioConf = emptyConfusion(PRIORITIES);
    for (const r of evaluated) {
      if (r.expected_category && r.category) catConf[r.expected_category][r.category]++;
      if (r.expected_priority && r.priority) prioConf[r.expected_priority][r.priority]++;
    }
  }

  const slices: SmokeSummary["slices"] = {};
  if (labelled) {
    const tags = new Set(rows.flatMap((r) => r.tags));
    for (const tag of tags) {
      const tr = evaluated.filter((r) => r.tags.includes(tag));
      slices[tag] = {
        n: rows.filter((r) => r.tags.includes(tag)).length,
        category_accuracy: tr.length ? tr.filter((r) => r.category_match).length / tr.length : null,
        priority_accuracy: tr.length ? tr.filter((r) => r.priority_match).length / tr.length : null,
      };
    }
  }

  const latencies = ok.map((r) => r.latency_ms);
  const models = [meta.dm_model, meta.llm_model].filter(Boolean).join(" + ");
  return {
    ...meta,
    labelled,
    sample_size: rows.length,
    models,
    outcomes,
    evaluated: evaluated.length,
    category_mismatches: labelled ? evaluated.length - catOk : null,
    priority_mismatches: labelled ? evaluated.length - prioOk : null,
    category_accuracy: labelled && evaluated.length ? catOk / evaluated.length : null,
    priority_accuracy: labelled && evaluated.length ? prioOk / evaluated.length : null,
    review_accuracy: labelled && reviewRows.length ? reviewOk / reviewRows.length : null,
    escalations: rows.filter((r) => r.escalated).length,
    avg_latency_ms: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    p50_latency_ms: percentile(latencies, 50),
    p95_latency_ms: percentile(latencies, 95),
    total_latency_ms: latencies.reduce((a, b) => a + b, 0),
    input_tokens: rows.reduce((s, r) => s + r.input_tokens, 0),
    output_tokens: rows.reduce((s, r) => s + r.output_tokens, 0),
    total_cost_usd: rows.reduce((s, r) => s + r.cost_usd, 0),
    category_confusion: catConf,
    priority_confusion: prioConf,
    slices,
  };
}

export type SmokeEvent =
  | { type: "start"; run_id: string; total: number; strategy: Strategy; models: string }
  | { type: "row"; index: number; row: SmokeRow }
  | { type: "summary"; summary: SmokeSummary }
  | { type: "error"; error: string };

/** Run the smoke test; `emit` receives progress events (streamed to the page). */
export async function runSmoke(
  opts: { dataset: DatasetId; sampleSize: number; strategy: Strategy; configId?: string },
  emit: (e: SmokeEvent) => void,
): Promise<SmokeSummary> {
  const all = await loadDataset(opts.dataset);
  const n = Math.max(1, Math.min(all.length, Math.floor(opts.sampleSize)));
  const tickets = sample(all, n);
  const ts = new Date().toISOString();
  const runId = `run-${ts.replace(/[:.]/g, "-")}`;
  const llm = opts.strategy === "dm" ? null : getLlmConfig(opts.configId) ?? null;
  const dm = opts.strategy === "llm" ? null : getDmConfig() ?? null;
  const promptVersion = promptVersionFor(opts.strategy);
  const modelName = [dm?.model, llm?.model].filter(Boolean).join("+") || "unconfigured";
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._+-]+/g, "_");
  const file = `${ts.slice(0, 19).replace(/:/g, "-")}-${safe(promptVersion)}-${safe(modelName)}.json`;

  emit({ type: "start", run_id: runId, total: n, strategy: opts.strategy, models: modelName });

  const concurrency = Math.max(1, Number(process.env.SMOKE_CONCURRENCY) || 4);
  // Pause between two tickets of the same worker: keeps free tiers under their
  // requests-per-minute limit (e.g. SMOKE_CONCURRENCY=1, SMOKE_DELAY_MS=6500 ≈ 9 req/min).
  const delayMs = Math.max(0, Number(process.env.SMOKE_DELAY_MS) || 0);
  const rows: SmokeRow[] = new Array(n);
  let next = 0;
  async function worker() {
    while (next < n) {
      const i = next++;
      rows[i] = await runOne(tickets[i], opts.strategy, opts.configId, runId);
      emit({ type: "row", index: i, row: rows[i] });
      if (delayMs && next < n) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));

  const summary = summarise(rows, {
    run_id: runId,
    ts,
    file,
    dataset: opts.dataset,
    strategy: opts.strategy,
    prompt_version: promptVersion,
    config_id: llm?.id ?? null,
    llm_model: llm?.model ?? null,
    dm_model: dm?.model ?? null,
  });

  await fs.mkdir(RUNS_DIR, { recursive: true });
  await fs.writeFile(path.join(RUNS_DIR, file), JSON.stringify({ summary, rows }, null, 2), "utf8");
  await logRun(summary);
  emit({ type: "summary", summary });
  return summary;
}