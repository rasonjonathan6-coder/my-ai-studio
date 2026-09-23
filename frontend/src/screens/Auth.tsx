import { useState } from 'react';
import { Card } from '../components/ui.tsx';

export function AuthScreen({ onLogin, onRegister }: {
  onLogin: (email: string, password: string) => Promise<unknown>;
  onRegister: (email: string, password: string, name?: string) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await onLogin(email, password);
      else await onRegister(email, password, name || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap" style={{ maxWidth: 460, paddingTop: '8vh' }}>
      <div className="row" style={{ marginBottom: 18 }}>
        <span className="brand-mark" aria-hidden="true" />
        <div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>My AI Studio</div>
          <div className="hint">Real terminal, real builds, real APKs.</div>
        </div>
      </div>

      <Card>
        <div className="row" role="tablist" aria-label="Authentication mode" style={{ marginBottom: 14 }}>
          <button
            type="button" role="tab" className={`tab${mode === 'login' ? '' : ''}`}
            aria-current={mode === 'login' ? 'page' : undefined}
            onClick={() => { setMode('login'); setError(null); }}
          >
            Sign in
          </button>
          <button
            type="button" role="tab" className="tab"
            aria-current={mode === 'register' ? 'page' : undefined}
            onClick={() => { setMode('register'); setError(null); }}
          >
            Create account
          </button>
        </div>

        <form onSubmit={submit}>
          {mode === 'register' && (
            <div className="field">
              <label htmlFor="auth-name">Display name</label>
              <input id="auth-name" className="input" value={name} autoComplete="name"
                onChange={(e) => setName(e.target.value)} placeholder="Optional" />
            </div>
          )}

          <div className="field">
            <label htmlFor="auth-email">Email</label>
            <input id="auth-email" className="input" type="email" required value={email}
              autoComplete="email" inputMode="email"
              onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>

          <div className="field">
            <label htmlFor="auth-password">Password</label>
            <input id="auth-password" className="input" type="password" required minLength={10}
              value={password} autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              onChange={(e) => setPassword(e.target.value)} placeholder="At least 10 characters" />
            <span className="hint">Passwords are hashed with bcrypt on the server.</span>
          </div>

          {error && <p className="error-text" role="alert">{error}</p>}

          <button className="btn btn-primary btn-block" type="submit" disabled={busy || !email || password.length < 10}>
            {busy ? 'Working.' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </Card>

      <p className="hint" style={{ marginTop: 14, textAlign: 'center' }}>
        Sessions use an httpOnly cookie. No token is stored in localStorage.
      </p>
    </div>
  );
}
