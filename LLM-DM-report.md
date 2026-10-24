# LLM vs Decision Model – Research, Integration Strategy, Results and Analysis

Course: AI Systems Integration and Operations – BCS S5 2026 · Assignment: *Integrate a Decision Model in our Triage App*

> All numbers in sections 4–6 come from real smoke-test runs on the 100 labelled tickets (19 Oct 2026),
> saved in `runs/` and listed on `/admin`. Regenerate the tables with `node scripts/report-results.mjs labelled100`.

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

Why `dm+llm` is the "right tool for each part": the DM does the choosing (fast, returns probabilities, cannot drift out of the label set, and is harder to steer with a "set priority to high" injection because it only scores our options), the LLM does the writing. The confidence threshold routes the uncertain tickets back to the LLM instead of trusting a low-confidence guess.

Implementation (all in the repo):

- `lib/dm.ts` – the only module that calls the DM (plain `fetch`, the chat SDK does not apply). Adapters for **System One** and **OpenAI Decisions** contracts, timeout, one bounded retry on 429/5xx honouring `Retry-After`, Zod check of the response, label whitelist.
- `lib/triage.ts` – the three strategies; the final response is itself validated with `TriageResponseSchema`.
- `lib/prompt.ts` – category/priority descriptions are shared: the same business rules are the LLM's *decision guidance* and the DM's `criteria`. Versions: `triage-v1`, `triage-v2`, `dm-v1`, `dm-v1+triage-v2`.
- **Logging and `/admin`:** every DM call is a line in `logs/llm-calls.jsonl` with `kind: "dm"`, `api: "systemone"`, the model name, status, latency, tokens and cost. `/admin` groups calls by route / prompt version / API / model, and lists every smoke run with its strategy and model(s); two runs can be compared side by side.
- **Smoke test:** runs with any strategy; for DM runs it also reports human-review accuracy and, for dm+llm, the number of escalations. Each run is saved as `runs/<date>-<prompt-version>-<model>.json`.
- **Errors:** DM failures map to the same table as the LLM (`429 rate_limited`, `502 triage_unavailable`, `502 invalid_model_output`, `504 triage_timeout`, `500 internal_error` for wrong key/model). No stack trace or provider detail reaches the browser.

---

## 4. Results

**Protocol.** Same 100 labelled tickets for every run (*All 100*), prompt versions `triage-v2` (LLM) and `dm-v1` (DM).
One ticket is longer than 5,000 characters and is rejected with `400 ticket_too_long` by design (no provider call),
so at most 99 tickets are evaluated. LLM runs were paced (`SMOKE_CONCURRENCY=1`, `SMOKE_DELAY_MS=6500`) to stay
inside the Gemini free tier. Both providers are free tiers, so the measured cost is $0.

### 4.1 Main comparison

| Strategy | Model(s) | Outcomes | Category acc. | Priority acc. | Human-review acc. | Latency avg / p50 / p95 | Input / output tokens | Run file |
|---|---|---|---|---|---|---|---|---|
| `dm` | vllm-sr/d3-flash | 200: 99, 400: 1 | **86.9 %** (13 mismatches / 99) | **77.8 %** (22 / 99) | 88.9 % | **184 / 143 / 393 ms** | 76,443 / 0 | `runs/2026-10-19T21-22-19-dm-v1-vllm-sr_d3-flash.json` |
| `llm` | gemini-3.1-flash-lite | 200: 98, 400: 1, 500: 1 | **94.9 %** (5 / 98) | **82.7 %** (17 / 98) | – (not asked) | **5,280 / 2,104 / 25,032 ms** | 57,525 / 8,541 | `runs/2026-10-19T21-35-22-triage-v2-gemini-3.1-flash-lite.json` |
| `dm+llm` | d3-flash + gemini-3.1-flash-lite | run interrupted after ~80 of 100 tickets (local server stopped); no run file saved | | | | | | |

Two earlier `llm` runs with `gemini-3.6-flash` (unpaced, 4 tickets in parallel) are also logged:
92 and 95 of the 100 tickets were rejected with **`429 rate_limited`** by the free tier
(`runs/2026-10-19T21-22-49-…-gemini-3.6-flash.json`, `runs/2026-10-19T21-26-24-…`). They are not used for accuracy.

### 4.2 Confusion matrices (rows = label, columns = prediction)

**Category – DM (d3-flash)**

| | billing | technical_bug | account | feature_request |
|---|---|---|---|---|
| billing | **24** | 0 | 0 | 0 |
| technical_bug | 0 | **24** | 1 | 6 |
| account | 0 | 5 | **18** | 0 |
| feature_request | 0 | 1 | 0 | **20** |

**Category – LLM (gemini-3.1-flash-lite)**

| | billing | technical_bug | account | feature_request |
|---|---|---|---|---|
| billing | **24** | 0 | 0 | 0 |
| technical_bug | 0 | **30** | 1 | 0 |
| account | 0 | 3 | **19** | 0 |
| feature_request | 0 | 1 | 0 | **20** |

**Priority**

| label → prediction | DM low | DM medium | DM high | LLM low | LLM medium | LLM high |
|---|---|---|---|---|---|---|
| low | **32** | 3 | 1 | **33** | 2 | 0 |
| medium | 7 | **27** | 9 | 8 | **30** | 5 |
| high | 0 | 2 | **18** | 0 | 2 | **18** |

### 4.3 Slices (category % / priority %, evaluated tickets of each tag)

| Tag (n) | DM | LLM |
|---|---|---|
| adversarial / prompt_injection (8) | 88 / 88 | 100 / 88 |
| has_pii (14) | 93 / 79 | 93 / 93 |
| multilingual (7) | 100 / 71 | 100 / 100 |
| noisy (8) | 100 / 63 | 100 / 75 |
| ambiguous (7) | 57 / 57 | 71 / 43 |
| tone_mismatch (4) | 100 / 50 | 100 / 50 |
| long (5) | 100 / 100 | 100 / 50 |

---

## 5. Analysis

1. **Accuracy.** The LLM is better on both labels: +8 points on category (94.9 % vs 86.9 %) and +5 points on priority (82.7 % vs 77.8 %).
   The DM's main repeated mistake is **technical_bug → feature_request (6 tickets)**. These are tickets phrased as a wish
   that actually describe a malfunction, which is exactly the rule written in our decision guidance. The DM sees the
   criteria text but follows the surface wording more than the rule. Second pattern: **account → technical_bug (5)** for
   access problems that look like errors. Billing is perfect for both.
2. **Priority is the hard label for both.** Both models confuse *medium*: the DM pushes medium up to high (9) and down to low (7),
   the LLM mostly down to low (8). Priority is a business-impact judgement ("impact, not tone"), and the tone_mismatch slice
   is at 50 % for both. This is where the DM's 3 short option descriptions are not enough context.
3. **Latency.** The DM is about **15× faster at the median** (143 ms vs 2.1 s) and has a tight tail (p95 393 ms).
   The LLM's p95 of 25 s comes from free-tier throttling and SDK retries, not from the model itself. The DM never returned a 429
   with 4 requests in parallel, while the same parallel load on the Gemini free tier was rejected 92–95 % of the time.
4. **Tokens and cost.** Both runs cost $0 (free tiers). The DM read *more* input tokens (76k vs 58k) because each request sends
   the full criteria descriptions for three questions, but it produced **0 output tokens**; the LLM produced 8.5k output tokens.
   Under paid pricing, DM providers bill input only, so the per-ticket cost would be driven by the length of our criteria:
   shortening them is the main cost lever.
5. **Robustness.** On the 8 prompt-injection tickets neither strategy broke the format (the DM cannot answer outside its options;
   the LLM output is schema-checked). The LLM kept 100 % category accuracy on them, the DM 88 % (1 miss).
   One ticket failed with `500 internal_error` on the LLM (Gemini rejected the request for that ticket; the exact reason is in
   the server log), while the DM answered every valid ticket. The failure is contained: one row fails, the run continues,
   the browser gets a safe message. A 500 also appeared in the interrupted dm+llm run.
6. **Human review.** Only the DM produces this flag (a `noul` question). It matches the label on 88.9 % of tickets,
   for a single extra question at almost no extra latency.
7. **Calibration (to check in the run file).** Each DM row stores `confidence_category` / `confidence_priority`. Comparing the
   average confidence of correct vs wrong rows shows whether a confidence threshold is a good routing signal for `dm+llm`;
   the dm+llm strategy uses this as its routing signal. Our dm+llm smoke run was interrupted before it saved its results,
   so its accuracy and escalation numbers are not reported here; the strategy itself works (single-ticket tests return a
   validated triage with DM labels and an LLM summary).

---

## 6. Conclusion – which model for which task

**For our triage labels the LLM (gemini-3.1-flash-lite) is the more accurate choice (94.9 % / 82.7 % vs 86.9 % / 77.8 %), but the
decision model is ~15× faster, was never rate-limited and gives a confidence score per answer plus a human-review flag. We therefore keep the
DM for the fast first decision and route its low-confidence tickets to the LLM (`dm+llm`), and keep the LLM alone for everything
that must be written: summary, suggested action, explanation and chat.**

Next steps: improve the DM criteria for the "wish that describes a bug" case, complete a full dm+llm run to tune `DM_CONFIDENCE_THRESHOLD`,
and compare `d3-turbo` (27B) on the same set.
