import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { Card, Empty, StatePill, bytes } from '../components/ui.tsx';
import type { CommandResult, WsEvent } from '../api/types.ts';

const QUICK = ['ls -la', 'git status', 'node --version', 'java -version', './gradlew --version'];

export function TerminalScreen({ projectId, events }: { projectId: string; events: WsEvent[] }) {
  const [entries, setEntries] = useState<CommandResult[]>([]);
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<string[]>([]);
  const outRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.terminalHistory(projectId);
      setEntries(res.commands);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  // Stream command_log frames into a live buffer while a command is running.
  useEffect(() => {
    const frames = events.filter((e) => e.type === 'command_log');
    if (frames.length === 0) return;
    const last = frames[frames.length - 1];
    if (last.data?.phase === 'start') setLive([`$ ${last.message}`]);
    else setLive((prev) => [...prev.slice(-400), last.message]);
    if (last.data?.phase === 'end') void load();
  }, [events, load]);

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [entries.length, live.length]);

  const run = useCallback(async (cmd: string) => {
    const c = cmd.trim();
    if (!c) return;
    setBusy(true);
    setError(null);
    setCommand('');
    try {
      const res = await api.terminal(projectId, c);
      setEntries((prev) => [res, ...prev].slice(0, 30));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Terminal</h1>
        <p>Commands execute on the server in this project&apos;s workspace directory.</p>
      </div>

      <Card title="Run a command" subtitle="Output below is the real stdout, stderr and exit code.">
        <form
          className="row"
          onSubmit={(e) => { e.preventDefault(); void run(command); }}
        >
          <label className="sr-only" htmlFor="term-cmd">Shell command</label>
          <span className="mono" aria-hidden="true" style={{ color: 'var(--cyan)' }}>$</span>
          <input
            id="term-cmd" className="input mono" style={{ flex: 1, minWidth: 180 }} value={command}
            placeholder="npm install" autoComplete="off" spellCheck={false}
            onChange={(e) => setCommand(e.target.value)}
          />
          <button className="btn btn-primary" type="submit" disabled={busy || !command.trim()}>
            {busy ? 'Running.' : 'Run'}
          </button>
        </form>

        <div className="row" style={{ marginTop: 10 }}>
          {QUICK.map((q) => (
            <button key={q} className="btn btn-ghost btn-sm mono" onClick={() => void run(q)} disabled={busy}>{q}</button>
          ))}
        </div>

        {error && <p className="error-text" role="alert" style={{ marginTop: 10 }}>{error}</p>}
      </Card>

      {live.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Card title="Live stream" subtitle="Frames pushed over WebSocket during the current command.">
            <div className="term" ref={outRef} aria-live="polite">{live.join('\n')}</div>
          </Card>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Card title="History" actions={<button className="btn btn-ghost btn-sm" onClick={() => void load()}>Reload</button>}>
          {entries.length === 0 && <Empty>No commands recorded for this project.</Empty>}
          {entries.map((entry) => (
            <div key={entry.id} style={{ marginBottom: 14 }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="mono" style={{ color: 'var(--cyan)' }}>$ {entry.command}</span>
                <StatePill value={entry.status.toUpperCase()} />
                <span className="hint">
                  exit {entry.exitCode ?? 'n/a'} · {entry.durationMs} ms · {entry.backend}
                  {entry.truncated ? ' · output truncated' : ''}
                  {entry.timedOut ? ' · timed out' : ''}
                </span>
              </div>
              <div className="term">
                {entry.stdout && <span>{entry.stdout}</span>}
                {entry.stderr && <span className="err">{entry.stderr}</span>}
                {!entry.stdout && !entry.stderr && <span className="meta">(no output)</span>}
              </div>
              <div className="hint" style={{ marginTop: 4 }}>cwd: {entry.cwd} · {bytes((entry.stdout.length + entry.stderr.length))} of output</div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
