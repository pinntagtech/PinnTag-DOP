import { ChevronRight, X } from 'lucide-react';
import {
  useConsoleRun,
  useConsoleRuns,
  type ConsoleRunStatus,
} from '../../hooks/use-business-console';

const STATUS_TONE: Record<ConsoleRunStatus, string> = {
  queued: 'var(--text-muted)',
  running: 'var(--accent, #8b5cf6)',
  done: 'var(--green, #22c55e)',
  failed: 'var(--red, #ef4444)',
  cancelled: 'var(--text-muted)',
};

// Right-side drawer showing recent runs and the detail of a focused one.
// Polls /runs (list) every 5s and /runs/:id (detail) every 2s until the
// selected run is terminal, then stops.
export function RunsDrawer({
  open,
  onClose,
  focusRunId,
  onFocus,
}: {
  open: boolean;
  onClose: () => void;
  focusRunId: string | null;
  onFocus: (runId: string | null) => void;
}) {
  const listQ = useConsoleRuns();
  const detailQ = useConsoleRun(focusRunId);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: '440px',
        maxWidth: '92vw',
        background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        boxShadow: 'var(--shadow-lg)',
        zIndex: 45,
        display: 'flex',
        flexDirection: 'column',
        color: 'var(--text)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 600 }}>
          {focusRunId ? 'Run details' : 'Recent runs'}
        </h3>
        <div style={{ display: 'flex', gap: '4px' }}>
          {focusRunId && (
            <button
              onClick={() => onFocus(null)}
              style={iconBtn}
              title="Back to list"
            >
              <ChevronRight
                size={14}
                style={{ transform: 'rotate(180deg)' }}
              />
            </button>
          )}
          <button onClick={onClose} style={iconBtn} title="Close">
            <X size={14} />
          </button>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
        }}
      >
        {focusRunId ? (
          <RunDetail data={detailQ.data} loading={detailQ.isLoading} />
        ) : (
          <div style={{ padding: '8px' }}>
            {listQ.isLoading && (
              <p style={{ padding: '12px', color: 'var(--text-muted)' }}>
                Loading…
              </p>
            )}
            {listQ.data?.items.length === 0 && (
              <p style={{ padding: '12px', color: 'var(--text-muted)' }}>
                No runs yet.
              </p>
            )}
            {listQ.data?.items.map((r) => (
              <button
                key={r._id}
                onClick={() => onFocus(r._id)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  padding: '8px 10px',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  background: 'var(--surface-elevated)',
                  width: '100%',
                  cursor: 'pointer',
                  marginBottom: '6px',
                  textAlign: 'left',
                  color: 'var(--text)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '12px',
                    fontWeight: 500,
                  }}
                >
                  <span>
                    {r.action}
                    {r.dryRun && (
                      <span
                        style={{
                          marginLeft: '6px',
                          fontSize: '10px',
                          color: 'var(--text-muted)',
                        }}
                      >
                        (dry)
                      </span>
                    )}
                  </span>
                  <span
                    style={{
                      color: STATUS_TONE[r.status],
                      fontWeight: 600,
                      fontSize: '11px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {r.status}
                  </span>
                </div>
                <div
                  style={{ fontSize: '11px', color: 'var(--text-muted)' }}
                >
                  {r.processed}/{r.total} processed · {r.succeeded} ok ·{' '}
                  {r.failed} failed
                </div>
                <div
                  style={{ fontSize: '10px', color: 'var(--text-muted)' }}
                >
                  {new Date(r.createdAt).toLocaleString()} · {r.startedBy}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RunDetail({
  data,
  loading,
}: {
  data: ReturnType<typeof useConsoleRun>['data'];
  loading: boolean;
}) {
  if (loading || !data) {
    return (
      <p style={{ padding: '12px', color: 'var(--text-muted)' }}>Loading…</p>
    );
  }
  const pct =
    data.total > 0 ? Math.min(100, (data.processed / data.total) * 100) : 0;
  return (
    <div
      style={{
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
          }}
        >
          <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600 }}>
            {data.action}
            {data.dryRun && (
              <span
                style={{
                  marginLeft: '6px',
                  fontSize: '10px',
                  color: 'var(--text-muted)',
                }}
              >
                (dry run)
              </span>
            )}
          </h4>
          <span
            style={{
              color: STATUS_TONE[data.status],
              fontSize: '11px',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            {data.status}
          </span>
        </div>
        <div
          style={{
            fontSize: '11px',
            color: 'var(--text-muted)',
            marginTop: '2px',
          }}
        >
          env {data.environment} · by {data.startedBy}
        </div>
      </div>

      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '11px',
            color: 'var(--text-muted)',
            marginBottom: '4px',
          }}
        >
          <span>
            {data.processed.toLocaleString()} of{' '}
            {data.total.toLocaleString()} processed
          </span>
          <span>{pct.toFixed(0)}%</span>
        </div>
        <div
          style={{
            height: '6px',
            background: 'var(--surface-elevated)',
            borderRadius: '3px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${pct}%`,
              background:
                data.status === 'failed'
                  ? 'var(--red, #ef4444)'
                  : 'var(--accent, #8b5cf6)',
              transition: 'width 0.4s',
            }}
          />
        </div>
        <div
          style={{
            display: 'flex',
            gap: '8px',
            fontSize: '11px',
            marginTop: '6px',
            color: 'var(--text-secondary)',
          }}
        >
          <span>succeeded {data.succeeded.toLocaleString()}</span>
          <span>failed {data.failed.toLocaleString()}</span>
          <span>skipped {data.skipped.toLocaleString()}</span>
        </div>
      </div>

      {data.error && (
        <div
          style={{
            padding: '8px 10px',
            borderRadius: 'var(--radius)',
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid var(--red, #ef4444)',
            color: 'var(--red, #ef4444)',
            fontSize: '12px',
          }}
        >
          {data.error}
        </div>
      )}

      <div>
        <p
          style={{
            fontSize: '10px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--text-muted)',
            margin: 0,
          }}
        >
          Log tail
        </p>
        <pre
          style={{
            margin: '6px 0 0',
            padding: '8px 10px',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            background: 'var(--surface-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-secondary)',
            maxHeight: '260px',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {(data.log ?? [])
            .map(
              (e) =>
                `[${new Date(e.ts).toLocaleTimeString()}] ${e.level.toUpperCase()} ${e.message}`,
            )
            .join('\n') || '(empty)'}
        </pre>
      </div>

      {data.result && (
        <details>
          <summary
            style={{
              cursor: 'pointer',
              fontSize: '11px',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontWeight: 600,
            }}
          >
            Result payload
          </summary>
          <pre
            style={{
              marginTop: '6px',
              padding: '8px 10px',
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
              background: 'var(--surface-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              color: 'var(--text-secondary)',
              maxHeight: '220px',
              overflow: 'auto',
            }}
          >
            {JSON.stringify(data.result, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '4px 6px',
  cursor: 'pointer',
  color: 'var(--text-secondary)',
  display: 'inline-flex',
};
