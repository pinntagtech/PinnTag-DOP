export function Skeleton({
  className = '',
}: {
  className?: string;
}) {
  return (
    <div
      className={className}
      style={{
        background: 'var(--surface-elevated)',
        borderRadius: 'var(--radius)',
        animation: 'pulse 1.5s ease-in-out infinite',
      }}
    />
  );
}
