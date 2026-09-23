import { useCallback, useState } from 'react';
import { useProjects, useSession } from './hooks/index.ts';
import { AuthScreen } from './screens/Auth.tsx';
import { Dashboard } from './screens/Dashboard.tsx';
import { ProjectsScreen } from './screens/Projects.tsx';
import { SettingsScreen } from './screens/Settings.tsx';
import { ProjectWorkspace } from './components/ProjectWorkspace.tsx';
import { Spinner } from './components/ui.tsx';
import type { AgentProgress } from './screens/Ai.tsx';

type View = 'dashboard' | 'projects' | 'settings';

const NAV: Array<{ key: View; label: string; icon: string }> = [
  { key: 'dashboard', label: 'Dashboard', icon: '📊' },
  { key: 'projects', label: 'Projects', icon: '📁' },
  { key: 'settings', label: 'Settings', icon: '⚙️' },
];

export function App() {
  const { user, loading, login, register, logout } = useSession();
  const { projects, refresh } = useProjects();
  const [view, setView] = useState<View>('dashboard');
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<AgentProgress | null>(null);

  const openProject = useCallback((id: string) => setOpenProjectId(id), []);
  const handleAgentState = useCallback((s: AgentProgress | null) => setAgentState(s), []);

  if (loading) {
    return <div className="wrap" style={{ paddingTop: '20vh', textAlign: 'center' }}><Spinner label="Checking session." /></div>;
  }

  if (!user) {
    return <AuthScreen onLogin={login} onRegister={register} />;
  }

  const openProjectRecord = projects.find((p) => p.id === openProjectId);
  if (openProjectRecord) {
    return (
      <ProjectWorkspace
        project={openProjectRecord}
        onBack={() => setOpenProjectId(null)}
        onAgentState={handleAgentState}
      />
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand-mark" aria-hidden="true" />
        <div className="brand">
          <div>
            My AI Studio
            {agentState && <small>agent: {agentState.phase}</small>}
          </div>
        </div>
        <div className="topbar-spacer" />
        <span className="hint">{user.email}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => void logout()}>Sign out</button>
      </header>

      <nav className="tabbar" aria-label="Main sections">
        {NAV.map((n) => (
          <button
            key={n.key} className="tab" aria-current={view === n.key ? 'page' : undefined}
            onClick={() => setView(n.key)}
          >
            <span aria-hidden="true">{n.icon}</span>{n.label}
          </button>
        ))}
      </nav>

      <main style={{ flex: 1 }}>
        {view === 'dashboard' && (
          <Dashboard
            projects={projects}
            onOpen={openProject}
            onRefresh={() => void refresh()}
            wsConnected={null}
          />
        )}
        {view === 'projects' && (
          <ProjectsScreen projects={projects} onOpen={openProject} onRefresh={() => void refresh()} />
        )}
        {view === 'settings' && <SettingsScreen user={user} onLogout={logout} />}
      </main>

      <nav className="bottom-nav" aria-label="Mobile navigation">
        {NAV.map((n) => (
          <button
            key={n.key} aria-current={view === n.key ? 'page' : undefined}
            onClick={() => setView(n.key)}
          >
            <span className="nav-ico" aria-hidden="true">{n.icon}</span>
            {n.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
