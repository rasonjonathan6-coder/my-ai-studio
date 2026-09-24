import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { Card, Empty, StatePill, bytes, when } from '../components/ui.tsx';
import type { SystemStatus, User } from '../api/types.ts';

interface SystemInfo extends SystemStatus {
  config: {
    env: string; maxFixAttempts: number; commandTimeoutMs: number; buildTimeoutMs: number;
    agentTimeoutMs: number; maxOutputBytes: number; maxFileBytes: number; maxConcurrentJobs: number;
    sandboxEnabled: boolean; sandboxImage: string; openRouterModel: string;
    workspaceRoot: string; storageRoot: string; jwtSecretGenerated: boolean;
  };
}

export function SettingsScreen({ user, onLogout }: { user: User; onLogout: () => Promise<void> }) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emulator, setEmulator] = useState<{ status: string; note: string; available: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([api.systemInfo(), api.emulator()]);
      setInfo(s as unknown as SystemInfo);
      setEmulator(e);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Settings</h1>
        <p>Server configuration and diagnostics. No secret value is ever returned.</p>
      </div>

      <Card title="Account">
        <div className="kv"><span>email</span><span>{user.email}</span></div>
        <div className="kv"><span>display name</span><span>{user.displayName ?? '-'}</span></div>
        <div className="kv"><span>member since</span><span>{when(user.createdAt)}</span></div>
        <button className="btn btn-danger btn-block" style={{ marginTop: 10 }} onClick={() => void onLogout()}>Sign out</button>
      </Card>

      {error && <p className="error-text" role="alert" style={{ marginTop: 10 }}>{error}</p>}

      <div style={{ marginTop: 12 }}>
        <Card title="Services" actions={<button className="btn btn-ghost btn-sm" onClick={() => void load()}>Reload</button>}>
          {!info && <Empty>Loading configuration.</Empty>}
          {info && (
            <>
              {info.probes.map((p) => (
                <div className="probe-row" key={p.name}>
                  <span className="probe-name">{p.name}</span>
                  <StatePill value={p.state} />
                  <span className="probe-detail">{p.version || p.detail || ''}</span>
                </div>
              ))}
              <div className="probe-row">
                <span className="probe-name">Android preview</span>
                <StatePill value={emulator?.available ? 'AVAILABLE' : 'NOT_AVAILABLE'} />
                <span className="probe-detail">{emulator?.note ?? ''}</span>
              </div>
            </>
          )}
        </Card>
      </div>

      {info && (
        <div style={{ marginTop: 12 }}>
          <Card title="Runtime configuration">
            <div className="kv"><span>environment</span><span>{info.config.env}</span></div>
            <div className="kv"><span>execution backend</span><span>{info.executionBackend}{info.config.sandboxEnabled ? ` (${info.config.sandboxImage})` : ''}</span></div>
            <div className="kv"><span>OpenRouter model</span><span>{info.config.openRouterModel}</span></div>
            <div className="kv"><span>max fix attempts</span><span>{info.config.maxFixAttempts}</span></div>
            <div className="kv"><span>command timeout</span><span>{info.config.commandTimeoutMs} ms</span></div>
            <div className="kv"><span>build timeout</span><span>{info.config.buildTimeoutMs} ms</span></div>
            <div className="kv"><span>agent timeout</span><span>{info.config.agentTimeoutMs} ms</span></div>
            <div className="kv"><span>max output</span><span>{bytes(info.config.maxOutputBytes)}</span></div>
            <div className="kv"><span>max file size</span><span>{bytes(info.config.maxFileBytes)}</span></div>
            <div className="kv"><span>max concurrent jobs</span><span>{info.config.maxConcurrentJobs}</span></div>
            <div className="kv"><span>workspace root</span><span>{info.config.workspaceRoot}</span></div>
            <div className="kv"><span>storage root</span><span>{info.config.storageRoot}</span></div>
            <div className="kv">
              <span>JWT secret</span>
              <span>{info.config.jwtSecretGenerated ? 'generated for this process (configure a secret in production)' : 'provided by environment'}</span>
            </div>
            <div className="kv"><span>jobs active / pending</span><span>{info.jobs.active} / {info.jobs.pending} of {info.jobs.max}</span></div>
          </Card>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Card title="Safety notes">
          <ul className="hint" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Every command runs inside the project workspace; paths escaping it are rejected.</li>
            <li>Secrets live only in server environment variables and are redacted from logs.</li>
            <li>Project access is authorised per user on every route and WebSocket subscribe.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
