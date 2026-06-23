const STATUS_MAP: Record<
  string,
  { bg: string; color: string; label: string }
> = {
  published: {
    bg: 'var(--green-subtle)',
    color: 'var(--green)',
    label: 'Published',
  },
  draft: {
    bg: 'var(--surface-elevated)',
    color: 'var(--text-secondary)',
    label: 'Draft',
  },
  validating: {
    bg: 'var(--blue-subtle)',
    color: 'var(--blue)',
    label: 'Validating',
  },
  validated: {
    bg: 'var(--blue-subtle)',
    color: 'var(--blue)',
    label: 'Validated',
  },
  transforming: {
    bg: 'var(--accent-subtle)',
    color: 'var(--accent)',
    label: 'Transforming',
  },
  transformed: {
    bg: 'var(--accent-subtle)',
    color: 'var(--accent)',
    label: 'Transformed',
  },
  enriching: {
    bg: 'var(--purple-subtle)',
    color: 'var(--purple)',
    label: 'Enriching',
  },
  enriched: {
    bg: 'var(--purple-subtle)',
    color: 'var(--purple)',
    label: 'Enriched',
  },
  ready: {
    bg: 'var(--teal-subtle)',
    color: 'var(--teal)',
    label: 'Ready',
  },
  publishing: {
    bg: 'var(--amber-subtle)',
    color: 'var(--amber)',
    label: 'Publishing',
  },
  failed: {
    bg: 'var(--red-subtle)',
    color: 'var(--red)',
    label: 'Failed',
  },
  cancelled: {
    bg: 'var(--surface-elevated)',
    color: 'var(--text-muted)',
    label: 'Cancelled',
  },
  migrated: {
    bg: 'var(--purple-subtle)',
    color: 'var(--purple)',
    label: 'Migrated',
  },
  migrating: {
    bg: 'var(--amber-subtle)',
    color: 'var(--amber)',
    label: 'Migrating',
  },
};

export function Badge({
  status,
  className = '',
}: {
  status: string;
  className?: string;
}) {
  const s = STATUS_MAP[status?.toLowerCase()] ?? {
    bg: 'var(--surface-elevated)',
    color: 'var(--text-secondary)',
    label: status || 'Unknown',
  };
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '3px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.02em',
        background: s.bg,
        color: s.color,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: '5px',
          height: '5px',
          borderRadius: '50%',
          background: s.color,
          flexShrink: 0,
        }}
      />
      {s.label.toUpperCase()}
    </span>
  );
}
