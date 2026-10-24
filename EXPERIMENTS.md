# Experiments

One row per experiment. Every change is tied to an observed failure:
observed failure → hypothesis → change → evaluation → keep / revert. Run files are in `runs/`.

| Date | Prompt version | Provider / model | Ticket id / set | Observed output | Problem noticed | Change made |
|---|---|---|---|---|---|---|
| 2026-10-19 | triage-v2 | Gemini `gemini-2.5-flash` | any | every call → 500 `internal_error` | the model was shut down by Google on 16 Oct (provider answers "not found") | model moved to configuration value `gemini-3.6-flash` |
| 2026-10-19 | triage-v2 | Gemini `gemini-3.6-flash` | labelled 100, 4 in parallel | 200: 6, 429: 92, 502: 1 | free tier requests-per-minute limit | added `SMOKE_CONCURRENCY` / `SMOKE_DELAY_MS` pacing |
| 2026-10-19 | triage-v2 | Gemini `gemini-3.6-flash` | labelled 100 | 200: 4, 429: 95; a single request after 25 s idle still 429 | daily quota of the free tier used up | switched to `gemini-3.1-flash-lite` (separate quota) |
| 2026-10-19 | triage-v2 | Gemini `gemini-3.1-flash-lite` | labelled 100, paced | category 94.9 %, priority 82.7 %, 1 × 500 | priority: medium → low (8 tickets) | keep; next: sharpen the *medium* definition in `PRIORITY_GUIDANCE` |
| 2026-10-19 | dm-v1 | vLLM SR `d3-flash` | labelled 100 | category 86.9 %, priority 77.8 %, review 88.9 %, 184 ms avg | technical_bug → feature_request (6): wishes describing a malfunction | next: move the "wish that describes a malfunction" rule into the `feature_request` criteria too (dm-v2) |
| 2026-10-19 | dm-v1 | vLLM SR `d3-flash` | adversarial slice (8) | 7/8 category correct, format always valid | injection cannot change the answer format | keep (labels whitelisted in `lib/dm.ts`) |
| 2026-10-19 | triage-v2 | Gemini `gemini-3.1-flash-lite` | adversarial slice (8) | 8/8 category, 7/8 priority, schema always valid | fake `</ticket>` tag closing attempts | keep (`wrapTicket()` neutralises fake tags) |
| 2026-10-19 | – | – | ticket > 5,000 chars | 400 `ticket_too_long`, no provider call | cost / output-length attack | keep |
| 2026-10-20 | dm-v1+triage-v2 | d3-flash + gemini-3.1-flash-lite | labelled 100, paced | ~80 tickets processed, mostly 200 (1 × 500, 1 × 502) | run interrupted when the local server was stopped: results are only saved at the end of a run | next: save partial runs, then complete a full run to tune the 0.6 threshold |
