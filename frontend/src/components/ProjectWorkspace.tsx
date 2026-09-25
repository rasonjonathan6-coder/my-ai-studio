import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.ts';
import { useProjectSocket } from '../hooks/index.ts';
import { StatePill } from './ui.tsx';
import { AiScreen, type AgentProgress } from '../screens/Ai.tsx';
import { FileExplorer } from '../screens/Files.tsx';
import { TerminalScreen } from '../screens/Terminal.tsx';
import { BuildScreen } from '../screens/Build.tsx';
import { ExportScreen } from '../screens/Export.tsx';
import type { Project, WsEvent } from '../api/types.ts';

const TABS = [
  { key: 'ai', label: 'AI', icon: '🤖' },
  { key: 'files', label: 'Files', icon: '📁' },
  { key: 'terminal', label: 'Terminal', icon: '💻' },
  { key: 'build', label: 'Build', icon: '🔨' },
  { key: 'export', label: 'Export', icon: '📦' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function ProjectWorkspace({ project, onBack, onAgentState }: {
  project: Project;
  onBack: () => void;
  onAgentState: (state: AgentProgress | null) => void;
}) {
  const [tab, setTab] = useState<TabKey>('ai');
  const [events, setEvents] = useState<WsEvent[]>([]);
  const [agentState, setAgentState] = useState<AgentProgress | null>(null);
  const [workspaceInfo, setWorkspaceInfo] = useState<{ fileCount: number; totalSize: number } | null>(null);

  const handleEvent = useCallback((event: WsEvent) => {
    // Keep a bounded ring so a long agent run cannot grow memory without limit.
    setEvents((prev) => [...prev.slice(-400), event]);
  }, []);

  const { connected, error: socketError } = useProjectSocket(project.id, handleEvent);

  useEffect(() => {
    api.getProject(project.id)
      .then((res) => setWorkspaceInfo(res.workspace))
      .catch(() => setWorkspaceInfo(null));
  }, [project.id]);

  // AiScreen reports the real phase; surface it in the header and upward.
  const handleAgentState = useCallback((state: AgentProgress | null) => {
    setAgentState(state);
    onAgentState(state);
  }, [onAgentState]);

  const headerSub = useMemo(() => {
    const bits = [`${project.kind} project`];
    if (workspaceInfo) bits.push(`${workspaceInfo.fileCount} files`);
    if (agentState) bits.push(`agent ${agentState.phase} (${agentState.fixAttempts}/${agentState.maxFixAttempts})`);
    return bits.join(' · ');
  }, [project.kind, workspaceInfo, agentState]);

  return (
    <div className="shell">
      <header className="topbar">
        <button className="btn btn-ghost btn-sm" onClick={onBack} aria-label="Back to projects">←</button>
        <div className="brand" style={{ minWidth: 0 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</div>
            <small style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headerSub}</small>
          </div>
        </div>
        <div className="topbar-spacer" />
        <StatePill value={connected ? 'CONNECTED' : 'DOWN'} />
        {agentState && (agentState.status === 'running' || agentState.status === 'queued') && (
          <span className="pill pill-run"><span className="dot dot-pulse" aria-hidden="true" />agent</span>
        )}
      </header>

      <nav className="tabbar" aria-label="Project sections">
        {TABS.map((t) => (
          <button
            key={t.key} className="tab" aria-current={tab === t.key ? 'page' : undefined}
            onClick={() => setTab(t.key)}
          >
            <span aria-hidden="true">{t.icon}</span>{t.label}
          </button>
        ))}
      </nav>

      {socketError && (
        <p className="error-text" role="status" style={{ padding: '8px 14px 0' }}>realtime: {socketError}</p>
      )}

      <main style={{ flex: 1 }}>
        {tab === 'ai' && (
          <AiScreen
            projectId={project.id}
            socketConnected={connected}
            events={events}
            onAgentState={handleAgentState}
          />
        )}
        {tab === 'files' && <FileExplorer projectId={project.id} canEdit />}
        {tab === 'terminal' && <TerminalScreen projectId={project.id} events={events} />}
        {tab === 'build' && <BuildScreen projectId={project.id} events={events} />}
        {tab === 'export' && <ExportScreen projectId={project.id} />}
      </main>
    </div>
  );
}
