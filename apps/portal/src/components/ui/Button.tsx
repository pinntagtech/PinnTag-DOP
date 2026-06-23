import { Loader2 } from 'lucide-react';

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: React.ReactNode;
}

const SIZES: Record<'sm' | 'md', React.CSSProperties> = {
  md: { height: '32px', padding: '0 14px', fontSize: '13px' },
  sm: { height: '26px', padding: '0 10px', fontSize: '12px' },
};

const VARIANTS: Record<
  NonNullable<ButtonProps['variant']>,
  {
    base: React.CSSProperties;
    hover: Partial<React.CSSProperties>;
  }
> = {
  primary: {
    base: {
      background: 'var(--accent)',
      color: '#ffffff',
      border: '1px solid transparent',
    },
    hover: { background: 'var(--accent-hover)' },
  },
  secondary: {
    base: {
      background: 'var(--surface-elevated)',
      color: 'var(--text)',
      border: '1px solid var(--border)',
    },
    hover: {
      borderColor: 'var(--border-strong)',
    },
  },
  danger: {
    base: {
      background: 'var(--red-subtle)',
      color: 'var(--red)',
      border: '1px solid transparent',
    },
    hover: {
      borderColor: 'var(--red)',
    },
  },
  ghost: {
    base: {
      background: 'transparent',
      color: 'var(--text-secondary)',
      border: '1px solid transparent',
    },
    hover: {
      background: 'var(--surface-elevated)',
      color: 'var(--text)',
    },
  },
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  children,
  className,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const v = VARIANTS[variant];
  const isDisabled = disabled || loading;

  return (
    <button
      className={className}
      disabled={isDisabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontWeight: 500,
        fontFamily: 'var(--font)',
        borderRadius: 'var(--radius)',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled ? 0.5 : 1,
        transition: 'all 0.15s',
        whiteSpace: 'nowrap',
        ...SIZES[size],
        ...v.base,
        ...style,
      }}
      onMouseEnter={(e) => {
        if (isDisabled) return;
        Object.assign(
          (e.currentTarget as HTMLElement).style,
          v.hover,
        );
      }}
      onMouseLeave={(e) => {
        if (isDisabled) return;
        Object.assign(
          (e.currentTarget as HTMLElement).style,
          v.base,
        );
      }}
      {...props}
    >
      {loading ? (
        <Loader2
          size={14}
          style={{ animation: 'spin 0.8s linear infinite' }}
        />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}
