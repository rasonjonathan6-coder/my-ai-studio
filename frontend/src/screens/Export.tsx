import { useCallback, useEffect, useState } from 'react';
import { api, downloadUrl } from '../api/client.ts';
import { Card, Empty, StatePill, bytes } from '../components/ui.tsx';
import type { ExportResult, PreviewResult } from '../api/types.ts';

export function PreviewScreen({ projectId }: { projectId: string }) {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.preview(projectId);
      setPreview(res.preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  useEffect(() => { void run(); }, [run]);

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Preview</h1>
        <p>Android preview requires a real emulator reachable through adb.</p>
      </div>

      <Card
        title="Android preview"
        actions={<button className="btn btn-ghost btn-sm" onClick={() => void run()} disabled={busy}>{busy ? 'Checking.' : 'Re-check'}</button>}
      >
        {!preview && <Empty>Checking for an attached device.</Empty>}
        {preview && (
          <>
            <div className="row">
              <StatePill value={preview.available ? 'AVAILABLE' : 'NOT_AVAILABLE'} />
              <span className="hint">{preview.reason}</span>
            </div>
            <div className="kv"><span>adb devices</span><span>{preview.devices.length > 0 ? preview.devices.join(', ') : '(none)'}</span></div>
            <div className="kv"><span>apk present</span><span>{String(preview.apkPresent)}</span></div>
            {preview.installed !== undefined && <div className="kv"><span>installed</span><span>{String(preview.installed)}</span></div>}
            {preview.launched !== undefined && <div className="kv"><span>launched</span><span>{String(preview.launched)}</span></div>}
            {preview.logs && (
              <details style={{ marginTop: 10 }}>
                <summary className="hint">Device logs</summary>
                <pre className="term" style={{ maxHeight: '30vh', marginTop: 8 }}>{preview.logs}</pre>
              </details>
            )}
            {!preview.available && (
              <p className="hint" style={{ marginTop: 10 }}>
                No image, screenshot or mocked frame is shown when no emulator exists. Attach a real device or an
                emulator host and this screen will install and launch the APK.
              </p>
            )}
          </>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
      </Card>
    </div>
  );
}

export function ExportScreen({ projectId }: { projectId: string }) {
  const [result, setResult] = useState<ExportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apkInfo, setApkInfo] = useState<{ exists: boolean; sizeBytes?: number } | null>(null);

  const loadApk = useCallback(async () => {
    try {
      const builds = await api.builds(projectId);
      const ok = builds.builds.find((b) => b.status === 'succeeded');
      if (!ok) { setApkInfo({ exists: false }); return; }
      const detail = await api.getBuild(projectId, ok.id);
      setApkInfo(detail.build.apk ? { exists: true, sizeBytes: detail.build.apk.sizeBytes } : { exists: false });
    } catch {
      setApkInfo({ exists: false });
    }
  }, [projectId]);

  useEffect(() => { void loadApk(); }, [loadApk]);

  const build = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.exportProject(projectId);
      setResult(res.export);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Export</h1>
        <p>Download the real artifacts produced by this project.</p>
      </div>

      <Card title="Artifacts">
        <div className="kv"><span>APK</span><span>{apkInfo === null ? 'checking.' : apkInfo.exists ? `${bytes(apkInfo.sizeBytes)} ready` : 'not generated'}</span></div>
        <div className="row" style={{ marginTop: 10 }}>
          <a
            className={`btn ${apkInfo?.exists ? 'btn-primary' : 'btn-ghost'}`}
            href={apkInfo?.exists ? downloadUrl(projectId, 'apk') : undefined}
            aria-disabled={!apkInfo?.exists}
            onClick={(e) => { if (!apkInfo?.exists) e.preventDefault(); }}
          >
            Download APK
          </a>
          <a className="btn" href={downloadUrl(projectId, 'zip')}>Download Project ZIP</a>
          <a className="btn" href={downloadUrl(projectId, 'logs')}>Download Build Logs</a>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          The ZIP excludes .env files, key material, node_modules, .git and build outputs.
        </p>
      </Card>

      <div style={{ marginTop: 12 }}>
        <Card
          title="Generate ZIP"
          subtitle="Builds the archive on the server and records it as an artifact with a SHA-256 checksum."
          actions={<button className="btn btn-primary btn-sm" onClick={() => void build()} disabled={busy}>{busy ? 'Building.' : 'Build ZIP'}</button>}
        >
          {!result && <Empty>No export built in this session.</Empty>}
          {result && (
            <>
              <div className="row"><StatePill value={result.ok ? 'SUCCEEDED' : 'FAILED'} /></div>
              <div className="kv"><span>entries</span><span>{result.entryCount}</span></div>
              <div className="kv"><span>size</span><span>{bytes(result.sizeBytes)}</span></div>
              <div className="kv"><span>sha256</span><span>{result.sha256 ?? '-'}</span></div>
              {result.excludedEntries.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary className="hint">{result.excludedEntries.length} excluded entries</summary>
                  <pre className="term" style={{ maxHeight: '26vh', marginTop: 8 }}>{result.excludedEntries.join('\n')}</pre>
                </details>
              )}
              {result.error && <p className="error-text">{result.error}</p>}
            </>
          )}
        </Card>
      </div>
      {error && <p className="error-text" role="alert" style={{ marginTop: 10 }}>{error}</p>}
    </div>
  );
}
