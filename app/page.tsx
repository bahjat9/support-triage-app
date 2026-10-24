"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import ChatPanel from "./ui/ChatPanel";
import TriagePanel from "./ui/TriagePanel";
import SmokePanel from "./ui/SmokePanel";
import type { Strategy } from "@/lib/schema";

export type Configs = {
  llm: { id: string; label: string; structuredMode: string }[];
  dm: { label: string; apiFormat: string; threshold: number } | null;
  maxTicketChars: number;
};

type Tab = "chat" | "triage" | "smoke";

export default function Home() {
  const [tab, setTab] = useState<Tab>("triage");
  const [configs, setConfigs] = useState<Configs | null>(null);
  const [configId, setConfigId] = useState<string>("");
  const [strategy, setStrategy] = useState<Strategy>("llm");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/configs")
      .then((r) => r.json())
      .then((c: Configs) => {
        setConfigs(c);
        setConfigId(c.llm[0]?.id ?? "");
      })
      .catch(() => setLoadError("Could not load the server configuration."));
  }, []);

  const strategyNeedsLlm = strategy !== "dm";
  const strategyNeedsDm = strategy !== "llm";
  const notReady =
    !!configs && ((strategyNeedsLlm && configs.llm.length === 0) || (strategyNeedsDm && !configs.dm));

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <h1>Support Triage</h1>
          <p className="muted">Kestrel Analytics support desk</p>
        </div>
        <Link href="/admin" className="adminlink">
          /admin
        </Link>
      </header>

      <section className="settings" aria-label="Model settings">
        <label>
          LLM model
          <select value={configId} onChange={(e) => setConfigId(e.target.value)} disabled={!configs?.llm.length}>
            {configs?.llm.length ? (
              configs.llm.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.structuredMode})
                </option>
              ))
            ) : (
              <option value="">no LLM configured</option>
            )}
          </select>
        </label>
        <label>
          Strategy
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as Strategy)}>
            <option value="llm">LLM only</option>
            <option value="dm">Decision model only</option>
            <option value="dm+llm">Decision model + LLM</option>
          </select>
        </label>
        <p className="muted small">
          Decision model: {configs?.dm ? `${configs.dm.label} (${configs.dm.apiFormat}, escalate below ${configs.dm.threshold})` : "not configured"}
        </p>
        {notReady && <p role="alert">This strategy needs a model that is not configured on the server.</p>}
        {loadError && <p role="alert">{loadError}</p>}
      </section>

      <nav className="tabs" role="tablist">
        {(["chat", "triage", "smoke"] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "tab active" : "tab"}
            onClick={() => setTab(t)}
          >
            {t === "chat" ? "Chat" : t === "triage" ? "Triage" : "Smoke test"}
          </button>
        ))}
      </nav>

      {tab === "chat" && <ChatPanel configId={configId} />}
      {tab === "triage" && (
        <TriagePanel configId={configId} strategy={strategy} maxChars={configs?.maxTicketChars ?? 5000} />
      )}
      {tab === "smoke" && <SmokePanel configId={configId} strategy={strategy} />}
    </main>
  );
}
