import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { Card, Empty, StatePill, when } from '../components/ui.tsx';
import type { CredentialProbe, GithubCredential } from '../api/types.ts';

/**
 * Administers My AI Studio's own GitHub credential.
 *
 * The credential is write-only from the browser's point of view: it is sent to
 * the server once and is never returned, not even to an admin. What the panel
 * can show is a short fingerprint, the credential's shape and which source is
 * in play, which is enough to tell two credentials apart and to confirm that a
 * pasted value matches what is already stored.
 *
 * A credential entered here is stored encrypted in My AI Studio's database, so
 * it survives a restart and does not depend on anything the host environment
 * injects into a process.
 */
export function GithubCredentialCard({ isAdmin }: { isAdmin: boolean }) {
  const [info, setInfo] = useState<GithubCredential | null>(null);
  const [token, setToken] = useState('');
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [probe, setProbe] = useState<CredentialProbe | null>(null);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const c = await api.githubCredential();
      setInfo(c);
      setRepo(c.repo ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [isAdmin]);

  useEffect(() => { void load(); }, [load]);

  if (!isAdmin) {
    return (
      <div style={{ marginTop: 12 }}>
        <Card title="GitHub credential">
          <Empty>Administrator privileges are required to view or change the server GitHub credential.</Empty>
        </Card>
      </div>
    );
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onTest = () => run(async () => {
    const result = await api.testGithubCredential(token.trim(), repo.trim() || undefined);
    setProbe(result);
    setNotice(result.ok ? 'Credential verified against GitHub.' : 'Credential was rejected.');
  });

  const onSave = () => run(async () => {
    const result = await api.setGithubCredential(token.trim(), repo.trim() || undefined);
    setNotice(`Credential stored. Fingerprint ${result.fingerprint}.`);
    setToken('');
    setProbe(null);
    await load();
  });

  const onClear = () => run(async () => {
    await api.clearGithubCredential();
    setNotice('Stored credential removed.');
    setProbe(null);
    await load();
  });

  return (
    <div style={{ marginTop: 12 }}>
      <Card
        title="GitHub credential"
        actions={<button className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={busy}>Reload</button>}
      >
        {!info && <Empty>Loading credential state.</Empty>}
        {info && (
          <>
            <div className="kv"><span>status</span><span><StatePill value={info.configured ? 'AVAILABLE' : 'NOT_CONFIGURED'} /></span></div>
            <div className="kv"><span>source</span><span>{info.source}</span></div>
            <div className="kv"><span>credential kind</span><span>{info.tokenKind ?? '-'}</span></div>
            <div className="kv"><span>fingerprint</span><span className="mono">{info.fingerprint ?? '-'}</span></div>
            <div className="kv"><span>repository</span><span className="mono">{info.repo ?? '-'}</span></div>
            <div className="kv"><span>repository variable</span><span className="mono">{info.envVariable.replace('TOKEN', 'REPO')}</span></div>
            <div className="kv"><span>last changed</span><span>{info.updatedAt ? when(info.updatedAt) : '-'}</span></div>
            <p className="hint" style={{ marginTop: 6 }}>{info.detail}</p>
            <p className="hint" style={{ marginTop: 6 }}>
              Stored encrypted in My AI Studio's database and never returned to the browser. It survives
              a restart and is independent of any GITHUB_TOKEN the host environment injects.
            </p>

            <div className="field">
              <label htmlFor="gh-token">New credential (fine-grained PAT, Contents: write + Actions: write)</label>
              <input
                id="gh-token"
                className="input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={info.configured ? `leave blank to keep ${info.fingerprint ?? 'current'}` : 'github_pat_...'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="gh-repo">Repository (owner/name)</label>
              <input
                id="gh-repo"
                className="input"
                type="text"
                autoComplete="off"
                placeholder="owner/name"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              <button className="btn" disabled={busy || token.trim().length < 20} onClick={onTest}>Test</button>
              <button className="btn btn-primary" disabled={busy || token.trim().length < 20} onClick={onSave}>Save</button>
              <button className="btn btn-danger" disabled={busy || info.source !== 'database'} onClick={onClear}>Remove stored</button>
            </div>

            {probe && (
              <div style={{ marginTop: 10 }}>
                <div className="kv"><span>authenticated as</span><span>{probe.login ?? '-'}</span></div>
                <div className="kv"><span>scopes</span><span>{probe.scopes ?? 'fine-grained (no scope header)'}</span></div>
                <div className="kv"><span>can read</span><span>{String(probe.canRead)}</span></div>
                <div className="kv"><span>can write</span><span>{probe.canWrite === null ? 'not determined' : String(probe.canWrite)}</span></div>
                <div className="kv"><span>actions</span><span>{probe.actions === null ? 'not determined' : String(probe.actions)}</span></div>
                <div className="kv"><span>matches stored</span><span>{String(probe.matchesStored)}</span></div>
                {probe.error && <p className="hint">{probe.error}</p>}
              </div>
            )}
          </>
        )}
        {notice && <p className="hint" role="status" style={{ marginTop: 8 }}>{notice}</p>}
        {error && <p className="error-text" role="alert" style={{ marginTop: 8 }}>{error}</p>}
      </Card>
    </div>
  );
}
