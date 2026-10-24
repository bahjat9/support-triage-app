// Offline mock of an OpenAI-compatible LLM and a System One decision model.
// Lets you exercise the whole app (UI, errors, smoke test, /admin) without keys:
//   node scripts/mock-providers.mjs        (listens on http://localhost:4010)
// then in .env.local:
//   LLM_BASE_URL=http://localhost:4010/v1  LLM_API_KEY=mock  LLM_MODEL=mock-llm
//   DM_BASE_URL=http://localhost:4010      DM_API_KEY=mock   DM_MODEL=mock-dm
// The "intelligence" is a keyword heuristic: numbers are NOT meaningful.
// Model name "mock-broken" returns 404, "mock-garbage" returns invalid JSON.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 4010);

function classify(text) {
  const t = text.toLowerCase();
  let category = "technical_bug";
  if (/invoice|refund|charge|billing|payment|vat|price|po number|factur/.test(t)) category = "billing";
  else if (/password|login|log in|sso|2fa|permission|role|seat|access|account/.test(t)) category = "account";
  else if (/would be nice|feature|could you add|please add|wish|suggest|support for/.test(t)) category = "feature_request";
  let priority = "medium";
  if (/urgent|down|outage|all users|production|deadline|security|breach|compromis/.test(t)) priority = "high";
  else if (/minor|cosmetic|how do i|how to|small|would be nice|feature/.test(t)) priority = "low";
  return { category, priority };
}

function words(s) {
  return Math.ceil(s.length / 4);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return send(res, 400, { error: { message: "bad json" } });
    }
    const delay = 50 + Math.random() * 150;
    setTimeout(() => {
      if (body.model === "mock-broken") return send(res, 404, { error: { message: "model not found" } });

      if (req.url.endsWith("/chat/completions")) {
        const msgs = body.messages || [];
        const system = msgs.find((m) => m.role === "system")?.content || "";
        const user = msgs.filter((m) => m.role !== "system").map((m) => m.content).join("\n");
        const input = words(system + user);
        let content;
        if (body.model === "mock-garbage") content = "Sure! Here is the triage: category billing";
        else if (system.includes("already been classified")) {
          content = JSON.stringify({ summary: "Customer reports: " + user.slice(10, 90).replace(/\s+/g, " "), suggested_action: "Acknowledge and route to the owning team." });
        } else if (system.includes("support-triage component") && system.includes("JSON")) {
          const c = classify(user);
          content = JSON.stringify({ ...c, summary: "Customer reports: " + user.slice(10, 90).replace(/\s+/g, " "), suggested_action: "Reproduce the issue and reply to the customer." });
          if (system.includes("no code fence")) content = "```json\n" + content + "\n```";
        } else if (system.includes("support-triage component")) {
          const c = classify(user);
          content = `Category: ${c.category}\nPriority: ${c.priority}\nSummary: mock summary\nSuggested action: mock action`;
        } else if (system.includes("explain")) {
          content = "The ticket describes a concrete problem, so the category fits. The business impact described sets the priority. (mock explanation)";
        } else {
          const last = msgs[msgs.length - 1]?.content || "";
          const name = msgs.map((m) => m.content).join(" ").match(/my name is (\w+)/i);
          content = /what is my name/i.test(last) && name ? `Your name is ${name[1]}.` : `(mock) You said: ${last}`;
        }
        const output = words(content);
        if (body.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const parts = content.match(/.{1,12}/gs) || [];
          let i = 0;
          const tick = () => {
            if (i < parts.length) {
              res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { content: parts[i++] }, finish_reason: null }] })}\n\n`);
              setTimeout(tick, 40);
            } else {
              res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: body.model, choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } })}\n\n`);
              res.end("data: [DONE]\n\n");
            }
          };
          return tick();
        }
        return send(res, 200, {
          id: "mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
        });
      }

      if (req.url.endsWith("/v1/systemone")) {
        if (!body.state || !body.questions) return send(res, 400, { error: { type: "invalid_request", code: "invalid_request", message: "state and questions required" } });
        const c = classify(body.state);
        const probs = (labels, chosen) => {
          const p = 0.55 + Math.random() * 0.44;
          const rest = (1 - p) / (labels.length - 1);
          return Object.fromEntries(labels.map((l) => [l, l === chosen ? p : rest]));
        };
        const cat = probs(Object.keys(body.questions.category.criteria), c.category);
        const pri = probs(Object.keys(body.questions.priority.criteria), c.priority);
        return send(res, 200, {
          model: body.model,
          answers: {
            category: { type: "choice", choice: c.category, confidence: cat[c.category], probabilities: cat },
            priority: { type: "choice", choice: c.priority, confidence: pri[c.priority], probabilities: pri },
            needs_human_review: { type: "noul", noul: /security|compromis|ignore previous|instructions/i.test(body.state) ? 0.8 : 0.1 },
          },
          usage: { input_tokens: words(body.state) + 120, output_tokens: 0 },
        });
      }
      send(res, 404, { error: { message: "unknown route " + req.url } });
    }, delay);
  });
});

server.listen(PORT, () => console.log(`mock providers on http://localhost:${PORT}`));
