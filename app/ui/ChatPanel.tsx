"use client";

import { useState, type FormEvent } from "react";
import { postJson } from "./api";

type Message = { role: "user" | "assistant"; content: string };

// The conversation lives only in the page (reloading clears it, by design).
// Each request resends the whole history because the API is stateless.
export default function ChatPanel({ configId }: { configId: string }) {
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTokens, setLastTokens] = useState<string | null>(null);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSending || !text.trim()) return;
    const history: Message[] = [...messages, { role: "user", content: text }];
    setIsSending(true);
    setError(null);
    try {
      const data = await postJson<{
        answer: string;
        model: string;
        usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
      }>("/api/chat", { messages: history, configId: configId || undefined });
      setMessages([...history, { role: "assistant", content: data.answer }]);
      setLastTokens(
        data.usage
          ? `${data.model} · input ${data.usage.input_tokens} · output ${data.usage.output_tokens} · total ${data.usage.total_tokens} tokens`
          : `${data.model} · usage not reported`,
      );
      setText("");
    } catch (e) {
      // Keep the previous messages so the user can retry.
      setError(e instanceof Error ? e.message : "Unable to send your message.");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <section className="panel">
      <div className="row space">
        <h2>Chat</h2>
        <button type="button" className="secondary" onClick={() => setMessages([])} disabled={!messages.length}>
          New conversation
        </button>
      </div>
      <div className="messages" role="log" aria-label="Chat messages" aria-live="polite">
        {messages.length === 0 && <p className="muted">No messages yet. Try: “My name is Sam”, then “What is my name?”.</p>}
        {messages.map((m, i) => (
          <div className={`message ${m.role}`} key={i}>
            <strong>{m.role === "user" ? "You" : "Assistant"}</strong>
            <p>{m.content}</p>
          </div>
        ))}
      </div>
      {lastTokens && <p className="muted small">Last answer: {lastTokens}</p>}
      <form onSubmit={send} aria-busy={isSending}>
        <label htmlFor="message">Your message</label>
        <textarea
          id="message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask the support assistant..."
          rows={3}
          disabled={isSending}
        />
        <button type="submit" disabled={isSending || !text.trim()}>
          {isSending ? "Sending..." : "Send"}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
