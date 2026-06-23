import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { AlertCircle, CheckCircle2, Clock, Upload } from 'lucide-react';
import { useSessions, useSessionLogs } from '../hooks/use-sessions';
import { useEnvironment } from '../contexts/EnvironmentContext';
import { StatCard } from '../components/ui/StatCard';
import { PipelineStrip } from '../components/ui/PipelineStrip';
import { Badge } from '../components/ui/Badge';
import { Card } from '../components/ui/Card';
import { Skeleton } from '../components/ui/Skeleton';
import type { SeedingStats } from '@pinntag-dop/types';

const EMPTY_STATS: SeedingStats = {
  raw: 0, validated: 0, transformed: 0,
  enriched: 0, ready: 0, published: 0,
  failed: 0, skipped: 0,
};

const ENV_PILL: Record<string, { bg: string; color: string }> = {
  dev: { bg: '#1C3557', color: '#60A5FA' },
  staging: { bg: '#2E1F47', color: '#C084FC' },
  production: { bg: '#1A1A1A', color: '#D4D4D8' },
};

const LOG_DOT: Record<string, string> = {
  created: 'var(--green)',
  approved: 'var(--green)',
  published: 'var(--green)',
  validated: 'var(--green)',
  failed: 'var(--red)',
  validation_failed: 'var(--red)',
  publish_failed: 'var(--red)',
  status_changed: 'var(--blue)',
  enriched: 'var(--amber)',
  transformed: 'var(--amber)',
};

function actorColor(actor?: string): string {
  if (!actor) return 'var(--text-muted)';
  if (actor === 'Bot') return 'var(--accent)';
  if (actor === 'System') return 'var(--text-muted)';
  return 'var(--text)';
}

function truncate(text: string, max = 45): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max).trimEnd() + '…' : text;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { environment } = useEnvironment();

  const { data: sessions, isLoading, error } = useSessions({ environment });

  const recentSession = sessions?.[0];
  const recentSessionId = recentSession?._id ?? '';

  const { data: logs } = useSessionLogs(recentSessionId);

  const stats = useMemo(() => {
    if (!sessions) return {
      total: 0,
      failed: 0,
      pendingReview: 0,
      publishedToday: 0,
    };

    const today = new Date().toDateString();

    return {
      total: sessions.length,
      failed: sessions.reduce(
        (sum, s) => sum + (s.stats?.failed ?? 0), 0
      ),
      pendingReview: sessions.filter(
        (s) => s.status === 'enriched' || s.status === 'ready'
      ).length,
      publishedToday: sessions.filter(
        (s) =>
          s.status === 'published' &&
          s.publishedAt &&
          new Date(s.publishedAt).toDateString() === today
      ).length,
    };
  }, [sessions]);

  const pipelineStats = useMemo((): SeedingStats => {
    if (!recentSession?.stats) return EMPTY_STATS;
    return recentSession.stats;
  }, [recentSession]);

  if (error) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '256px',
          gap: '12px',
        }}
      >
        <p
          style={{
            fontSize: '14px',
            fontWeight: 500,
            color: 'var(--red)',
          }}
        >
          Failed to connect to API
        </p>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
          Make sure the NestJS API is running on port 3000
        </p>
        <code
          style={{
            fontSize: '12px',
            background: 'var(--surface-elevated)',
            padding: '6px 12px',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          npm run start:dev (from apps/api/)
        </code>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-5">
        <div className="grid grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-24" />
        <div className="grid grid-cols-[1fr_380px] gap-4">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Stat cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '12px',
      }}>
        <StatCard
          label="Total sessions"
          value={stats.total}
          sub={`in ${environment}`}
          icon={<Upload size={16} />}
        />
        <StatCard
          label="Validation errors"
          value={stats.failed}
          sub={stats.failed > 0
            ? 'Requires attention'
            : 'All clear'}
          subVariant={stats.failed > 0 ? 'error' : 'success'}
          icon={<AlertCircle size={16} />}
          iconColor={
            stats.failed > 0 ? 'var(--red)' : 'var(--text-muted)'
          }
        />
        <StatCard
          label="Pending review"
          value={stats.pendingReview}
          sub="awaiting approval"
          icon={<Clock size={16} />}
          iconColor={
            stats.pendingReview > 0
              ? 'var(--amber)'
              : 'var(--text-muted)'
          }
        />
        <StatCard
          label="Published today"
          value={stats.publishedToday}
          sub="to target DB"
          subVariant="success"
          icon={<CheckCircle2 size={16} />}
          iconColor="var(--green)"
        />
      </div>

      {/* Pipeline strip */}
      <Card>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '16px',
          }}
        >
          <p
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--text)',
            }}
          >
            Pipeline overview
          </p>
          {recentSession && (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Latest: {recentSession.name}
            </span>
          )}
        </div>
        {recentSession ? (
          <PipelineStrip stats={pipelineStats} />
        ) : (
          <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            No active sessions
          </p>
        )}
      </Card>

      {/* Sessions table + Activity feed */}
      <div className="grid grid-cols-[1fr_360px] gap-4">

        {/* Recent sessions */}
        <Card padding={false}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '14px 16px',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <p
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--text)',
              }}
            >
              Recent sessions
            </p>
            <button
              onClick={() => navigate('/sessions')}
              style={{
                fontSize: '12px',
                color: 'var(--accent)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              View all →
            </button>
          </div>

          {!sessions || sessions.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '48px 16px',
                textAlign: 'center',
              }}
            >
              <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                No sessions yet
              </p>
              <button
                onClick={() => navigate('/sessions')}
                style={{
                  marginTop: '12px',
                  fontSize: '12px',
                  color: 'var(--accent)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                Create your first session →
              </button>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr
                  style={{
                    background: 'var(--surface-elevated)',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  {['Session ID', 'Name', 'By', 'Records', 'Status', 'Env', 'Created'].map(
                    (h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: 'left',
                          fontSize: '11px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          color: 'var(--text-muted)',
                          fontWeight: 600,
                          padding: '10px 16px',
                        }}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {sessions.slice(0, 6).map((s) => (
                  <tr
                    key={s._id}
                    onClick={() => navigate(`/sessions/${s._id}`)}
                    style={{
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={(e) =>
                      ((e.currentTarget as HTMLElement).style.background =
                        'var(--surface-elevated)')
                    }
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLElement).style.background =
                        'transparent')
                    }
                  >
                    <td style={{ padding: '12px 16px' }}>
                      <span style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '12px',
                        color: 'var(--text)',
                        background: 'var(--surface-elevated)',
                        padding: '2px 6px',
                        borderRadius: 'var(--radius-sm)',
                      }}>
                        {s.sessionId?.slice(-8) ?? s._id.slice(-8)}
                      </span>
                    </td>
                    <td style={{
                      padding: '12px 16px',
                      fontSize: '13px',
                      color: 'var(--text)',
                      fontWeight: 500,
                    }}>
                      {s.name}
                    </td>
                    <td style={{
                      padding: '12px 16px',
                      fontSize: '13px',
                      color: 'var(--text-secondary)',
                    }}>
                      {s.createdBy}
                    </td>
                    <td style={{
                      padding: '12px 16px',
                      fontSize: '13px',
                      color: 'var(--text)',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {s.totalRecords}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <Badge status={s.status} />
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      {(() => {
                        const ep =
                          ENV_PILL[s.environment] ?? ENV_PILL.dev;
                        return (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              padding: '2px 8px',
                              borderRadius: '999px',
                              fontSize: '11px',
                              fontWeight: 600,
                              background: ep.bg,
                              color: ep.color,
                            }}
                          >
                            {s.environment}
                          </span>
                        );
                      })()}
                    </td>
                    <td style={{
                      padding: '12px 16px',
                      fontSize: '12px',
                      color: 'var(--text-muted)',
                      whiteSpace: 'nowrap',
                    }}>
                      {formatDistanceToNow(new Date(s.createdAt), {
                        addSuffix: true,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </Card>

        {/* Activity feed */}
        <Card padding={false}>
          <div
            style={{
              padding: '14px 16px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <p
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--text)',
              }}
            >
              Recent activity
            </p>
          </div>

          {!logs || logs.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '48px 16px',
                textAlign: 'center',
              }}
            >
              <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                No activity yet
              </p>
            </div>
          ) : (
            <div>
              {logs.slice(0, 8).map((log, i, arr) => {
                const rawMessage =
                  log.message ?? log.action.replace(/_/g, ' ');
                const actor = log.actor ?? '';
                const messageStartsWithActor =
                  !!actor &&
                  rawMessage
                    .trim()
                    .toLowerCase()
                    .startsWith(actor.toLowerCase());
                const displayMessage = truncate(rawMessage, 45);
                return (
                  <div
                    key={log._id}
                    style={{
                      padding: '10px 16px',
                      borderBottom:
                        i < arr.length - 1
                          ? '1px solid var(--border)'
                          : 'none',
                      display: 'flex',
                      gap: '10px',
                      alignItems: 'flex-start',
                    }}
                  >
                    <span
                      style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        marginTop: '5px',
                        flexShrink: 0,
                        background:
                          LOG_DOT[log.action] ?? 'var(--text-muted)',
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p
                        style={{
                          fontSize: '12px',
                          lineHeight: 1.4,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {!messageStartsWithActor && actor && (
                          <span
                            style={{
                              fontWeight: 600,
                              color: actorColor(actor),
                              marginRight: '4px',
                            }}
                          >
                            {actor}
                          </span>
                        )}
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {displayMessage}
                        </span>
                      </p>
                      <p
                        title={new Date(log.createdAt).toLocaleString()}
                        style={{
                          fontSize: '11px',
                          color: 'var(--text-muted)',
                          marginTop: '2px',
                        }}
                      >
                        {formatDistanceToNow(new Date(log.createdAt), {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
