import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { PasswordInput } from '../components/ui/PasswordInput';

export default function LoginPage() {
  const { login, isLoading, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    if (isAuthenticated) navigate('/');
  }, [isAuthenticated, navigate]);

  useEffect(() => {
    if (sessionStorage.getItem('dop_session_expired') === '1') {
      setSessionExpired(true);
      sessionStorage.removeItem('dop_session_expired');
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await login(email, password);
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Login failed');
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        backgroundImage:
          'linear-gradient(var(--border) 1px, transparent 1px),' +
          'linear-gradient(90deg, var(--border) 1px, transparent 1px)',
        backgroundSize: '32px 32px',
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-xl)',
          padding: '40px',
          width: '100%',
          maxWidth: '380px',
          boxShadow: 'var(--shadow-lg)',
          animation: 'fadeIn 0.3s ease',
        }}
      >
        <div
          style={{
            width: '40px',
            height: '40px',
            background: 'var(--accent)',
            borderRadius: 'var(--radius)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '20px',
          }}
        >
          <span
            style={{
              color: '#ffffff',
              fontWeight: 700,
              fontSize: '18px',
            }}
          >
            P
          </span>
        </div>
        <h1
          style={{
            fontSize: '20px',
            fontWeight: 600,
            color: 'var(--text)',
            margin: 0,
            marginBottom: '4px',
          }}
        >
          PinnTag DOP
        </h1>
        <p
          style={{
            fontSize: '13px',
            color: 'var(--text-secondary)',
            marginBottom: '28px',
          }}
        >
          Data Operations Platform
        </p>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '14px' }}>
            <label
              style={{
                display: 'block',
                fontSize: '12px',
                fontWeight: 500,
                color: 'var(--text-secondary)',
                marginBottom: '6px',
              }}
            >
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@pinntag.com"
              required
              style={{
                background: 'var(--surface-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: '0 12px',
                height: '36px',
                fontSize: '13px',
                color: 'var(--text)',
                outline: 'none',
                width: '100%',
                transition: 'border-color 0.15s',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label
              style={{
                display: 'block',
                fontSize: '12px',
                fontWeight: 500,
                color: 'var(--text-secondary)',
                marginBottom: '6px',
              }}
            >
              Password
            </label>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              style={{
                background: 'var(--surface-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: '0 12px',
                height: '36px',
                fontSize: '13px',
                color: 'var(--text)',
                outline: 'none',
                width: '100%',
                transition: 'border-color 0.15s',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {sessionExpired && !error && (
            <div
              style={{
                padding: '10px 12px',
                background: 'var(--amber-subtle, rgba(245,158,11,0.12))',
                border: '1px solid var(--amber, #F59E0B)',
                borderRadius: 'var(--radius)',
                fontSize: '12px',
                color: 'var(--amber, #B45309)',
                marginBottom: '16px',
              }}
            >
              Session expired — please sign in again.
            </div>
          )}

          {error && (
            <div
              style={{
                padding: '10px 12px',
                background: 'var(--red-subtle)',
                border: '1px solid var(--red)',
                borderRadius: 'var(--radius)',
                fontSize: '12px',
                color: 'var(--red)',
                marginBottom: '16px',
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            style={{
              width: '100%',
              height: '38px',
              background: 'var(--accent)',
              color: '#ffffff',
              border: 'none',
              borderRadius: 'var(--radius)',
              fontSize: '13px',
              fontWeight: 500,
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.7 : 1,
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => {
              if (!isLoading)
                (e.currentTarget as HTMLElement).style.background =
                  'var(--accent-hover)';
            }}
            onMouseLeave={(e) => {
              if (!isLoading)
                (e.currentTarget as HTMLElement).style.background =
                  'var(--accent)';
            }}
          >
            {isLoading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
