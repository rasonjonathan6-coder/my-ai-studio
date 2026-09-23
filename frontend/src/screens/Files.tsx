import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.ts';
import { Card, Empty, Spinner, bytes } from '../components/ui.tsx';
import type { FileEntry } from '../api/types.ts';

export function FileExplorer({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ path: string; content: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [searchHits, setSearchHits] = useState<Array<{ path: string; line: number; text: string }> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listFiles(projectId, '.', 6);
      setFiles(res.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setSelected(null);
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
    return list.filter((f) => f.type === 'file').slice(0, 400);
  }, [files, query]);

  const openFile = async (path: string) => {
    setError(null);
    try {
      const res = await api.readFile(projectId, path);
      setSelected({ path: res.path, content: res.content });
      setDraft(res.content);
      setSearchHits(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await api.writeFile(projectId, selected.path, draft);
      setSelected({ path: selected.path, content: draft });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const create = async () => {
    if (!newPath.trim()) return;
    setError(null);
    try {
      await api.createFile(projectId, newPath.trim(), '');
      setNewPath('');
      await load();
      await openFile(newPath.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (path: string) => {
    if (!window.confirm(`Delete ${path}?`)) return;
    try {
      await api.deleteFile(projectId, path);
      if (selected?.path === path) setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const grep = async () => {
    if (!query.trim()) return;
    setError(null);
    try {
      const res = await api.searchFiles(projectId, query.trim());
      setSearchHits(res.matches);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Files</h1>
        <p>Real workspace contents, read and written on the server.</p>
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}

      <div className="split">
        <Card
          title="Workspace"
          actions={<button className="btn btn-ghost btn-sm" onClick={() => void load()}>Reload</button>}
        >
          <div className="field">
            <label htmlFor="file-filter">Filter or search</label>
            <input id="file-filter" className="input" value={query} placeholder="e.g. MainActivity or gradle"
              onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="row" style={{ marginBottom: 10 }}>
            <button className="btn btn-sm" onClick={() => void grep()}>Search contents</button>
            {searchHits && <button className="btn btn-ghost btn-sm" onClick={() => setSearchHits(null)}>Clear {searchHits.length} hits</button>}
          </div>

          {canEdit && (
            <div className="field">
              <label htmlFor="new-file">Create file</label>
              <div className="row">
                <input id="new-file" className="input" style={{ flex: 1 }} value={newPath} placeholder="app/src/.../New.kt"
                  onChange={(e) => setNewPath(e.target.value)} />
                <button className="btn btn-sm" onClick={() => void create()} disabled={!newPath.trim()}>Add</button>
              </div>
            </div>
          )}

          {searchHits && (
            <div className="scroll-list" style={{ marginBottom: 10 }}>
              {searchHits.length === 0 && <Empty>No content matches.</Empty>}
              {searchHits.map((hit) => (
                <button key={`${hit.path}:${hit.line}`} className="file-row" onClick={() => void openFile(hit.path)}>
                  <span className="file-path">{hit.path}:{hit.line}</span>
                </button>
              ))}
            </div>
          )}

          {loading && <Spinner label="Listing files." />}
          {!loading && filtered.length === 0 && <Empty>No files match.</Empty>}
          <div className="scroll-list">
            {filtered.map((f) => (
              <div key={f.path} className="row" style={{ gap: 4 }}>
                <button className="file-row" onClick={() => void openFile(f.path)} title={f.path}>
                  <span aria-hidden="true">{icon(f.path)}</span>
                  <span className="file-path">{f.path}</span>
                  <span className="file-meta">{bytes(f.size)}</span>
                </button>
                {canEdit && (
                  <button className="btn btn-danger btn-sm" aria-label={`Delete ${f.path}`} onClick={() => void remove(f.path)}>
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </Card>

        <Card
          title={selected ? selected.path : 'Select a file'}
          subtitle={selected ? `${bytes(selected.content.length)} · loaded from disk` : 'Choose a file to read its real contents.'}
          actions={selected && canEdit ? (
            <div className="row">
              <button className="btn btn-ghost btn-sm" onClick={() => setDraft(selected.content)} disabled={draft === selected.content}>Revert</button>
              <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving || draft === selected.content}>
                {saving ? 'Saving.' : 'Save'}
              </button>
            </div>
          ) : undefined}
        >
          {!selected && <Empty>No file selected.</Empty>}
          {selected && (
            <>
              {canEdit ? (
                <textarea
                  className="textarea mono" style={{ minHeight: '46vh' }} value={draft} spellCheck={false}
                  aria-label={`Contents of ${selected.path}`} onChange={(e) => setDraft(e.target.value)}
                />
              ) : (
                <pre className="term" style={{ maxHeight: '46vh' }}>{selected.content}</pre>
              )}
              {draft !== selected.content && <p className="hint">Unsaved changes.</p>}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function icon(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith('.kt') || p.endsWith('.java')) return '☕';
  if (p.endsWith('.gradle') || p.endsWith('.kts')) return '🔧';
  if (p.endsWith('.xml') || p.endsWith('.html')) return '📄';
  if (p.endsWith('.md')) return '📘';
  if (p.endsWith('.json') || p.endsWith('.yml') || p.endsWith('.yaml')) return '⚙️';
  if (p.endsWith('.png') || p.endsWith('.jpg')) return '🖼️';
  return '📄';
}

