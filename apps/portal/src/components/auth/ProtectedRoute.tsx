import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

export function ProtectedRoute({
  children,
  requiredRole,
}: {
  children: React.ReactNode;
  requiredRole?: string | string[];
}) {
  const { isAuthenticated, hasRole } = useAuth();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (requiredRole && !hasRole(requiredRole)) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        <span style={{ fontSize: '32px' }}>🚫</span>
        <h2
          style={{
            fontSize: '16px',
            color: '#0A0A0A',
            margin: 0,
          }}
        >
          Access denied
        </h2>
        <p style={{ fontSize: '13px', color: '#71717A' }}>
          You don't have permission to view this page.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
