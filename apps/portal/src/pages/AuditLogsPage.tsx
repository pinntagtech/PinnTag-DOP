import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { apiClient } from '../lib/api-client';
import { Button } from '../components/ui/Button';

interface AuditLog {
  _id: string;
  userId?: string;
  userEmail: string;
  userName: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, any>;
  environment?: string;
  ip?: string;
  userAgent?: string;
  outcome: 'success' | 'failure' | 'warning';
  createdAt: string;
}

const OUTCOME_COLORS: Record<string, { bg: string; fg: string }> = {
  success: { bg: '#DCFCE7', fg: '#166534' },
  failure: { bg: '#FEF2F2', fg: '#DC2626' },
  warning: { bg: '#FEF3C7', fg: '#92400E' },
};

const RESOURCES = [
  'session',
  'record',
  'cvb',
  'bot',
  'user',
  'auth',
];

export default function AuditLogsPage() {
  const [action, setAction] = useState('');
  const [resource, setResource] = useState('');
  const [environment, setEnvironment] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [committedFilters, setCommittedFilters] = useState({
    action: '',
    resource: '',
    environment: '',
    from: '',
    to: '',
    page: 1,
  });
  const [expanded, setExpanded] = useState<string | null>(null);

  const logsQuery = useQuery({
    queryKey: ['audit-logs', committedFilters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (committedFilters.action)
        params.set('action', committedFilters.action);
      if (committedFilters.resource)
        params.set('resource', committedFilters.resource);
      if (committedFilters.environment)
        params.set('environment', committedFilters.environment);
      if (committedFilters.from)
        params.set('from', committedFilters.from);
      if (committedFilters.to)
        params.set('to', committedFilters.to);
      params.set('page', String(committedFilters.page));
      params.set('limit', '50');
      const { data } = await apiClient.get(
        `/auth/audit-logs?${params}`,
      );
      return data as {
        logs: AuditLog[];
        total: number;
        page: number;
        pages: number;
      };
    },
  });

  const handleSearch = () => {
    setPage(1);
    setCommittedFilters({
      action,
      resource,
      environment,
      from,
      to,
      page: 1,
    });
  };

  const goToPage = (next: number) => {
    setPage(next);
    setCommittedFilters((prev) => ({ ...prev, page: next }));
  };

  const logs = logsQuery.data?.logs ?? [];
  const pages = logsQuery.data?.pages ?? 1;

  return (
    <div>
      <div style={{ marginBottom: '20px' }}>
        <h1
          style={{
            fontSize: '20px',
            fontWeight: 600,
            color: '#0A0A0A',
            margin: 0,
          }}
        >
          Audit logs
        </h1>
        <p
          style={{
            fontSize: '13px',
            color: '#71717A',
            marginTop: '4px',
          }}
        >
          Track every mutating action across the platform.
        </p>
      </div>

      <div
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E4E4E7',
          borderRadius: '10px',
          padding: '12px 16px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px',
          alignItems: 'center',
          marginBottom: '12px',
        }}
      >
        <input
          type="text"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="Action (e.g. session.publish)"
          style={{ ...inputStyle, width: '220px' }}
        />
        <select
          value={resource}
          onChange={(e) => setResource(e.target.value)}
          style={inputStyle}
        >
          <option value="">All resources</option>
          {RESOURCES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          value={environment}
          onChange={(e) => setEnvironment(e.target.value)}
          style={inputStyle}
        >
          <option value="">All environments</option>
          <option value="dev">dev</option>
          <option value="staging">staging</option>
          <option value="production">production</option>
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          style={inputStyle}
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          style={inputStyle}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={handleSearch}
          loading={logsQuery.isFetching}
        >
          Search
        </Button>
      </div>

      <div
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E4E4E7',
          borderRadius: '10px',
          overflow: 'hidden',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #E4E4E7' }}>
              {[
                'Timestamp',
                'User',
                'Action',
                'Resource',
                'Environment',
                'Outcome',
                'Details',
              ].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: 'left',
                    fontSize: '11px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: '#A1A1AA',
                    fontWeight: 500,
                    padding: '12px 16px',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {logsQuery.isLoading && (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    padding: '40px',
                    textAlign: 'center',
                    color: '#A1A1AA',
                    fontSize: '13px',
                  }}
                >
                  Loading…
                </td>
              </tr>
            )}
            {!logsQuery.isLoading && logs.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    padding: '40px',
                    textAlign: 'center',
                    color: '#A1A1AA',
                    fontSize: '13px',
                  }}
                >
                  No audit entries match your filters.
                </td>
              </tr>
            )}
            {logs.map((l) => {
              const oc = OUTCOME_COLORS[l.outcome] ??
                OUTCOME_COLORS.success;
              const isOpen = expanded === l._id;
              return (
                <>
                  <tr
                    key={l._id}
                    style={{ borderBottom: '1px solid #F4F4F5' }}
                  >
                    <td
                      style={{
                        padding: '12px 16px',
                        fontSize: '12px',
                        color: '#71717A',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {new Date(l.createdAt).toLocaleString()}
                    </td>
                    <td
                      style={{
                        padding: '12px 16px',
                        fontSize: '12px',
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 500,
                          color: '#0A0A0A',
                        }}
                      >
                        {l.userName}
                      </div>
                      <div style={{ color: '#71717A' }}>
                        {l.userEmail}
                      </div>
                    </td>
                    <td
                      style={{
                        padding: '12px 16px',
                        fontSize: '12px',
                        fontFamily: 'monospace',
                        color: '#0A0A0A',
                      }}
                    >
                      {l.action}
                    </td>
                    <td
                      style={{
                        padding: '12px 16px',
                        fontSize: '12px',
                        color: '#71717A',
                      }}
                    >
                      {l.resource}
                    </td>
                    <td
                      style={{
                        padding: '12px 16px',
                        fontSize: '12px',
                        color: '#71717A',
                      }}
                    >
                      {l.environment || '—'}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: 500,
                          padding: '3px 8px',
                          borderRadius: '4px',
                          backgroundColor: oc.bg,
                          color: oc.fg,
                          textTransform: 'capitalize',
                        }}
                      >
                        {l.outcome}
                      </span>
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <button
                        onClick={() =>
                          setExpanded(isOpen ? null : l._id)
                        }
                        style={{
                          fontSize: '12px',
                          color: '#2563EB',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 0,
                        }}
                      >
                        {isOpen ? 'Hide' : 'View'}
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr
                      key={`${l._id}-details`}
                      style={{ borderBottom: '1px solid #F4F4F5' }}
                    >
                      <td
                        colSpan={7}
                        style={{
                          padding: '12px 16px',
                          backgroundColor: '#FAFAFA',
                        }}
                      >
                        <pre
                          style={{
                            margin: 0,
                            fontSize: '11px',
                            color: '#0A0A0A',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                          }}
                        >
                          {JSON.stringify(
                            {
                              resourceId: l.resourceId,
                              ip: l.ip,
                              userAgent: l.userAgent,
                              details: l.details,
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>

        {logs.length > 0 && (
          <div
            style={{
              padding: '10px 16px',
              borderTop: '1px solid #E4E4E7',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '12px',
              color: '#71717A',
            }}
          >
            <button
              onClick={() => goToPage(Math.max(1, page - 1))}
              disabled={page <= 1}
              style={paginationBtnStyle(page <= 1)}
            >
              <ChevronLeft size={12} /> Previous
            </button>
            <span>
              Page {page} of {pages}
            </span>
            <button
              onClick={() => goToPage(Math.min(pages, page + 1))}
              disabled={page >= pages}
              style={paginationBtnStyle(page >= pages)}
            >
              Next <ChevronRight size={12} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  height: '32px',
  padding: '0 10px',
  border: '1px solid #E4E4E7',
  borderRadius: '6px',
  fontSize: '13px',
  outline: 'none',
  backgroundColor: '#ffffff',
  color: '#0A0A0A',
};

const paginationBtnStyle = (
  disabled: boolean,
): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '4px 10px',
  background: 'none',
  border: '1px solid #E4E4E7',
  borderRadius: '6px',
  fontSize: '12px',
  color: disabled ? '#D4D4D8' : '#0A0A0A',
  cursor: disabled ? 'not-allowed' : 'pointer',
});
