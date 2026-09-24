import { useCallback, useEffect, useRef, useState } from 'react';
import { api, downloadUrl, githubArtifactUrl, githubBuildApkUrl } from '../api/client.ts';
import { Card, Empty, StatePill, bytes, when } from '../components/ui.tsx';
import type { ApkInspection, BuildResult, GithubBuild, GithubStatus, SecurityScan, SystemStatus, WsEvent } from '../api/types.ts';

interface TestSummary {
  status: string; framework: string | null; command: string | null;
  passed: number; failed: number; skipped: number; durationMs: number; log: string; error: string | null;
}

export function BuildScreen({ projectId, events }: { projectId: string; events: WsEvent[] }) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [test, setTest] = useState<TestSummary | null>(null);
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [scan, setScan] = useState<SecurityScan | null>(null);
  const [github, setGithub] = useState<GithubStatus | null>(null);
  const [inspection, setInspection] = useState<ApkInspection | null>(null);
  const [busy, setBusy] = useState<{ test?: boolean; build?: boolean; scan?: boolean }>({});
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [ghBuild, setGhBuild] = useState<GithubBuild | null>(null);
  const [ghBusy, setGhBusy] = useState(false);
  const [ghSync, setGhSync] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

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

  const loadGithub = useCallback(async () => {
    try {
      setGithub(await api.github());
    } catch {
      // An unconfigured or unreachable integration is not a page error; the
      // card reports the real state once loaded.
      setGithub(null);
    }
  }, []);

  const loadGithubBuild = useCallback(async () => {
    try {
      const res = await api.githubBuilds(projectId);
      // The first entry is the most recent build; keep showing it while it runs.
      setGhBuild(res.builds[0] ?? null);
    } catch {
      setGhBuild(null);
    }
  }, [projectId]);

  useEffect(() => { void loadStatus(); void loadArtifacts(); void loadGithub(); void loadGithubBuild(); }, [loadStatus, loadArtifacts, loadGithub, loadGithubBuild]);

  // Poll a running build until it reaches a terminal state. The backend owns the
  // run; this only re-reads its status and stops when there is nothing more to
  // wait for.
  useEffect(() => {
    const live = ghBuild && !['success', 'failed', 'cancelled', 'timeout', 'not_configured', 'blocked'].includes(ghBuild.status);
    if (!live) {
      if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const res = await api.githubBuildDetail(projectId, ghBuild!.id);
          setGhBuild(res.build);
        } catch {
          // A transient poll failure is retried on the next tick.
        }
      })();
    }, 4000);
    return () => {
      if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [ghBuild, projectId]);

  const startGithubBuild = async () => {
    setGhBusy(true);
    setError(null);
    setGhSync(null);
    try {
      const res = await api.githubBuild(projectId, {});
      setGhBuild(res.build);
      if (res.sync) {
        setGhSync(`published ${res.sync.filesPushed} file(s) to ${res.sync.repo}@${res.sync.branch}${res.sync.commitSha ? ` (${res.sync.commitSha.slice(0, 10)})` : ''}`);
      }
      await loadGithub();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGhBusy(false);
    }
  };

  const cancelGithubBuild = async () => {
    if (!ghBuild) return;
    setGhBusy(true);
    try {
      const res = await api.githubBuildCancel(projectId, ghBuild.id);
      setGhBuild(res.build);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGhBusy(false);
    }
  };

  const syncOnly = async () => {
    setGhBusy(true);
    setError(null);
    setGhSync(null);
    try {
      const res = await api.githubSync(projectId, {});
      setGhSync(`published ${res.sync.filesPushed} file(s) to ${res.sync.repo}@${res.sync.branch}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGhBusy(false);
    }
  };

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
          title="GitHub Actions"
          subtitle="Dispatches the real android-build workflow on GitHub. The APK offered for download is the artifact that run uploaded, validated on the server."
          actions={(
            <div className="row">
              <button className="btn btn-ghost btn-sm" onClick={() => void loadGithub()}>REFRESH</button>
              <button className="btn btn-ghost btn-sm" onClick={() => void syncOnly()} disabled={ghBusy}>PUBLISH CODE</button>
              <button className="btn btn-primary btn-sm" onClick={() => void startGithubBuild()} disabled={ghBusy}>
                {ghBusy ? 'WORKING.' : 'BUILD ON GITHUB ACTIONS'}
              </button>
            </div>
          )}
        >
          {!github && <Empty>GitHub integration state could not be read.</Empty>}
          {github && (
            <>
              <div className="row">
                <StatePill value={github.state} />
                <span className="hint mono">{github.repo ?? 'no repository set'}</span>
              </div>
              <div className="kv"><span>credential on server</span><span>{github.tokenConfigured || github.credential === 'app' ? github.credential : 'absent'}</span></div>
              <div className="kv"><span>credential source</span><span>{github.credentialSource ?? 'none'}</span></div>
              <div className="kv">
                <span>read permission</span>
                <span>{github.canRead === true ? 'readable' : github.canRead === false ? 'refused' : 'not determined'}</span>
              </div>
              <div className="kv">
                <span>publish permission</span>
                <span>{github.canWrite === true ? 'writable' : github.canWrite === false ? 'read-only' : 'not determined'}</span>
              </div>
              <div className="kv">
                <span>actions permission</span>
                <span>{github.actions === true ? 'may dispatch' : github.actions === false ? 'refused' : 'not determined'}</span>
              </div>
              <div className="kv"><span>workflow</span><span className="mono">{github.workflow}</span></div>
              {github.detail && <p className="hint" style={{ marginTop: 6 }}>{github.detail}</p>}
              {github.canWrite === false && (
                <p className="hint" style={{ marginTop: 8 }}>
                  GITHUB_READ_ONLY — the credential on the server can read this repository but not write to it, so publishing the workspace and dispatching the workflow will be refused. Grant the credential <span className="mono">contents: write</span> and <span className="mono">actions: write</span> for this repository, or set a new one in Settings → GitHub credential.
                </p>
              )}
              {github.actions === false && github.canWrite !== false && (
                <p className="hint" style={{ marginTop: 8 }}>
                  GITHUB_ACTIONS_DENIED — the credential can publish files but may not dispatch workflows. Grant <span className="mono">actions: write</span> to run the Android build.
                </p>
              )}
              {github.state === 'NOT_CONFIGURED' && (
                <p className="hint" style={{ marginTop: 8 }}>
                  GITHUB_NOT_CONFIGURED — set MY_AI_STUDIO_GITHUB_REPO on the server, and either a credential in Settings → GitHub credential, MY_AI_STUDIO_GITHUB_TOKEN, or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_INSTALLATION_ID, to enable this.
                </p>
              )}

              {ghSync && <p className="hint" style={{ marginTop: 8 }}>{ghSync}</p>}

              {ghBuild ? (
                <div style={{ marginTop: 12 }}>
                  <div className="row">
                    <StatePill value={ghBuild.status.toUpperCase()} />
                    <span className="hint mono">
                      {ghBuild.repo} · {ghBuild.workflow} @ {ghBuild.ref}
                    </span>
                  </div>
                  {ghBuild.runId && (
                    <>
                      <div className="kv"><span>run</span><span>#{ghBuild.runNumber ?? ghBuild.runId} (id {ghBuild.runId})</span></div>
                      <div className="kv"><span>conclusion</span><span>{ghBuild.conclusion ?? 'pending'}</span></div>
                      {ghBuild.htmlUrl && (
                        <a className="btn btn-ghost btn-block" style={{ marginTop: 8 }} href={ghBuild.htmlUrl} target="_blank" rel="noreferrer">
                          Open run on GitHub
                        </a>
                      )}
                    </>
                  )}
                  {ghBuild.error && <p className="error-text" style={{ marginTop: 8 }}>{ghBuild.error}</p>}

                  {ghBuild.status === 'success' && ghBuild.apk?.valid ? (
                    <>
                      <div className="kv"><span>APK</span><span>{ghBuild.apk.name}</span></div>
                      <div className="kv"><span>size</span><span>{bytes(ghBuild.apk.sizeBytes)}</span></div>
                      <div className="kv"><span>sha256</span><span className="mono" style={{ wordBreak: 'break-all' }}>{ghBuild.apk.sha256}</span></div>
                      <div className="kv"><span>package</span><span>{ghBuild.apk.packageName ?? 'unknown'}</span></div>
                      <div className="kv"><span>versionName / code</span><span>{ghBuild.apk.versionName ?? '-'} / {ghBuild.apk.versionCode ?? '-'}</span></div>
                      <a
                        className="btn btn-primary btn-block"
                        style={{ marginTop: 10 }}
                        href={githubBuildApkUrl(projectId, ghBuild.id)}
                      >
                        Download APK from GitHub Actions
                      </a>
                    </>
                  ) : ghBuild.status === 'success' ? (
                    <p className="hint" style={{ marginTop: 8 }}>The run succeeded but no validated APK artifact is attached.</p>
                  ) : (
                    <p className="hint" style={{ marginTop: 8 }}>
                      {['not_configured', 'blocked'].includes(ghBuild.status)
                        ? 'No workflow was dispatched.'
                        : 'Waiting for the run to finish. The APK becomes downloadable only after GitHub reports success and the artifact passes validation.'}
                    </p>
                  )}

                  {!['success', 'failed', 'cancelled', 'timeout', 'not_configured', 'blocked'].includes(ghBuild.status) && (
                    <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={() => void cancelGithubBuild()} disabled={ghBusy}>
                      Cancel run
                    </button>
                  )}

                  {ghBuild.logTail && (
                    <details style={{ marginTop: 10 }}>
                      <summary className="hint">Server-side build log</summary>
                      <pre className="term" style={{ maxHeight: '32vh', marginTop: 8 }}>{ghBuild.logTail.slice(-8000)}</pre>
                    </details>
                  )}
                </div>
              ) : (
                <p className="hint" style={{ marginTop: 8 }}>No build has been dispatched from this project yet.</p>
              )}

              {github.latestRun && (
                <details style={{ marginTop: 12 }}>
                  <summary className="hint">Latest run on the configured repository</summary>
                  <div className="kv"><span>workflow</span><span>{github.latestRun.workflowName ?? github.latestRun.name} #{github.latestRun.runNumber}</span></div>
                  <div className="kv"><span>status</span><span>{github.latestRun.status}{github.latestRun.conclusion ? ` · ${github.latestRun.conclusion}` : ''}</span></div>
                  <div className="kv"><span>branch / event</span><span>{github.latestRun.headBranch} · {github.latestRun.event}</span></div>
                  <div className="kv"><span>commit</span><span className="mono">{github.latestRun.headSha.slice(0, 12)}</span></div>
                  {github.latestArtifacts.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <p className="hint">Artifacts from this run</p>
                      {github.latestArtifacts.map((a) => (
                        <div className="kv" key={a.id}>
                          <span>{a.name} · {bytes(a.sizeInBytes)}{a.expired ? ' · expired' : ''}</span>
                          <span>{a.downloadable ? <a href={githubArtifactUrl(a.id)}>download</a> : 'unavailable'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </details>
              )}
            </>
          )}
        </Card>
      </div>

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
