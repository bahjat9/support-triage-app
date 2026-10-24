# Support Ticket Triage App – LLM + Decision Model

Full triage app for the *AI Systems Integration and Operations* course (BCS S5 2026), built from
[`bcs-s5-2026/triage-base`](https://github.com/bcs-s5-2026/triage-base).

| Feature | Where |
|---|---|
| Chat with memory (the page resends the whole history; `system` messages from the browser → 400) | *Chat* tab, `app/api/chat/route.ts` |
| Triage v1 – plain text, prompt `triage-v1` | *Triage* tab → Version v1 |
| Triage v2 – JSON contract with Zod (`lib/schema.ts`), json_schema or prompt-only mode | *Triage* tab → Version v2 |
| **F1** request and response follow a JSON schema, validated with Zod; clear errors in the UI | `lib/schema.ts`, `lib/errors.ts` |
| **F2** token usage (input / output / total) under every result, plus cost and latency | *Triage* tab |
| **F3** smoke test from the front end: dataset (labelled 100 / 500), sample size, live results, predicted vs labelled, mismatch summary, confusion matrices | *Smoke test* tab, `lib/smoke.ts` |
| **F4** every run logged (accuracy, outcome counts, latency, cost, model) and listed on `/admin` | `logs/smoke-runs.jsonl`, `runs/*.json`, `/admin` |
| **F5** model menu (up to 3 server-side configurations), side-by-side comparison of two runs on `/admin` | *LLM model* menu, `/admin` checkboxes |
| **Decision model** integration with user-selectable strategy `llm` / `dm` / `dm+llm`; smoke test and `/admin` support it | *Strategy* menu, `lib/dm.ts`, `lib/triage.ts` |
| Explain button (streamed, for the support agent) | *Triage* tab, `app/api/triage/explain/route.ts` |
| Report | [`LLM-DM-report.md`](./LLM-DM-report.md), [`EXPERIMENTS.md`](./EXPERIMENTS.md) |

## Run locally

Requires Node.js 20.9+.

```sh
npm install
cp .env.example .env.local    # then fill in your keys
npm run dev                    # http://localhost:3033  –  /admin for the logs
```

### Configuration (`.env.local`)

- `LLM_*` – default LLM (any OpenAI-compatible endpoint: Gemini's OpenAI endpoint, the school server, OpenAI…).
  `LLM2_*`, `LLM3_*` add more entries to the model menu. `*_STRUCTURED_OUTPUT=json_schema|prompt`.
  Prices per 1M tokens (`*_PRICE_INPUT_PER_M`, `*_PRICE_OUTPUT_PER_M`) are configuration, not code.
- `DM_*` – decision model. Default: **vLLM Semantic Router Decision 3.0** free API,
  `DM_BASE_URL=https://decision.vllm-sr.ai`, `DM_MODEL=vllm-sr/d3-flash`, key from <https://decision.vllm-sr.ai/keys>.
  `DM_API_FORMAT=systemone` (also works for TypeSafe Jev / OpenRouter) or `decisions` (OpenAI contract).
  `DM_CONFIDENCE_THRESHOLD` controls escalation in `dm+llm`.

### Try it without any key (offline mock)

```sh
node scripts/mock-providers.mjs      # fake LLM + fake decision model on :4010
# .env.local:
# LLM_BASE_URL=http://localhost:4010/v1  LLM_API_KEY=mock  LLM_MODEL=mock-llm
# DM_BASE_URL=http://localhost:4010      DM_API_KEY=mock   DM_MODEL=mock-dm
```

The mock uses keyword rules – its accuracy numbers mean nothing. `LLM_MODEL=mock-broken` → 404 (tests the 500 path),
`mock-garbage` → invalid JSON (tests retry + 502). Delete `logs/*.jsonl` and `runs/*.json` after playing with it.

### Report table

```sh
node scripts/report-results.mjs labelled100   # Markdown table of all smoke runs, ready to paste
```

## API

| Route | Body | Answer |
|---|---|---|
| `POST /api/chat` | `{ messages: [{role:"user"|"assistant", content}], configId? }` | `{ answer, model, usage }` |
| `POST /api/triage` | `{ ticket, version?: "v1"|"v2", strategy?: "llm"|"dm"|"dm+llm", configId? }` | v1: `{ text, usage… }` · v2: validated `TriageResponse` |
| `POST /api/triage/explain` | `{ ticket, triage, configId? }` | streamed text |
| `POST /api/smoke` | `{ dataset: "labelled100"|"all500", sampleSize, strategy, configId? }` | NDJSON stream: `start`, `row`…, `summary` |
| `GET /api/configs` | – | configuration ids and labels only (never URLs or keys) |

### Error policy

| Failure | Status | Retry |
|---|---|---|
| Invalid request, empty ticket, ticket > 5,000 chars | `400 invalid_request` / `ticket_too_long` (no provider call) | no |
| Invalid JSON / schema mismatch from the model (LLM or DM) | `502 invalid_model_output` | once, logged |
| Provider 429 | `429 rate_limited` | SDK backoff (`maxRetries=1`) / DM honours `Retry-After` |
| Provider 5xx or network | `502 triage_unavailable` | bounded (1) |
| Timeout (per attempt) | `504 triage_timeout` | if time remains (SDK) |
| Wrong key, model or parameter | `500 internal_error` | no |

## Architecture

```
app/page.tsx ─ ui/ChatPanel · ui/TriagePanel · ui/SmokePanel        (browser: no SDK, no key)
app/api/*    ─ validate request (Zod) → lib/triage.ts → lib/llm.ts (OpenAI SDK, only LLM caller)
                                                     → lib/dm.ts  (fetch, only DM caller)
lib/prompt.ts  prompts + PROMPT_VERSION      lib/schema.ts  contracts
lib/log.ts     logs/llm-calls.jsonl, logs/smoke-runs.jsonl       lib/smoke.ts  runs/*.json
app/admin      reads the logs: calls grouped by route/prompt/API/model, runs + comparison
```

## Quality checklist (Activity 7)

**Architecture**
- [x] One LLM module (`lib/llm.ts`) and one DM module (`lib/dm.ts`); routes only call them, no SDK call in components.
- [x] Prompts live in one place (`lib/prompt.ts`) with a version constant.
- [x] All provider settings come from configuration (`lib/config.ts` reads `.env.local`); nothing hard-coded.

**Error handling**
- [x] Every failure maps to one status and one safe message (`lib/errors.ts`).
- [x] Timeouts and retries set explicitly (`LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `DM_TIMEOUT_MS`).
- [x] No stack trace or provider detail reaches the browser (details only in server logs).

**Security**
- [x] Keys only used on the server (`server-only` imports); `/api/configs` exposes ids and labels only.
- [x] `.env.local` ignored by git (`git check-ignore -v .env.local`).
- [x] Over-long input rejected with 400 before any provider call.
- [x] Logs contain no key and no ticket text (ids, tokens, latency, status, model only).
- [x] Injection: ticket wrapped in `<ticket>` tags with fake tags neutralised, trust rules in the prompt, output constrained by schema/enums; DM labels whitelisted. Verify with the adversarial slice of the smoke test.
- [x] Fixed during review: invalid model outputs were first logged as `200`; they are now logged as `502 invalid_model_output` so `/admin` counts them as errors.

## Model comparison (Activity 8 / 10)

Paste the output of `node scripts/report-results.mjs labelled100` (see `LLM-DM-report.md` section 4) and write
three differences you observed (model name, structured-output support, latency, tokens, error messages).
