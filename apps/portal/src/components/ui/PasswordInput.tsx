import { forwardRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

type PasswordInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type'
>;

export const PasswordInput = forwardRef<
  HTMLInputElement,
  PasswordInputProps
>(function PasswordInput(
  { style, disabled, ...props },
  ref,
) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <input
        {...props}
        ref={ref}
        type={visible ? 'text' : 'password'}
        disabled={disabled}
        style={{
          width: '100%',
          ...style,
          paddingRight: '36px',
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        aria-label={visible ? 'Hide password' : 'Show password'}
        title={visible ? 'Hide password' : 'Show password'}
        style={{
          position: 'absolute',
          top: '50%',
          right: '4px',
          transform: 'translateY(-50%)',
          height: '28px',
          width: '28px',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-secondary)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Icon size={16} />
      </button>
    </div>
  );
});
