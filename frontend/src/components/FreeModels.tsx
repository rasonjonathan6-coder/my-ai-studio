import { useCallback, useMemo, useState } from 'react';
import { api } from '../api/client.ts';
import { Card, Empty, StatePill } from '../components/ui.tsx';
import type { AiModel, AiProvidersResponse, ModelStatus } from '../api/types.ts';

/**
 * Free model browser.
 *
 * Every attribute shown here is either a declared fact with a visible source
 * (the evidence line) or a real observation (the status, derived from the HTTP
 * code a request returned). A model nobody has called reads NOT_TESTED - it is
 * never dressed up as available.
 */
const STATUS_TONE: Record<ModelStatus, 'ok' | 'warn' | 'off'> = {
  AVAILABLE: 'ok',
  RATE_LIMITED: 'warn',
  NOT_TESTED: 'off',
  PAYMENT_REQUIRED: 'warn',
  FORBIDDEN: 'warn',
  MODEL_NOT_FOUND: 'off',
  DEPRECATED: 'off',
  ERROR: 'warn',
};

export function FreeModelsPanel({ providers, onError }: {
  providers: AiProvidersResponse | null;
  onError: (message: string) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'free' | 'coding'>('free');
  const [testing, setTesting] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [results, setResults] = useState<Record<string, string>>({});
  const [models, setModels] = useState<AiModel[] | null>(null);

  // The registry comes back with the providers call; the extra fetch lets the
  // filter be re-read without a second full provider round trip.
  const shown = useMemo(() => {
    const source = models ?? providers?.models ?? [];
    if (filter === 'free') return source.filter((m) => m.free);
    if (filter === 'coding') return source.filter((m) => m.free && m.coding);
    return source;
  }, [models, providers, filter]);

  const byProvider = useMemo(() => {
    const groups = new Map<string, AiModel[]>();
    for (const m of shown) {
      const list = groups.get(m.provider) ?? [];
      list.push(m);
      groups.set(m.provider, list);
    }
    return [...groups.entries()];
  }, [shown]);

  const test = useCallback(async (provider: string, model: string) => {
    const key = `${provider}:${model}`;
    setTesting(key);
    try {
      const res = await api.testAiModel(provider, model);
      const detail = res.result === 'PASS'
        ? `PASS · HTTP ${res.http} · ${res.durationMs}ms`
        : res.result === 'NOT_CONFIGURED'
          ? 'NOT CONFIGURED'
          : `FAIL · ${res.status}${res.http ? ` · HTTP ${res.http}` : ''}`;
      setResults((prev) => ({ ...prev, [key]: detail }));
      // Refresh the list so the recorded status is the one shown next.
      const fresh = await api.aiModels();
      setModels(fresh.models);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(null);
    }
  }, [onError]);

  // Catalogue sync reads a public endpoint: no key, no completion quota.
  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await api.syncAiModels();
      onError(res.ok
        ? ''
        : `Catalogue sync failed: ${res.error ?? 'unknown error'}`);
      const fresh = await api.aiModels();
      setModels(fresh.models);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, [onError]);

  const summary = providers?.modelSummary;

  return (
    <Card
      title="Free models"
      subtitle="Declared facts show their source; statuses come from real requests."
      actions={(
        <div className="row" style={{ gap: 6 }}>
          <StatePill value={providers?.freeOnly ? 'FREE_ONLY' : 'ALL PROVIDERS'} />
          <button className="btn btn-ghost btn-sm" disabled={syncing} onClick={() => void sync()}
            title="Re-reads OpenRouter's public model list. Costs no completion quota.">
            {syncing ? 'Syncing' : 'Sync catalogue'}
          </button>
        </div>
      )}
    >
      {summary && (
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
          {summary.freeProviders} free providers · {summary.freeModels} free models ·{' '}
          {summary.available} available · {summary.rateLimited} rate limited ·{' '}
          {summary.paymentRequired} payment required · {summary.notTested} not tested
          {summary.lastSync ? ` · catalogue read ${new Date(summary.lastSync.at).toLocaleTimeString()}` : ''}
        </p>
      )}

      <div className="row" style={{ gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <label className="sr-only" htmlFor="model-filter">Model filter</label>
        <select id="model-filter" className="select" value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="free">Free models</option>
          <option value="coding">Free coding models</option>
          <option value="all">All registered models</option>
        </select>
      </div>

      {shown.length === 0 && <Empty>No model matches this filter.</Empty>}

      {byProvider.map(([providerId, list]) => {
        const provider = providers?.providers.find((p) => p.id === providerId);
        return (
          <div key={providerId} style={{ marginBottom: 12 }}>
            <p style={{ margin: '0 0 4px', fontSize: 13 }}>
              <strong>{provider?.label ?? providerId}</strong>{' '}
              {provider && (
                <span className={`dot ${provider.tier === 'free' ? 'ok' : 'off'}`} aria-hidden="true" />
              )}{' '}
              <span className="muted" style={{ fontSize: 11.5 }}>
                {provider ? (provider.tier === 'free' ? 'FREE' : 'PAID') : ''}
              </span>
            </p>
            <ul className="step-list">
              {list.map((m) => {
                const key = `${m.provider}:${m.id}`;
                const tone = STATUS_TONE[m.status];
                return (
                  <li key={m.id} className="step">
                    <span className={`dot ${tone}`} aria-hidden="true" />
                    <span>
                      <span style={{ fontSize: 12.5 }}>{m.id}</span>
                      <span className="muted" style={{ marginLeft: 6, fontSize: 11.5 }}>
                        {m.status}{m.lastHttpStatus ? ` (HTTP ${m.lastHttpStatus})` : ''}
                      </span>
                      <span className="muted" style={{ display: 'block', fontSize: 11 }}>
                        {m.free ? '✓ free' : '✗ paid'}
                        {m.coding ? ' · coding' : ''}
                        {m.tools ? ' · tools' : ''}
                        {m.context ? ` · ${Math.round(m.context / 1000)}k ctx` : ''}
                      </span>
                      <span className="muted" style={{ display: 'block', fontSize: 10.5, opacity: 0.75 }}>
                        source: {m.evidence}
                      </span>
                      {results[key] && <span className="muted" style={{ display: 'block', fontSize: 12 }}>{results[key]}</span>}
                    </span>
                    <span className="row" style={{ marginLeft: 'auto' }}>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={!provider?.configured || testing === key}
                        onClick={() => void test(m.provider, m.id)}
                        title="Sends one real completion and may consume quota."
                      >
                        {testing === key ? 'Testing' : 'Test'}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Sync catalogue reads a public model list and spends nothing. Test sends one real
        completion, so it costs quota - nothing here runs on a timer.
      </p>
    </Card>
  );
}
