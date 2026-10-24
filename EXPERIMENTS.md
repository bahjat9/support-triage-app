# Experiments

One row per experiment. Rows marked _fill in_ are to be completed with what you actually observe when running with your keys.
 Every prompt change is tied to an observed failure:
observed failure → hypothesis → prompt change → evaluation → keep / revert.

| Date | Prompt version | Provider / model | Ticket id | Observed output | Problem noticed | Change made |
|---|---|---|---|---|---|---|
| _fill in_ | triage-v1 | _your LLM_ | TCK-10001 | _paste the plain-text answer_ | _e.g. format varies between answers, code cannot check it_ | moved to triage-v2: JSON + Zod |
| _fill in_ | triage-v1 | _your LLM_ | TCK-10087 | _paste_ | injection ticket closes its own `</ticket>` tag | fake `<ticket>` tags are neutralised in `wrapTicket()`; trust rules added to the system prompt |
| _fill in_ | triage-v2 | _your LLM_ | adversarial tickets | _paste_ | does the schema hold under injection? | _record result_ |
| _fill in_ | triage-v2 | _your LLM_ | long ticket > 5,000 chars | 400 `ticket_too_long` | cost / output-length attack | rejected before any provider call |
| _fill in_ | dm-v1 | vllm-sr/d3-flash | labelled 100 | _paste summary_ | _e.g. how-to questions → feature_request_ | _e.g. criteria text for technical_bug mentions the how-to convention_ |
| _fill in_ | dm-v1+triage-v2 | d3-flash + _your LLM_ | labelled 100 | _paste summary_ | _escalation rate vs threshold_ | _threshold 0.6 → ?_ |
