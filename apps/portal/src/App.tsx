import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import Layout from './components/layout/Layout';
import DashboardPage from './pages/DashboardPage';
import CoveragePage from './pages/CoveragePage';
import SessionsPage from './pages/SessionsPage';
import SessionDetailPage from './pages/SessionDetailPage';
import PublishingPage from './pages/PublishingPage';
import ValidationQueuePage from './pages/ValidationQueuePage';
import LoginPage from './pages/LoginPage';
import UsersPage from './pages/UsersPage';
import AuditLogsPage from './pages/AuditLogsPage';
import LocationsPage from './pages/LocationsPage';
import StagingToProdPage from './pages/StagingToProdPage';
import DbSyncPage from './pages/DbSyncPage';
import DataRepairPage from './pages/DataRepairPage';
import ResolveBusinessPage from './pages/ResolveBusinessPage';

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="coverage" element={<CoveragePage />} />
          <Route
            path="staging-to-prod"
            element={
              <ProtectedRoute
                requiredRole={['super_admin', 'admin']}
              >
                <StagingToProdPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="db-sync"
            element={
              <ProtectedRoute
                requiredRole={['super_admin', 'admin']}
              >
                <DbSyncPage />
              </ProtectedRoute>
            }
          />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="sessions/:id" element={<SessionDetailPage />} />
          <Route path="publishing" element={<PublishingPage />} />
          <Route path="validation" element={<ValidationQueuePage />} />
          <Route
            path="users"
            element={
              <ProtectedRoute requiredRole="super_admin">
                <UsersPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="locations"
            element={
              <ProtectedRoute requiredRole="super_admin">
                <LocationsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="audit-logs"
            element={
              <ProtectedRoute
                requiredRole={['super_admin', 'admin']}
              >
                <AuditLogsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="data-repair"
            element={
              <ProtectedRoute
                requiredRole={['super_admin', 'admin']}
              >
                <DataRepairPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="resolve-business"
            element={
              <ProtectedRoute
                requiredRole={['super_admin', 'admin']}
              >
                <ResolveBusinessPage />
              </ProtectedRoute>
            }
          />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
