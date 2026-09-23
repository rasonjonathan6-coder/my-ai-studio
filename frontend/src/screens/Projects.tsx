import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.ts';
import { Card, Empty, StatePill, when } from '../components/ui.tsx';
import type { Project } from '../api/types.ts';

interface Template { id: string; name: string; kind: string; description: string }

export function ProjectsScreen({ projects, onOpen, onRefresh }: {
  projects: Project[];
  onOpen: (id: string) => void;
  onRefresh: () => void;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('blank');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.templates().then((r) => setTemplates(r.templates)).catch(() => setTemplates([]));
  }, []);

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.createProject({ name: name.trim(), template });
      setName('');
      setShowForm(false);
      onRefresh();
      onOpen(res.project.id);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} (${err.code})` : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [name, template, onRefresh, onOpen]);

  const remove = useCallback(async (id: string, label: string) => {
    if (!window.confirm(`Delete project "${label}"? The workspace directory is removed from disk.`)) return;
    try {
      await api.deleteProject(id);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onRefresh]);

  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Projects</h1>
        <p>Each project gets an isolated workspace directory.</p>
      </div>

      <button className="btn btn-primary btn-block" onClick={() => setShowForm((v) => !v)}>
        {showForm ? 'Cancel' : 'New project'}
      </button>

      {showForm && (
        <div style={{ marginTop: 12 }}>
          <Card title="Create project">
            <div className="field">
              <label htmlFor="p-name">Name</label>
              <input id="p-name" className="input" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="My Android app" maxLength={120} />
            </div>
            <div className="field">
              <label htmlFor="p-template">Template</label>
              <select id="p-template" className="select" value={template} onChange={(e) => setTemplate(e.target.value)}>
                {templates.length === 0 && <option value="blank">blank</option>}
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} ({t.kind})</option>
                ))}
              </select>
              {templates.find((t) => t.id === template) && (
                <span className="hint">{templates.find((t) => t.id === template)!.description}</span>
              )}
            </div>
            {error && <p className="error-text" role="alert">{error}</p>}
            <button className="btn btn-primary btn-block" disabled={busy || name.trim().length === 0} onClick={() => void create()}>
              {busy ? 'Creating project.' : 'Create'}
            </button>
            {template.startsWith('android') && (
              <p className="hint" style={{ marginTop: 8 }}>
                Android templates run a real <span className="mono">gradle wrapper</span> right after creation, which takes a few seconds.
              </p>
            )}
          </Card>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        {projects.length === 0 && <Empty>No projects yet.</Empty>}
        {projects.map((p) => (
          <Card key={p.id}>
            <div className="between">
              <div style={{ minWidth: 0 }}>
                <div className="row">
                  <strong>{p.name}</strong>
                  <span className="pill pill-dim">{p.kind}</span>
                  <StatePill value={p.template} />
                </div>
                <div className="hint mono" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>{p.id}</div>
                <div className="hint">Updated {when(p.updated_at)}{p.package_name ? ` · ${p.package_name}` : ''}</div>
              </div>
              <div className="row">
                <button className="btn btn-sm" onClick={() => onOpen(p.id)}>Open</button>
                <button className="btn btn-danger btn-sm" onClick={() => void remove(p.id, p.name)}>Delete</button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
