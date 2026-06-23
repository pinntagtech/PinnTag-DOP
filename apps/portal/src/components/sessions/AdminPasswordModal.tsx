import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../ui/Button';
import { PasswordInput } from '../ui/PasswordInput';

export function AdminPasswordModal({
  title,
  warning,
  confirmLabel,
  confirmVariant = 'primary',
  loading = false,
  onConfirm,
  onClose,
}: {
  title: string;
  warning: string;
  confirmLabel: string;
  confirmVariant?: 'primary' | 'danger';
  loading?: boolean;
  onConfirm: (password: string) => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleConfirm = () => {
    if (!password.trim()) {
      setError('Password is required');
      return;
    }
    setError('');
    onConfirm(password);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-xl)',
          width: '420px',
          boxShadow: 'var(--shadow-lg)',
          color: 'var(--text)',
          animation: 'fadeIn 0.2s ease',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '20px 24px 16px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <h2
            style={{
              fontSize: '15px',
              fontWeight: 600,
              color: 'var(--text)',
            }}
          >
            {title}
          </h2>
          <button
            onClick={onClose}
            style={{
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              padding: '4px',
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
        >
          <p
            style={{
              fontSize: '13px',
              color: 'var(--text-secondary)',
              lineHeight: 1.5,
            }}
          >
            {warning}
          </p>

          <div>
            <label
              style={{
                display: 'block',
                marginBottom: '6px',
              }}
            >
              Admin password
            </label>
            <PasswordInput
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirm();
              }}
              placeholder="Enter admin password"
              autoFocus
              style={{
                width: '100%',
                borderColor: error ? 'var(--red)' : undefined,
              }}
            />
          </div>

          {error && (
            <p style={{ fontSize: '12px', color: 'var(--red)' }}>
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
          }}
        >
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={confirmVariant}
            loading={loading}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
