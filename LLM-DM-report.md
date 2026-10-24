# LLM vs Decision Model – Research, Integration Strategy, Results and Analysis

Course: AI Systems Integration and Operations – BCS S5 2026 · Assignment: *Integrate a Decision Model in our Triage App*

> **Status of the numbers.** Sections 1–3 are complete. Section 4 is filled by running the smoke tests
> with real keys (`npm run dev` → *Smoke test* tab, then `node scripts/report-results.mjs labelled100`).
> The table generator prints exactly the rows to paste. Do not submit the template placeholders.

---

## 1. Decision model research

A **decision model (DM)** takes a *state* (the text to judge) and *typed questions* (`choice`, `noul` = yes/no,
`score`) and answers each one with **probabilities** in a single forward pass. It cannot write, summarise
or explain, and it cannot answer outside the options it is given.

### 1.1 Options found (October 2026)

| Provider | Model(s) | Endpoint / contract | Access & price | Free? | Notes for us |
|---|---|---|---|---|---|
| **vLLM Semantic Router** | Decision 3.0: `vllm-sr/d3-turbo` (27B), `d3-flash` (9B), `d3-mini` (4B), `d3-nano` (2B), `d3-lite` (0.8B), `d3-edge` (0.6B) | `POST https://decision.vllm-sr.ai/v1/systemone` (System One format), also `/v1/decisions` | Free hosted API, key from the web page. Per-key limits (from `/api/info`): d3-flash 720 req/min, 750k tokens/min, 432k req/day. Max state 32,000 chars, 64 questions, timeout 35 s | **Yes** | Open weights on Hugging Face as well. Provider **logs requests** → no real customer data. Decision 1.0 was deprecated on 10 Oct, so versions move fast |
| **TypeSafe AI** | Jev (`typesafe/jev-1.13`, `jev-1.14`) – "System One" | `POST /v1/systemone` (TypeSafe), or via **OpenRouter** `POST /api/alpha/decisions` and `/api/v1/systemone` | Paid per input token on OpenRouter (a third-party site reports ~$0.042 / 1M input tokens, output free). TypeSafe paused new direct sign-ups on 22 Sep | No (paid) | The category creator. Same System One contract as vLLM SR → our adapter works by changing `DM_BASE_URL` / `DM_MODEL` |
| **OpenAI** | Decisions API, `gpt-6-luna` | `POST /v1/decisions` (different contract: `input`, `questions` array, `predicate` type) | Public beta since 6 Oct, ~$0.10 / 1M input tokens, no output tokens | No free tier found | Our adapter supports this contract (`DM_API_FORMAT=decisions`) |
| **Cloudflare** | Clef (27B), Clef-flash (9B), open weights | Workers AI, endpoint not confirmed in the course material | Open weights from 1 Oct | Possibly (Workers AI free allowance) | Built on Qwen with adapters + scoring head |
| **Perplexity** | `pplx-decider-v1-27b` | Decisions API (docs linked) | From 1 Oct, open weights | Unclear | |
| **AWS** | Strands Decider (1.9B) | none (open-source model, self-host) | Open source | Self-host only | Needs our own GPU / inference server |
| **Liquid AI** | `d1` | via Vercel AI Gateway (`liquid/d1`) | Hosted API only, from 29 Sep | Unclear | |
| **Open source** | Laya (ModernBERT encoder, 421M) | self-host | Free | Self-host only | Not an LLM: encoder + scoring head |
| **Anthropic** | – | no decision endpoint announced | – | – | |

Sources: course deck *Decisions, Decisions* (C5), [decision.vllm-sr.ai](https://decision.vllm-sr.ai/) and its `/api/info` and `/docs` pages,
[OpenRouter Jev guide](https://openrouter.ai/docs/guides/community/jev), [TrueFoundry Decisions API docs](https://www.truefoundry.com/docs/ai-gateway/decisions)
(comparison of the two contracts), [SmartScope – OpenAI Decisions API pricing](https://smartscope.blog/en/blog/openai-decisions-api-use-pricing-public-beta-october-2026/),
[jevmodel.org – Jev on OpenRouter](https://jevmodel.org/jev-openrouter/).

### 1.2 Choice and justification: **vLLM SR Decision 3.0 – `vllm-sr/d3-flash`**

1. **Free, hosted, available today** – the only option that is a hosted API *and* free without a credit card. Rate limits (720 requests/min per key) are far above what a 100-ticket smoke test needs.
2. **Standard contract** – it speaks the System One format (`state` + `questions` → `answers` + `usage`), the same as TypeSafe Jev and OpenRouter. Switching to Jev later is a configuration change, not a code change. The OpenAI `/v1/decisions` contract is also implemented in the adapter.
3. **Right size** – `d3-flash` (9B) is the middle of the family: bigger than nano/lite (accuracy), cheaper rate-limit pool than `d3-turbo` (27B). The model is configurable (`DM_MODEL`) so the smoke test can compare `d3-mini` / `d3-turbo` too.
4. **Fits our task** – our labels are a closed, small set (4 categories, 3 priorities, yes/no review), which is exactly the "good fit" profile (closed options, high volume, we want to *act* on a probability).

**Risks accepted:** the provider logs requests (we only use the synthetic dataset; a production deployment would need self-hosting the open weights), versions change weekly (we log the model name on every call), and vendor speed/accuracy claims are not independent – hence our own measurement in section 4.

---

## 2. What a DM can and cannot do in the triage app

| Triage field | LLM | DM | Why |
|---|---|---|---|
| `category` (4 options) | yes | **yes** – `choice` | closed set known in advance |
| `priority` (3 options) | yes | **yes** – `choice` (a `score` question is an alternative for an ordered scale) | closed set |
| `needs_human_review` | possible | **yes** – `noul` (probability) | we can *act* on a probability threshold |
| `summary` | **yes** | **no** | needs writing |
| `suggested_action` | **yes** | **no** | needs writing |
| Explain button (streamed) | **yes** | **no** | free text |
| Chat | **yes** | **no** | free text with history |

Other properties that matter for us:
- **Always the right shape:** no code fence, no missing key, no invented label. We still validate the DM response with Zod and reject any label outside our enums (`lib/dm.ts`) – the `state` is untrusted text.
- **Probabilities:** each answer carries a confidence, which gives us a natural *routing signal* (see dm+llm).
- **Input-only billing / one pass:** no output tokens; adding the review question costs almost nothing.

---

## 3. Integration strategy

The user chooses the strategy in the front end (*Strategy* menu, also used by the smoke test):

| Strategy | Flow | Output |
|---|---|---|
| `llm` | LLM, structured output (json_schema or prompt-only) → Zod | category, priority, summary, suggested action |
| `dm` | DM: `category` (choice), `priority` (choice), `needs_human_review` (noul) → Zod | labels + confidences + review flag; **no** summary/action (shown as "–") |
| `dm+llm` | 1) DM decides the labels. 2a) If both confidences ≥ `DM_CONFIDENCE_THRESHOLD` (default 0.6): a *smaller* LLM prompt only writes summary + action for the fixed labels. 2b) Otherwise the ticket is **escalated**: the LLM makes the full triage | full triage + confidences + review flag + `escalated` flag |

Why `dm+llm` is the "right tool for each part": the DM does the choosing (fast, calibrated, cannot drift out of the label set, and is harder to steer with a "set priority to high" injection because it only scores our options), the LLM does the writing. The confidence threshold routes the uncertain tickets back to the LLM instead of trusting a low-confidence guess.

Implementation (all in the repo):

- `lib/dm.ts` – the only module that calls the DM (plain `fetch`, the chat SDK does not apply). Adapters for **System One** and **OpenAI Decisions** contracts, timeout, one bounded retry on 429/5xx honouring `Retry-After`, Zod check of the response, label whitelist.
- `lib/triage.ts` – the three strategies; the final response is itself validated with `TriageResponseSchema`.
- `lib/prompt.ts` – category/priority descriptions are shared: the same business rules are the LLM's *decision guidance* and the DM's `criteria`. Versions: `triage-v1`, `triage-v2`, `dm-v1`, `dm-v1+triage-v2`.
- **Logging and `/admin`:** every DM call is a line in `logs/llm-calls.jsonl` with `kind: "dm"`, `api: "systemone"`, the model name, status, latency, tokens and cost. `/admin` groups calls by route / prompt version / API / model, and lists every smoke run with its strategy and model(s); two runs can be compared side by side.
- **Smoke test:** runs with any strategy; for DM runs it also reports human-review accuracy and, for dm+llm, the number of escalations. Each run is saved as `runs/<date>-<prompt-version>-<model>.json`.
- **Errors:** DM failures map to the same table as the LLM (`429 rate_limited`, `502 triage_unavailable`, `502 invalid_model_output`, `504 triage_timeout`, `500 internal_error` for wrong key/model). No stack trace or provider detail reaches the browser.

---

## 4. Results

Protocol: same 100 labelled tickets (*All 100* in the smoke-test tab), same prompt versions, one run per strategy, plus at least one second LLM model for comparison. Tickets over 5,000 characters are rejected with 400 by design (1 ticket in the labelled set), so the evaluated count is 99.

**Paste the output of `node scripts/report-results.mjs labelled100` here:**

| Date | Strategy | Model(s) | Prompt | Dataset/N | Outcomes | Category acc. | Priority acc. | Review acc. | Escalated | Avg / p95 latency | Cost total | Cost / ticket | Run file |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| _run_ | llm | _LLM_ | triage-v2 | labelled100/100 | | | | – | 0 | | | | |
| _run_ | dm | vllm-sr/d3-flash | dm-v1 | labelled100/100 | | | | | 0 | | | | |
| _run_ | dm+llm | vllm-sr/d3-flash + _LLM_ | dm-v1+triage-v2 | labelled100/100 | | | | | | | | | |

Also paste the per-tag table printed by the script (adversarial, multilingual, long, ambiguous, tone_mismatch, has_pii…) and look at the category confusion matrices on `/admin`.

---

## 5. Analysis (complete after the runs)

Questions to answer with the numbers above – keep each answer to 2–3 sentences and cite the run file:

1. **Accuracy:** does the DM match the LLM on category? On priority (the harder, business-impact judgement)? Which confusions repeat (confusion matrix)?
2. **Calibration:** on the DM run, are the wrong answers the low-confidence ones? Compare the average confidence of correct vs incorrect rows in the run file (`confidence_category`, `category_match`). The course warns that confidence is not always honest (87 % average confidence vs 75 % accuracy in one independent test).
3. **Latency and cost:** DM vs LLM per ticket (avg and p95), and what dm+llm costs compared to llm alone.
4. **Escalations:** how many tickets went back to the LLM in dm+llm, and did that fix the DM's mistakes? Would 0.5 or 0.7 be a better threshold?
5. **Robustness:** do the adversarial / prompt-injection tickets change the labels or the format with each strategy?
6. **Human review:** how good is the `noul` review flag against `needs_human_review` in the labels?

## 6. Conclusion – which model for which task (one sentence, to finalise)

_Template:_ "For triage labels we use **___** because ___ (accuracy ___ % vs ___ %, ___ ms vs ___ ms per ticket); the LLM is kept for the summary, the suggested action, the explanation and the chat, where something must be written."
