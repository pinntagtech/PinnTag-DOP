import { clsx } from 'clsx';

export function Card({
  children,
  className,
  padding = true,
}: {
  children: React.ReactNode;
  className?: string;
  padding?: boolean;
}) {
  return (
    <div
      className={clsx(padding && 'p-5', className)}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        color: 'var(--text)',
      }}
    >
      {children}
    </div>
  );
}
