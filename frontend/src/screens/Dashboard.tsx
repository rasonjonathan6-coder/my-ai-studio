import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { Card, StatePill, Stat, bytes, when } from '../components/ui.tsx';
import type { Project, SystemStatus } from '../api/types.ts';

export function Dashboard({ projects, onOpen, onRefresh, wsConnected }: {
  projects: Project[];
  onOpen: (id: string) => void;
  onRefresh: () => void;
  wsConnected: boolean | null;
}) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ builds: number; tests: number; apks: number; agents: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.systemStatus();
      setStatus(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Aggregate real counters from the projects the user owns.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let builds = 0;
      let succeeded = 0;
      let apks = 0;
      let agents = 0;
      for (const p of projects.slice(0, 20)) {
        const [b, artifacts, runs] = await Promise.all([
          api.builds(p.id).catch(() => ({ builds: [] })),
          api.artifacts(p.id).catch(() => ({ artifacts: [] })),
          api.agentRuns(p.id).catch(() => ({ runs: [] })),
        ]);
        builds += b.builds.length;
        succeeded += b.builds.filter((x) => x.status === 'succeeded').length;
        apks += artifacts.artifacts.filter((x) => x.kind === 'apk').length;
        agents += runs.runs.filter((x) => x.status === 'running' || x.status === 'queued').length;
      }
      if (!cancelled) setStats({ builds, tests: succeeded, apks, agents });
    })();
    return () => { cancelled = true; };
  }, [projects]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Dashboard</h1>
        <p>Live state reported by the backend. Nothing shown here is simulated.</p>
      </div>

      <div className="grid grid-auto">
        <Stat value={projects.length} label="Projects" />
        <Stat value={stats ? stats.agents : '-'} label="Running agents" />
        <Stat value={stats ? stats.builds : '-'} label="Builds" />
        <Stat value={stats ? stats.tests : '-'} label="Builds ok" />
        <Stat value={stats ? stats.apks : '-'} label="APKs" />
        <Stat
          value={<StatePill value={status ? (status.executionBackend === 'docker' ? 'AVAILABLE' : 'NOT_AVAILABLE') : null} />}
          label={`Sandbox (${status?.executionBackend ?? '-'})`}
        />
      </div>

      {error && <p className="error-text" role="alert" style={{ marginTop: 12 }}>system status: {error}</p>}

      <Card
        title="System status"
        subtitle={status ? `Probed at ${when(status.generatedAt)}` : 'Loading real probes.'}
        actions={<button className="btn btn-ghost btn-sm" onClick={() => { void load(); onRefresh(); }}>Refresh</button>}
      >
        {!status && <p className="hint">Waiting for /api/system/status.</p>}
        {status && (
          <>
            {status.probes.map((p) => (
              <div className="probe-row" key={p.name}>
                <span className="probe-name">{p.name}</span>
                <StatePill value={p.state} />
                <span className="probe-detail" title={p.detail ?? ''}>{p.version || p.detail || ''}</span>
              </div>
            ))}
            <div className="grid grid-3" style={{ marginTop: 12 }}>
              <div className="stat">
                <div className="stat-value">{status.host.cpuCount}</div>
                <div className="stat-label">CPU cores</div>
              </div>
              <div className="stat">
                <div className="stat-value">{bytes(status.host.freeMemBytes)}</div>
                <div className="stat-label">Free memory</div>
              </div>
              <div className="stat">
                <div className="stat-value">{status.disk ? bytes(status.disk.freeBytes) : 'n/a'}</div>
                <div className="stat-label">Free disk</div>
              </div>
            </div>
          </>
        )}
      </Card>

      <Card
        title="Projects"
        subtitle={`${projects.length} workspace${projects.length === 1 ? '' : 's'} owned by you`}
        actions={<button className="btn btn-ghost btn-sm" onClick={onRefresh}>Reload</button>}
      >
        {projects.length === 0 && <p className="empty">No projects yet. Create one from the Projects tab.</p>}
        {projects.slice(0, 6).map((p) => (
          <button key={p.id} className="file-row" onClick={() => onOpen(p.id)}>
            <span aria-hidden="true">{p.kind === 'android' ? '📱' : '📁'}</span>
            <span className="file-path">{p.name}</span>
            <span className="pill pill-dim">{p.template}</span>
          </button>
        ))}
      </Card>

      <Card title="Realtime" subtitle="Agent, terminal and build events stream over WebSocket.">
        <div className="row">
          <StatePill value={wsConnected === null ? 'unknown' : wsConnected ? 'CONNECTED' : 'DOWN'} />
          <span className="hint">
            {wsConnected === null
              ? 'Open a project to subscribe to its event channel.'
              : wsConnected
                ? 'Subscribed to the current project channel.'
                : 'Disconnected - the client will retry with backoff.'}
          </span>
        </div>
      </Card>
    </div>
  );
}
