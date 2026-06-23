import { useState } from 'react';
import { X } from 'lucide-react';
import { useCreateSession } from '../../hooks/use-sessions';
import { Button } from '../ui/Button';
import type { Environment, SeedingModule } from '@pinntag-dop/types';

const AVAILABLE_MODULES: SeedingModule[] = [
  'business', 'outlet', 'event',
  'event-location', 'event-schedule', 'menu', 'media',
];

export function CreateSessionModal({
  onClose,
  environment,
}: {
  onClose: () => void;
  environment: Environment;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedModules, setSelectedModules] = useState<SeedingModule[]>([
    'business',
  ]);
  const [sessionType, setSessionType] = useState<'standard' | 'cvb'>(
    'standard',
  );
  const [error, setError] = useState('');

  const createSession = useCreateSession();

  const toggleModule = (mod: SeedingModule) => {
    setSelectedModules((prev) =>
      prev.includes(mod)
        ? prev.filter((m) => m !== mod)
        : [...prev, mod],
    );
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('Session name is required');
      return;
    }
    if (sessionType === 'standard' && selectedModules.length === 0) {
      setError('Select at least one module');
      return;
    }

    try {
      await createSession.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        environment,
        modules: sessionType === 'cvb' ? ['business'] : selectedModules,
        type: sessionType,
      });
      onClose();
    } catch (err: any) {
      setError(err.message ?? 'Failed to create session');
    }
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
          width: '480px',
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
            New seeding session
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
          {/* Name */}
          <div>
            <label
              style={{
                display: 'block',
                marginBottom: '6px',
              }}
            >
              Session name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError('');
              }}
              placeholder="e.g. Dallas Yoga Studios — April 2026"
              style={{ width: '100%' }}
            />
          </div>

          {/* Description */}
          <div>
            <label
              style={{
                display: 'block',
                marginBottom: '6px',
              }}
            >
              Description
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional notes about this batch"
              style={{ width: '100%' }}
            />
          </div>

          {/* Session type */}
          <div>
            <label
              style={{
                display: 'block',
                marginBottom: '8px',
              }}
            >
              Session type
            </label>
            <div style={{ display: 'flex', gap: '6px' }}>
              {(
                [
                  { value: 'standard', label: 'Standard' },
                  { value: 'cvb', label: 'CVB import' },
                ] as const
              ).map((opt) => {
                const isSelected = sessionType === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setSessionType(opt.value)}
                    onMouseEnter={(e) => {
                      if (isSelected) return;
                      const t = e.currentTarget as HTMLElement;
                      t.style.borderColor = 'var(--border-strong)';
                      t.style.color = 'var(--text)';
                    }}
                    onMouseLeave={(e) => {
                      if (isSelected) return;
                      const t = e.currentTarget as HTMLElement;
                      t.style.borderColor = 'var(--border)';
                      t.style.color = 'var(--text-secondary)';
                    }}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '12px',
                      fontWeight: isSelected ? 600 : 500,
                      border: isSelected
                        ? '1px solid var(--accent)'
                        : '1px solid var(--border)',
                      background: isSelected
                        ? 'var(--accent-subtle)'
                        : 'var(--surface-elevated)',
                      color: isSelected
                        ? 'var(--accent)'
                        : 'var(--text-secondary)',
                      cursor: 'pointer',
                      transition: 'all 150ms',
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {sessionType === 'cvb' && (
              <p
                style={{
                  fontSize: '11px',
                  color: 'var(--text-muted)',
                  marginTop: '6px',
                  lineHeight: 1.5,
                }}
              >
                Import existing CVB businesses from staging into this
                session. Modules are fixed to{' '}
                <code style={{ fontFamily: 'var(--font-mono)' }}>
                  business
                </code>
                .
              </p>
            )}
          </div>

          {/* Modules — hidden for CVB sessions */}
          {sessionType === 'standard' && (
            <div>
              <label
                style={{
                  display: 'block',
                  marginBottom: '8px',
                }}
              >
                Modules *
              </label>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '6px',
                }}
              >
                {AVAILABLE_MODULES.map((mod) => {
                  const isSelected = selectedModules.includes(mod);
                  return (
                    <button
                      key={mod}
                      onClick={() => toggleModule(mod)}
                      onMouseEnter={(e) => {
                        if (isSelected) return;
                        const t = e.currentTarget as HTMLElement;
                        t.style.borderColor = 'var(--border-strong)';
                        t.style.color = 'var(--text)';
                      }}
                      onMouseLeave={(e) => {
                        if (isSelected) return;
                        const t = e.currentTarget as HTMLElement;
                        t.style.borderColor = 'var(--border)';
                        t.style.color = 'var(--text-secondary)';
                      }}
                      style={{
                        padding: '4px 12px',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: '12px',
                        fontWeight: isSelected ? 600 : 500,
                        border: isSelected
                          ? '1px solid var(--accent)'
                          : '1px solid var(--border)',
                        background: isSelected
                          ? 'var(--accent-subtle)'
                          : 'var(--surface-elevated)',
                        color: isSelected
                          ? 'var(--accent)'
                          : 'var(--text-secondary)',
                        cursor: 'pointer',
                        transition: 'all 150ms',
                      }}
                    >
                      {mod}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Environment display */}
          <div
            style={{
              padding: '10px 14px',
              background: 'var(--surface-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span
              style={{
                fontSize: '12px',
                color: 'var(--text-secondary)',
              }}
            >
              Target environment
            </span>
            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color:
                  environment === 'production'
                    ? 'var(--red)'
                    : 'var(--text)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {environment}
            </span>
          </div>

          {/* Error */}
          {error && (
            <p
              style={{
                fontSize: '12px',
                color: 'var(--red)',
              }}
            >
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
            loading={createSession.isPending}
            onClick={handleSubmit}
          >
            Create session
          </Button>
        </div>
      </div>
    </div>
  );
}
