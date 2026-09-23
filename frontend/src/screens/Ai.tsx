import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { Card, Empty, StatePill, Spinner } from '../components/ui.tsx';
import { AGENT_STEPS, stepIndex } from '../lib/steps.ts';
import type { AgentRun, Message, WsEvent } from '../api/types.ts';

export interface AgentProgress { phase: string; status: string; fixAttempts: number; maxFixAttempts: number }

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

  useEffect(() => { void load(); }, [load]);

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
    }
  }, [events, load, onAgentState]);

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
      const res = await api.runAgent(projectId, text);
      onAgentState({ phase: 'analyzing', status: 'running', fixAttempts: 0, maxFixAttempts: 5 });
      void res;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSteps([]);
    } finally {
      setBusy(false);
    }
  }, [prompt, projectId, onAgentState]);

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
      </Card>

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
