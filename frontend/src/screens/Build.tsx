import { useCallback, useEffect, useState } from 'react';
import { api, downloadUrl } from '../api/client.ts';
import { Card, Empty, StatePill, bytes, when } from '../components/ui.tsx';
import type { ApkInspection, BuildResult, SecurityScan, SystemStatus, WsEvent } from '../api/types.ts';

interface TestSummary {
  status: string; framework: string | null; command: string | null;
  passed: number; failed: number; skipped: number; durationMs: number; log: string; error: string | null;
}

export function BuildScreen({ projectId, events }: { projectId: string; events: WsEvent[] }) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [test, setTest] = useState<TestSummary | null>(null);
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [scan, setScan] = useState<SecurityScan | null>(null);
  const [inspection, setInspection] = useState<ApkInspection | null>(null);
  const [busy, setBusy] = useState<{ test?: boolean; build?: boolean; scan?: boolean }>({});
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.systemStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadArtifacts = useCallback(async () => {
    try {
      const [artifacts, builds] = await Promise.all([
        api.artifacts(projectId),
        api.builds(projectId),
      ]);
      const apk = artifacts.artifacts.find((a) => a.kind === 'apk');
      const latest = builds.builds.find((b) => b.status === 'succeeded');
      if (latest && apk) {
        const detail = await api.getBuild(projectId, latest.id).catch(() => null);
        if (detail) {
          setBuild(detail.build);
          setInspection(detail.build.inspection);
          setScan(detail.build.security);
        }
      }
    } catch {
      // A project with no artifacts yet is not an error.
    }
  }, [projectId]);

  useEffect(() => { void loadStatus(); void loadArtifacts(); }, [loadStatus, loadArtifacts]);

  // Build and test log frames for this project, streamed live.
  useEffect(() => {
    const frames = events.filter((e) => e.type === 'build_log' || e.type === 'test_log');
    if (frames.length === 0) return;
    const last = frames[frames.length - 1];
    setLogs((prev) => [...prev.slice(-500), `[${last.level ?? 'info'}] ${last.message}`]);
  }, [events]);

  const runTests = async () => {
    setBusy((b) => ({ ...b, test: true }));
    setError(null);
    try {
      const res = await api.runTests(projectId);
      setTest(res.test);
      await loadArtifacts();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((b) => ({ ...b, test: false }));
    }
  };

  const runBuild = async (target: 'debug' | 'release') => {
    setBusy((b) => ({ ...b, build: true }));
    setError(null);
    setLogs([]);
    try {
      const res = await api.build(projectId, target);
      setBuild(res.build);
      setInspection(res.build.inspection);
      setScan(res.build.security);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((b) => ({ ...b, build: false }));
    }
  };

  const runScan = async () => {
    setBusy((b) => ({ ...b, scan: true }));
    setError(null);
    try {
      const res = await api.securityScan(projectId);
      setScan(res.scan);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((b) => ({ ...b, scan: false }));
    }
  };

  const apkReady = !!build?.apk;

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Build Center</h1>
        <p>Real toolchain probes, real tests, real APK builds.</p>
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}

      <Card title="Environment" actions={<button className="btn btn-ghost btn-sm" onClick={() => void loadStatus()}>Re-probe</button>}>
        {!status && <Empty>Probing the toolchain.</Empty>}
        {status?.probes.map((p) => (
          <div className="probe-row" key={p.name}>
            <span className="probe-name">{p.name}</span>
            <StatePill value={p.state} />
            <span className="probe-detail">{p.version || p.detail || ''}</span>
          </div>
        ))}
      </Card>

      <div style={{ marginTop: 12 }}>
        <Card
          title="Tests"
          subtitle="Runs the project's own test task and parses real JUnit XML."
          actions={<button className="btn btn-primary btn-sm" onClick={() => void runTests()} disabled={busy.test}>{busy.test ? 'Running.' : 'RUN TESTS'}</button>}
        >
          {!test && <Empty>No test run in this session. Use RUN TESTS.</Empty>}
          {test && (
            <>
              <div className="grid grid-3">
                <div className="stat"><div className="stat-value">{test.passed}</div><div className="stat-label">Passed</div></div>
                <div className="stat"><div className="stat-value">{test.failed}</div><div className="stat-label">Failed</div></div>
                <div className="stat"><div className="stat-value">{(test.durationMs / 1000).toFixed(1)}s</div><div className="stat-label">Duration</div></div>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <StatePill value={test.status.toUpperCase()} />
                <span className="hint mono">{test.command ?? 'no command'}</span>
              </div>
              {test.error && <p className="error-text" style={{ marginTop: 8 }}>{test.error}</p>}
              {test.log && <pre className="term" style={{ maxHeight: '32vh', marginTop: 10 }}>{test.log.slice(-12000)}</pre>}
            </>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 12 }}>
        <Card
          title="Android"
          subtitle="Gradle assembleDebug runs on the server. The APK path is verified on disk."
          actions={(
            <div className="row">
              <button className="btn btn-primary btn-sm" onClick={() => void runBuild('debug')} disabled={busy.build}>
                {busy.build ? 'Building.' : 'BUILD DEBUG APK'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => void runBuild('release')} disabled={busy.build}>Release</button>
            </div>
          )}
        >
          {!build && <Empty>No build in this session yet.</Empty>}
          {build && (
            <>
              <div className="row">
                <StatePill value={build.status.toUpperCase()} />
                <span className="hint mono">{build.command ?? 'no command'}</span>
              </div>
              <div className="kv"><span>exit code</span><span>{build.exitCode ?? 'n/a'}</span></div>
              <div className="kv"><span>duration</span><span>{build.durationMs ? `${(build.durationMs / 1000).toFixed(1)}s` : 'n/a'}</span></div>
              {build.apk ? (
                <>
                  <div className="kv"><span>APK</span><span>{build.apk.relPath}</span></div>
                  <div className="kv"><span>size</span><span>{bytes(build.apk.sizeBytes)}</span></div>
                  <div className="kv"><span>sha256</span><span>{build.apk.sha256}</span></div>
                  <a className="btn btn-primary btn-block" style={{ marginTop: 10 }} href={downloadUrl(projectId, 'apk')}>Download APK</a>
                </>
              ) : (
                <p className="error-text" style={{ marginTop: 8 }}>
                  No APK file was produced, so nothing is offered for download.
                </p>
              )}
              {build.error && <p className="error-text" style={{ marginTop: 8 }}>{build.error}</p>}
              <details style={{ marginTop: 10 }}>
                <summary className="hint">Build log tail ({build.logTail.length} chars)</summary>
                <pre className="term" style={{ maxHeight: '40vh', marginTop: 8 }}>{build.logTail.slice(-20000)}</pre>
              </details>
            </>
          )}
        </Card>
      </div>

      {inspection && (
        <div style={{ marginTop: 12 }}>
          <Card title="APK inspection" subtitle={`Tools used: ${inspection.toolsUsed.join(', ') || 'none'}`}>
            <div className="kv"><span>exists</span><span>{String(inspection.exists)}</span></div>
            <div className="kv"><span>size</span><span>{bytes(inspection.sizeBytes)}</span></div>
            <div className="kv"><span>package</span><span>{inspection.packageName ?? 'unknown'}</span></div>
            <div className="kv"><span>versionName / code</span><span>{inspection.versionName ?? '-'} / {inspection.versionCode ?? '-'}</span></div>
            <div className="kv"><span>minSdk / targetSdk</span><span>{inspection.minSdk ?? '-'} / {inspection.targetSdk ?? '-'}</span></div>
            <div className="kv"><span>signed</span><span>{String(inspection.signed)} {inspection.signatureSchemes.join(', ')}</span></div>
            <div className="kv"><span>debug build</span><span>{String(inspection.debugBuild)}</span></div>
            <div className="kv"><span>dex files</span><span>{inspection.dexFiles}</span></div>
            <div className="kv"><span>abis</span><span>{inspection.abis.join(', ') || 'none'}</span></div>
            <div className="kv"><span>permissions</span><span>{inspection.permissions.join(', ') || 'none'}</span></div>
            <div className="kv"><span>activities</span><span>{inspection.activities.join(', ') || 'none'}</span></div>
            <div className="kv"><span>services</span><span>{inspection.services.join(', ') || 'none'}</span></div>
            <div className="kv"><span>receivers</span><span>{inspection.receivers.join(', ') || 'none'}</span></div>
            {inspection.notes.length > 0 && (
              <ul className="hint" style={{ marginTop: 8 }}>
                {inspection.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            )}
          </Card>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Card
          title="Security"
          subtitle="Scans project sources and the APK archive for secret patterns."
          actions={<button className="btn btn-primary btn-sm" onClick={() => void runScan()} disabled={busy.scan}>{busy.scan ? 'Scanning.' : 'SCAN APK'}</button>}
        >
          {!scan && <Empty>No scan yet in this session.</Empty>}
          {scan && (
            <>
              <div className="row">
                <StatePill value={scan.status === 'clean' ? 'CLEAN' : scan.status === 'failed' ? 'SECURITY_FAILED' : 'ERROR'} />
                <span className="hint">{scan.filesScanned} files scanned{scan.apkNote ? ` · ${scan.apkNote}` : ''}</span>
              </div>
              {scan.findings.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {scan.findings.map((f, i) => (
                    <div className="kv" key={`${f.file}:${f.line}:${i}`}>
                      <span>{f.rule} · {f.file}{f.line ? `:${f.line}` : ''}</span>
                      <span>{f.preview}</span>
                    </div>
                  ))}
                </div>
              )}
              {scan.error && <p className="error-text">{scan.error}</p>}
            </>
          )}
        </Card>
      </div>

      {logs.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Card title="Live build / test log" actions={<button className="btn btn-ghost btn-sm" onClick={() => setLogs([])}>Clear</button>}>
            <pre className="term" style={{ maxHeight: '38vh' }} aria-live="polite">{logs.join('\n')}</pre>
          </Card>
        </div>
      )}

      {apkReady && (
        <p className="hint" style={{ marginTop: 12 }}>Last successful build: {when(build?.id ? new Date().toISOString() : null)}</p>
      )}
    </div>
  );
}
