interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  subVariant?: 'success' | 'error' | 'neutral';
  icon?: React.ReactNode;
  iconColor?: string;
}

const SUB_COLORS = {
  success: 'var(--green)',
  error: 'var(--red)',
  neutral: 'var(--text-secondary)',
};

export function StatCard({
  label,
  value,
  sub,
  subVariant = 'neutral',
  icon,
  iconColor,
}: StatCardProps) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={(e) =>
        ((e.currentTarget as HTMLElement).style.borderColor =
          'var(--border-strong)')
      }
      onMouseLeave={(e) =>
        ((e.currentTarget as HTMLElement).style.borderColor =
          'var(--border)')
      }
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span
          style={{
            fontSize: '11px',
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
          }}
        >
          {label}
        </span>
        {icon && (
          <span
            style={{
              color: iconColor ?? 'var(--text-muted)',
              display: 'flex',
            }}
          >
            {icon}
          </span>
        )}
      </div>
      <span
        style={{
          fontSize: '32px',
          fontWeight: 600,
          color: 'var(--text)',
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
      {sub && (
        <span
          style={{
            fontSize: '12px',
            color: SUB_COLORS[subVariant],
          }}
        >
          {sub}
        </span>
      )}
    </div>
  );
}
