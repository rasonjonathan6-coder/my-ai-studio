import type { ReactNode } from 'react';

export function Pill({ state, label }: { state: 'ok' | 'warn' | 'err' | 'dim' | 'run'; label: string }) {
  return <span className={`pill pill-${state}`}><span className="dot" aria-hidden="true" />{label}</span>;
}

/** Maps a real backend state string onto a visual pill. Unknown -> dim. */
export function StatePill({ value }: { value: string | null | undefined }) {
  const raw = (value ?? 'unknown').toString();
  const v = raw.toUpperCase();
  let kind: 'ok' | 'warn' | 'err' | 'dim' | 'run' = 'dim';
  if (['AVAILABLE', 'CONFIGURED', 'SUCCEEDED', 'PASSED', 'CLEAN', 'OK', 'UP', 'CONNECTED'].includes(v)) kind = 'ok';
  else if (['NOT_AVAILABLE', 'NOT_CONFIGURED', 'UNAVAILABLE', 'SKIPPED'].includes(v)) kind = 'dim';
  else if (['FAILED', 'ERROR', 'DOWN', 'SECURITY_FAILED', 'TIMEOUT'].includes(v)) kind = 'err';
  // NOT_TESTED is neither a pass nor a failure: it was never exercised.
  else if (['NOT_TESTED', 'UNKNOWN'].includes(v)) kind = 'warn';
  else if (['QUEUED', 'RUNNING', 'PENDING', 'BUSY', 'WARN', 'COOLING_DOWN'].includes(v)) kind = 'run';
  return <Pill state={kind} label={raw.toLowerCase().replace(/_/g, ' ')} />;
}

export function Card({ title, subtitle, actions, children }: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="between" style={{ marginBottom: 10 }}>
          {title && <h2 className="card-title">{title}</h2>}
          {actions}
        </header>
      )}
      {subtitle && <p className="card-sub">{subtitle}</p>}
      {children}
    </section>
  );
}

export function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span className="hint">{label}</span>}
    </span>
  );
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}
