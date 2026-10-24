// Prints a Markdown comparison table of all smoke runs (logs/smoke-runs.jsonl),
// ready to paste into LLM-DM-report.md and README.md:
//   node scripts/report-results.mjs            (all runs)
//   node scripts/report-results.mjs labelled100 (only one dataset)
import { readFileSync } from "node:fs";

const filter = process.argv[2];
let runs = [];
try {
  runs = readFileSync("logs/smoke-runs.jsonl", "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
} catch {
  console.error("No logs/smoke-runs.jsonl yet: run a smoke test first.");
  process.exit(1);
}
if (filter) runs = runs.filter((r) => r.dataset === filter);

const pct = (n) => (n === null || n === undefined ? "–" : `${(n * 100).toFixed(1)}%`);
const usd = (n) => (n === 0 ? "$0" : `$${n.toFixed(n < 0.01 ? 6 : 4)}`);
const out = (o) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(" ");

console.log("| Date | Strategy | Model(s) | Prompt | Dataset/N | Outcomes | Category acc. | Priority acc. | Review acc. | Escalated | Avg / p95 latency | Cost total | Cost / ticket | Run file |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of runs) {
  console.log(
    `| ${r.ts.slice(0, 16).replace("T", " ")} | ${r.strategy} | ${r.models} | ${r.prompt_version} | ${r.dataset}/${r.sample_size} | ${out(r.outcomes)} | ${pct(r.category_accuracy)} | ${pct(r.priority_accuracy)} | ${pct(r.review_accuracy)} | ${r.escalations} | ${r.avg_latency_ms} / ${r.p95_latency_ms} ms | ${usd(r.total_cost_usd)} | ${usd(r.sample_size ? r.total_cost_usd / r.sample_size : 0)} | runs/${r.file} |`,
  );
}

// Slices (per tag) for the labelled runs
const labelled = runs.filter((r) => r.labelled);
if (labelled.length) {
  const tags = [...new Set(labelled.flatMap((r) => Object.keys(r.slices || {})))].sort();
  console.log("\n**Category / priority accuracy per tag**\n");
  console.log(`| Tag | ${labelled.map((r) => `${r.strategy} (${r.models})`).join(" | ")} |`);
  console.log(`|---|${labelled.map(() => "---").join("|")}|`);
  for (const t of tags) {
    console.log(
      `| ${t} | ${labelled
        .map((r) => {
          const s = r.slices?.[t];
          return s ? `${pct(s.category_accuracy)} / ${pct(s.priority_accuracy)} (n=${s.n})` : "–";
        })
        .join(" | ")} |`,
    );
  }
}
