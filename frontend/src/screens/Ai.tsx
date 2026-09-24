import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { Card, Empty, StatePill, Spinner } from '../components/ui.tsx';
import { FreeModelsPanel } from '../components/FreeModels.tsx';
import { AGENT_STEPS, stepIndex } from '../lib/steps.ts';
import type { AgentRun, AiProvider, AiProvidersResponse, Message, ProviderId, ProviderSelection, WsEvent } from '../api/types.ts';

export interface AgentProgress { phase: string; status: string; fixAttempts: number; maxFixAttempts: number }

const PROVIDER_LABEL: Record<string, string> = {
  auto: 'AUTO',
  openrouter: 'OpenRouter', gemini: 'Gemini', groq: 'Groq', cerebras: 'Cerebras',
  mistral: 'Mistral', cloudflare: 'Cloudflare', nvidia: 'NVIDIA', huggingface: 'Hugging Face',
  chutes: 'Chutes', sambanova: 'SambaNova', ollama: 'Ollama (local)', vllm: 'vLLM (local)',
};

export function AiScreen({ projectId, socketConnected, events, onAgentState }: {
  projectId: string;
  socketConnected: boolean;
  events: WsEvent[];
  onAgentState: (state: AgentProgress | null) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [steps, setSteps] = useState<Array<{ key: string; state: 'pending' | 'active' | 'done' | 'failed' }>>([]);
  const [agentState, setAgentState] = useState<AgentProgress | null>(null);
  const [providers, setProviders] = useState<AiProvidersResponse | null>(null);
  const [provider, setProvider] = useState<ProviderSelection>('auto');
  const bottomRef = useRef<HTMLDivElement>(null);

  // Push progress upward so the workspace header can show the real phase.
  useEffect(() => { onAgentState(agentState); }, [agentState, onAgentState]);

  const load = useCallback(async () => {
    try {
      const res = await api.conversation(projectId);
      setMessages(res.messages);
      const runs = await api.agentRuns(projectId);
      const latest = runs.runs[0] ?? null;
      setRun(latest);
      if (latest) {
        setSteps(deriveSteps(latest));
        onAgentState({
          phase: latest.phase,
          status: latest.status,
          fixAttempts: latest.fix_attempts,
          maxFixAttempts: latest.max_fix_attempts,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId, onAgentState]);

  // Real provider configuration read from the server, refreshed when a run ends
  // so a cooldown that just started is reflected.
  const loadProviders = useCallback(async () => {
    try {
      const res = await api.aiProviders();
      setProviders(res);
      if (res.defaultProvider) setProvider((prev) => (prev === 'auto' ? (res.defaultProvider as ProviderSelection) : prev));
    } catch {
      // The provider panel is informational; a failure here must not blank the chat.
      setProviders(null);
    }
  }, []);

  useEffect(() => { void load(); void loadProviders(); }, [load, loadProviders]);

  // Apply real agent_status frames as they arrive over the socket.
  useEffect(() => {
    const relevant = events.filter((e) => e.type === 'agent_status' || e.type === 'agent_log');
    if (relevant.length === 0) return;
    const last = relevant[relevant.length - 1];
    const phase = (last.phase ?? last.data?.phase) as string | undefined;
    const status = (last.data?.status as string | undefined) ?? undefined;
    if (phase) {
      setSteps((prev) => advanceSteps(prev, phase, status));
      setAgentState((prev) => ({
        phase,
        status: status ?? prev?.status ?? 'running',
        fixAttempts: (last.data?.fixAttempts as number | undefined) ?? prev?.fixAttempts ?? 0,
        maxFixAttempts: (last.data?.maxFixAttempts as number | undefined) ?? prev?.maxFixAttempts ?? 5,
      }));
    }
    if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
      void load();
      void loadProviders();
    }
  }, [events, load, loadProviders, onAgentState]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, events.length]);

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    setPrompt('');
    // Optimistically show the user's own message; everything else comes from the server.
    setMessages((prev) => [...prev, {
      id: `local-${Date.now()}`, role: 'user', content: text, metadata: null, created_at: new Date().toISOString(),
    }]);
    setSteps(AGENT_STEPS.map((s, i) => ({ key: s.key, state: i === 0 ? 'active' : 'pending' })));
    try {
      const res = await api.runAgent(projectId, text, provider);
      onAgentState({ phase: 'analyzing', status: 'running', fixAttempts: 0, maxFixAttempts: 5 });
      void res;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSteps([]);
    } finally {
      setBusy(false);
    }
  }, [prompt, projectId, onAgentState, provider]);

  const cancel = useCallback(async () => {
    if (!run) return;
    try {
      await api.cancelAgent(projectId, run.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [run, projectId, load]);

  const active = run?.status === 'running' || run?.status === 'queued';

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>AI</h1>
        <p>Ask for a change. The agent uses real tools on the server workspace.</p>
      </div>

      <Card
        title="Agent"
        actions={(
          <div className="row">
            <StatePill value={run ? (active ? 'RUNNING' : run.status) : 'IDLE'} />
            <StatePill value={socketConnected ? 'CONNECTED' : 'DOWN'} />
            {active && <button className="btn btn-danger btn-sm" onClick={() => void cancel()}>Cancel</button>}
          </div>
        )}
        subtitle={run ? `model ${run.model} · fix attempts ${run.fix_attempts}/${run.max_fix_attempts}` : 'No run yet for this project.'}
      >
        {steps.length === 0 && <Empty>Send a request to start an agent run.</Empty>}
        {steps.length > 0 && (
          <ul className="step-list">
            {steps.map((s) => {
              const step = AGENT_STEPS.find((x) => x.key === s.key);
              return (
                <li key={s.key} className={`step ${s.state === 'done' ? 'done' : s.state === 'active' ? 'active' : s.state === 'failed' ? 'failed' : ''}`}>
                  <span className="step-ico" aria-hidden="true">
                    {s.state === 'done' ? '✓' : s.state === 'failed' ? '✕' : s.state === 'active' ? '▸' : '·'}
                  </span>
                  <span>{step?.label ?? s.key}</span>
                  {s.state === 'active' && <span className="spinner" aria-hidden="true" />}
                </li>
              );
            })}
          </ul>
        )}
        {run?.error && <p className="error-text" role="alert" style={{ marginTop: 10 }}>{run.error}</p>}
        {run?.summary && <p style={{ marginTop: 10, fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{run.summary}</p>}
        {run?.provider && (
          <p className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
            served by {PROVIDER_LABEL[run.provider] ?? run.provider}
            {run.failover_from ? ` (failed over from ${PROVIDER_LABEL[run.failover_from] ?? run.failover_from})` : ''}
          </p>
        )}
      </Card>

      <div style={{ marginTop: 12 }}>
        <ProviderPanel
          providers={providers}
          selected={provider}
          onSelect={setProvider}
          disabled={active}
          onChanged={() => void loadProviders()}
          onError={setError}
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <FreeModelsPanel providers={providers} onError={setError} />
      </div>

      <div style={{ marginTop: 12 }}>
        <Card title="Conversation" actions={<button className="btn btn-ghost btn-sm" onClick={() => void load()}>Reload</button>}>
          {messages.length === 0 && <Empty>No messages yet.</Empty>}
          <div className="chat">
            {messages.map((m) => (
              <div key={m.id} className={`msg msg-${m.role}`}>
                {m.content}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {error && <p className="error-text" role="alert" style={{ marginTop: 8 }}>{error}</p>}

          <div className="composer">
            <label className="sr-only" htmlFor="ai-prompt">Message to the agent</label>
            <textarea
              id="ai-prompt" className="textarea" value={prompt} placeholder="e.g. Add a power() function with a unit test"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
              }}
            />
            <button className="btn btn-primary" onClick={() => void send()} disabled={busy || !prompt.trim()}>
              {busy ? 'Sending.' : 'SEND'}
            </button>
          </div>
          {busy && <div style={{ marginTop: 6 }}><Spinner /></div>}
        </Card>
      </div>
    </div>
  );
}

export function ProviderPanel({ providers, selected, onSelect, disabled, onChanged, onError }: {
  providers: AiProvidersResponse | null;
  selected: ProviderSelection;
  onSelect: (p: ProviderSelection) => void;
  disabled: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [probing, setProbing] = useState(false);

  // The Test button sends a real completion request, so it costs quota. The
  // warning is shown before the click rather than reported after.
  const test = useCallback(async (id: string) => {
    setTesting(id);
    try {
      const res = await api.testAiProvider(id);
      const detail = res.result === 'PASS'
        ? `PASS · HTTP ${res.http} · ${res.durationMs}ms`
        : res.result === 'NOT_CONFIGURED'
          ? 'NOT CONFIGURED'
          : `FAIL · ${res.classification ?? res.kind ?? 'error'}${res.http ? ` · HTTP ${res.http}` : ''}`;
      setResults((prev) => ({ ...prev, [id]: detail }));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(null);
    }
  }, [onError]);

  const reset = useCallback(async (id: string) => {
    try {
      await api.resetAiProvider(id);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [onChanged, onError]);

  // The auto probe walks the whole failover chain, so the result is the real
  // sequence of providers that were tried, in order.
  const autoProbe = useCallback(async () => {
    setProbing(true);
    try {
      const res = await api.autoProbeAi();
      const trail = res.attempts.map((a) => `${a.provider}:${a.outcome}`).join(' -> ');
      setResults((prev) => ({
        ...prev,
        auto: res.ok
          ? `PASS · answered by ${res.answeredBy}${res.failoverFrom ? ` (failed over from ${res.failoverFrom})` : ''} · ${trail}`
          : `FAIL · ${trail || 'no provider attempted'}`,
      }));
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  }, [onChanged, onError]);

  const options: ProviderSelection[] = ['auto', ...(providers?.priority ?? []) as ProviderId[]];

  // States carry the observed facts; the summary list carries configuration.
  const stateById = new Map((providers?.providerStates ?? []).map((s) => [s.id, s]));

  const statusOf = (p: AiProvider): { label: string; tone: 'ok' | 'warn' | 'off' } => {
    const st = stateById.get(p.id);
    if (!p.configured) return { label: 'NOT CONFIGURED', tone: 'off' };
    if (p.cooling) return { label: 'COOLING DOWN', tone: 'warn' };
    if (st?.available) return { label: 'AVAILABLE', tone: 'ok' };
    return { label: 'NOT TESTED', tone: 'warn' };
  };

  return (
    <Card
      title="AI engine"
      subtitle="Keys stay on the server. AUTO fails over only on temporary provider limits."
      actions={<StatePill value={providers?.auto.ready.length ? `READY ${providers.auto.ready.length}` : 'NO PROVIDER READY'} />}
    >
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <label className="sr-only" htmlFor="ai-provider">AI provider</label>
        <select
          id="ai-provider" className="select" value={selected} disabled={disabled}
          onChange={(e) => onSelect(e.target.value as ProviderSelection)}
        >
          {options.map((o) => <option key={o} value={o}>{PROVIDER_LABEL[o] ?? (providers?.providers.find((p) => p.id === o)?.label ?? o)}</option>)}
        </select>
        <button
          className="btn btn-ghost btn-sm"
          disabled={disabled || probing}
          onClick={() => void autoProbe()}
          title="Runs one real request through AUTO and may consume quota on each provider tried."
        >
          {probing ? 'Probing' : 'Test AUTO'}
        </button>
        {disabled && <span className="muted" style={{ fontSize: 12.5 }}>A run is active; provider is fixed for it.</span>}
      </div>

      {providers && (
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
          Would use now: <strong>{providers.current.label ?? 'none'}</strong>
          {providers.current.model ? ` · ${providers.current.model}` : ''} — {providers.current.reason}
        </p>
      )}

      {!providers && <Empty>Provider status unavailable.</Empty>}
      {providers && (
        <ul className="step-list">
          {providers.providers.map((p) => {
            const st = stateById.get(p.id);
            const s = statusOf(p);
            return (
            <li key={p.id} className="step">
              <span className={`dot ${s.tone}`} aria-hidden="true" />
              <span>
                {p.label}
                <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>{s.label}</span>
                <span className="muted" style={{ marginLeft: 6, fontSize: 11.5, opacity: 0.85 }}>
                  {p.tier === 'free' ? 'FREE' : 'PAID'}
                </span>
                {st && st.lastStatusCode !== null && (
                  <span className="muted" style={{ marginLeft: 6, fontSize: 11.5 }}>
                    · {st.lastStatusCode === 429 ? 'RATE_LIMITED' : st.available ? 'AVAILABLE' : 'NOT_AVAILABLE'}
                  </span>
                )}
                {p.cooling && st?.cooldownStrike ? (
                  <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>· backoff x{st.cooldownStrike}</span>
                ) : null}
                {st && st.requestCount > 0 && (
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                    {st.requestCount} req ({st.successCount} ok / {st.failureCount} failed)
                  </span>
                )}
                {st && st.rateLimitRemainingRequests !== null && (
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                    · {st.rateLimitRemainingRequests} req left
                    {st.rateLimitResetAt ? ` (reset ${new Date(st.rateLimitResetAt).toLocaleTimeString()})` : ''}
                  </span>
                )}
                {st?.lastError && (
                  <span className="muted" style={{ display: 'block', fontSize: 11.5, marginTop: 2 }}>
                    last error: {st.lastError}
                  </span>
                )}
                {p.capabilities && !p.capabilities.agent && (
                  <span className="muted" style={{ display: 'block', fontSize: 11.5, marginTop: 2 }}>
                    {p.capabilities.agentNote ?? 'CHAT_ONLY'}
                  </span>
                )}
                {results[p.id] && <span className="muted" style={{ display: 'block', fontSize: 12 }}>{results[p.id]}</span>}
              </span>
              <span className="row" style={{ marginLeft: 'auto', gap: 6 }}>
                {p.cooling && (
                  <button className="btn btn-ghost btn-sm" onClick={() => void reset(p.id)}>Reset</button>
                )}
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={!p.configured || testing === p.id}
                  onClick={() => void test(p.id)}
                  title="This test uses one real API request and may consume your quota."
                >
                  {testing === p.id ? 'Testing' : 'Test API'}
                </button>
              </span>
            </li>
            );
          })}
        </ul>
      )}
      {providers && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Test API sends one real request and may consume your quota; Test AUTO may send one per
          provider tried. Counts above are requests this server actually sent. Remaining quota is
          shown only when a provider reported it; otherwise it stays unknown.
        </p>
      )}
      {providers && providers.recentAttempts.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>Recent provider attempts</summary>
          <ul className="step-list" style={{ marginTop: 6 }}>
            {providers.recentAttempts.slice(-10).reverse().map((a, i) => (
              <li key={`${a.at}-${i}`} className="step">
                <span className={`dot ${a.outcome === 'ok' ? 'ok' : a.outcome === 'fallback' ? 'warn' : 'off'}`} aria-hidden="true" />
                <span className="muted" style={{ fontSize: 12 }}>
                  {a.provider} · {a.outcome}{a.status ? ` · HTTP ${a.status}` : ''}
                  {a.classification ? ` · ${a.classification}` : ''} · {new Date(a.at).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function deriveSteps(run: AgentRun): Array<{ key: string; state: 'pending' | 'active' | 'done' | 'failed' }> {
  const idx = stepIndex(run.phase);
  return AGENT_STEPS.map((s, i) => ({
    key: s.key,
    state: run.status === 'succeeded'
      ? 'done'
      : run.status === 'failed' && i === Math.max(idx, 0)
        ? 'failed'
        : i < idx
          ? 'done'
          : i === idx
            ? run.status === 'running' || run.status === 'queued' ? 'active' : 'pending'
            : 'pending',
  }));
}

function advanceSteps(
  prev: Array<{ key: string; state: 'pending' | 'active' | 'done' | 'failed' }>,
  phase: string,
  status: string | undefined,
): Array<{ key: string; state: 'pending' | 'active' | 'done' | 'failed' }> {
  if (status === 'succeeded') {
    return (prev.length ? prev : AGENT_STEPS.map((s) => ({ key: s.key, state: 'pending' as const })))
      .map((s) => ({ ...s, state: 'done' as const }));
  }
  if (status === 'failed' || status === 'cancelled') {
    return (prev.length ? prev : AGENT_STEPS.map((s) => ({ key: s.key, state: 'pending' as const })))
      .map((s) => (s.state === 'active' ? { ...s, state: 'failed' as const } : s));
  }

  const idx = stepIndex(phase);
  if (idx < 0) return prev;
  const base = prev.length ? prev : AGENT_STEPS.map((s) => ({ key: s.key, state: 'pending' as const }));
  // 'fixing' means a rebuild cycle: mark earlier steps done and re-activate the fix step.
  return base.map((s, i) => ({
    ...s,
    state: i < idx ? 'done' : i === idx ? 'active' : 'pending',
  }));
}
