import { useState, useRef, useEffect } from 'react';
import { Outlet, useLocation, useNavigate, NavLink } from 'react-router-dom';
import { Bell, Moon, Sun } from 'lucide-react';
import {
  LayoutDashboard, Layers, Building2, MapPin,
  Calendar, UtensilsCrossed, Image, ShieldCheck,
  Sparkles, Send, Server, Users, ClipboardList, Trophy,
  ArrowRightLeft, Database, Wrench, Globe,
} from 'lucide-react';
import { useEnvironment } from '../../contexts/EnvironmentContext';
import { useAuth } from '../../contexts/AuthContext';

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/coverage': 'Coverage',
  '/staging-to-prod': 'Staging → Prod',
  '/db-sync': 'DB Sync',
  '/sessions': 'Seeding sessions',
  '/businesses': 'Businesses',
  '/outlets': 'Outlets',
  '/events': 'Events',
  '/menus': 'Menus',
  '/media': 'Media',
  '/validation': 'Validation queue',
  '/enrichment': 'Enrichment',
  '/publishing': 'Publishing',
  '/settings/environments': 'Environments',
  '/settings/team': 'Team',
  '/users': 'Team',
  '/locations': 'Locations',
  '/audit-logs': 'Audit logs',
  '/data-repair': 'Data Repair',
  '/resolve-business': 'Resolve from Google',
};

const ENV_STYLES: Record<
  string,
  { bg: string; color: string; dot: string; label: string }
> = {
  dev: { bg: '#1C3557', color: '#60A5FA', dot: '#3B82F6', label: 'Dev' },
  'pre-prod': {
    bg: '#2D3748',
    color: '#68D391',
    dot: '#48BB78',
    label: 'Pre-prod',
  },
  staging: {
    bg: '#2E1F47',
    color: '#C084FC',
    dot: '#A855F7',
    label: 'Staging',
  },
  production: {
    bg: '#1A1A1A',
    color: '#D4D4D8',
    dot: '#71717A',
    label: 'Production',
  },
};

function SidebarItem({
  to,
  icon,
  label,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <NavLink to={to} style={{ textDecoration: 'none' }}>
      {({ isActive }) => (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '0 12px',
            height: '34px',
            borderRadius: 'var(--radius)',
            fontSize: '13px',
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 0.15s',
            position: 'relative',
            color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
            background: isActive ? 'var(--accent-subtle)' : 'transparent',
            borderLeft: isActive
              ? '2px solid var(--accent)'
              : '2px solid transparent',
            paddingLeft: '10px',
          }}
          onMouseEnter={(e) => {
            if (!isActive) {
              (e.currentTarget as HTMLElement).style.background =
                'var(--surface-elevated)';
            }
          }}
          onMouseLeave={(e) => {
            if (!isActive) {
              (e.currentTarget as HTMLElement).style.background =
                'transparent';
            }
          }}
        >
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              flexShrink: 0,
              color: isActive ? 'var(--accent)' : 'var(--text-muted)',
            }}
          >
            {icon}
          </span>
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </span>
        </div>
      )}
    </NavLink>
  );
}

const sectionLabelStyle: React.CSSProperties = {
  fontSize: '10px',
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  padding: '16px 12px 6px',
};

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { environment, setEnvironment } = useEnvironment();
  const { user, logout, theme, toggleTheme } = useAuth();
  const [envDropdownOpen, setEnvDropdownOpen] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const envDropdownRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        envDropdownRef.current &&
        !envDropdownRef.current.contains(e.target as Node)
      ) {
        setEnvDropdownOpen(false);
      }
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(e.target as Node)
      ) {
        setShowUserMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () =>
      document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const pageTitle =
    Object.entries(PAGE_TITLES).find(([path]) =>
      location.pathname.startsWith(path),
    )?.[1] ?? 'PinnTag DOP';

  const initials =
    (user?.name ?? 'U')
      .split(' ')
      .map((s) => s.charAt(0).toUpperCase())
      .join('')
      .slice(0, 2) || 'U';

  const env = ENV_STYLES[environment] ?? ENV_STYLES.dev;

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--text)',
      }}
    >
      {/* Sidebar */}
      <aside
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          height: '100vh',
          width: '220px',
          background: 'var(--surface)',
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 20,
        }}
      >
        {/* Logo */}
        <div
          style={{
            height: '56px',
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: '26px',
              height: '26px',
              background: 'var(--accent)',
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: '10px',
            }}
          >
            <span
              style={{
                color: '#ffffff',
                fontSize: '12px',
                fontWeight: 700,
              }}
            >
              P
            </span>
          </div>
          <span
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--text)',
            }}
          >
            PinnTag DOP
          </span>
          <span
            style={{
              marginLeft: '8px',
              fontSize: '10px',
              color: 'var(--text-muted)',
              padding: '1px 5px',
              border: '1px solid var(--border)',
              borderRadius: '4px',
            }}
          >
            v1.0
          </span>
        </div>

        {/* Nav */}
        <nav
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '4px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          <p style={sectionLabelStyle}>Overview</p>
          <SidebarItem
            to="/dashboard"
            icon={<LayoutDashboard size={15} />}
            label="Dashboard"
          />
          <SidebarItem
            to="/coverage"
            icon={<Trophy size={15} />}
            label="Coverage"
          />
          {(user?.role === 'super_admin' ||
            user?.role === 'admin') && (
            <SidebarItem
              to="/staging-to-prod"
              icon={<ArrowRightLeft size={15} />}
              label="Staging → Prod"
            />
          )}
          {(user?.role === 'super_admin' ||
            user?.role === 'admin') && (
            <SidebarItem
              to="/db-sync"
              icon={<Database size={15} />}
              label="DB Sync"
            />
          )}

          <p style={sectionLabelStyle}>Data</p>
          <SidebarItem
            to="/sessions"
            icon={<Layers size={15} />}
            label="Seeding sessions"
          />
          <SidebarItem
            to="/businesses"
            icon={<Building2 size={15} />}
            label="Businesses"
          />
          <SidebarItem
            to="/outlets"
            icon={<MapPin size={15} />}
            label="Outlets"
          />
          <SidebarItem
            to="/events"
            icon={<Calendar size={15} />}
            label="Events"
          />
          <SidebarItem
            to="/menus"
            icon={<UtensilsCrossed size={15} />}
            label="Menus"
          />
          <SidebarItem
            to="/media"
            icon={<Image size={15} />}
            label="Media"
          />

          <p style={sectionLabelStyle}>Pipeline</p>
          <SidebarItem
            to="/validation"
            icon={<ShieldCheck size={15} />}
            label="Validation queue"
          />
          <SidebarItem
            to="/enrichment"
            icon={<Sparkles size={15} />}
            label="Enrichment"
          />
          <SidebarItem
            to="/publishing"
            icon={<Send size={15} />}
            label="Publishing"
          />

          <p style={sectionLabelStyle}>Settings</p>
          <SidebarItem
            to="/settings/environments"
            icon={<Server size={15} />}
            label="Environments"
          />
          {user?.role === 'super_admin' && (
            <SidebarItem
              to="/users"
              icon={<Users size={15} />}
              label="Team"
            />
          )}
          {user?.role === 'super_admin' && (
            <SidebarItem
              to="/locations"
              icon={<MapPin size={15} />}
              label="Locations"
            />
          )}
          {(user?.role === 'super_admin' ||
            user?.role === 'admin') && (
            <SidebarItem
              to="/audit-logs"
              icon={<ClipboardList size={15} />}
              label="Audit logs"
            />
          )}
          {(user?.role === 'super_admin' ||
            user?.role === 'admin') && (
            <SidebarItem
              to="/data-repair"
              icon={<Wrench size={15} />}
              label="Data Repair"
            />
          )}
          {(user?.role === 'super_admin' ||
            user?.role === 'admin') && (
            <SidebarItem
              to="/resolve-business"
              icon={<Globe size={15} />}
              label="Resolve from Google"
            />
          )}
        </nav>

        {/* User menu */}
        <div
          ref={userMenuRef}
          style={{
            borderTop: '1px solid var(--border)',
            padding: '8px',
            position: 'relative',
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => setShowUserMenu((prev) => !prev)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '6px 8px',
              background: 'transparent',
              border: 'none',
              borderRadius: 'var(--radius)',
              cursor: 'pointer',
              width: '100%',
              color: 'var(--text)',
            }}
          >
            <div
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                background: 'var(--accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  color: '#ffffff',
                  fontSize: '11px',
                  fontWeight: 600,
                }}
              >
                {initials}
              </span>
            </div>
            <div style={{ textAlign: 'left', flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: '12px',
                  fontWeight: 500,
                  color: 'var(--text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {user?.name || 'User'}
              </div>
              <div
                style={{
                  fontSize: '10px',
                  color: 'var(--text-muted)',
                  textTransform: 'capitalize',
                }}
              >
                {user?.role?.replace('_', ' ') || ''}
              </div>
            </div>
          </button>

          {showUserMenu && (
            <div
              style={{
                position: 'absolute',
                bottom: '100%',
                left: '8px',
                right: '8px',
                background: 'var(--surface-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: '4px',
                marginBottom: '4px',
                boxShadow: 'var(--shadow-lg)',
                zIndex: 50,
                animation: 'fadeIn 0.15s ease',
              }}
            >
              <div
                style={{
                  padding: '8px 10px',
                  fontSize: '12px',
                  color: 'var(--text-muted)',
                  borderBottom: '1px solid var(--border)',
                  marginBottom: '4px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {user?.email}
              </div>
              {user?.role === 'super_admin' && (
                <button
                  onClick={() => {
                    setShowUserMenu(false);
                    navigate('/users');
                  }}
                  style={menuItemStyle('var(--text)')}
                >
                  User management
                </button>
              )}
              {(user?.role === 'super_admin' ||
                user?.role === 'admin') && (
                <button
                  onClick={() => {
                    setShowUserMenu(false);
                    navigate('/audit-logs');
                  }}
                  style={menuItemStyle('var(--text)')}
                >
                  Audit logs
                </button>
              )}
              <button
                onClick={() => {
                  setShowUserMenu(false);
                  logout();
                }}
                style={menuItemStyle('var(--red)')}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Header */}
      <header
        style={{
          position: 'fixed',
          top: 0,
          left: '220px',
          right: 0,
          height: '52px',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
        }}
      >
        <h1
          style={{
            fontSize: '14px',
            fontWeight: 600,
            color: 'var(--text)',
            margin: 0,
          }}
        >
          {pageTitle}
        </h1>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          {/* Env switcher */}
          <div ref={envDropdownRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setEnvDropdownOpen((prev) => !prev)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '0 12px',
                height: '28px',
                borderRadius: 'var(--radius)',
                fontSize: '12px',
                fontWeight: 600,
                letterSpacing: '0.02em',
                border: 'none',
                cursor: 'pointer',
                transition: 'all 0.15s',
                background: env.bg,
                color: env.color,
              }}
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: env.dot,
                  flexShrink: 0,
                }}
              />
              {env.label}
              <span
                style={{
                  fontSize: '9px',
                  opacity: 0.7,
                  marginLeft: '2px',
                }}
              >
                ▼
              </span>
            </button>

            {envDropdownOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  right: 0,
                  background: 'var(--surface-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  padding: '4px',
                  zIndex: 50,
                  minWidth: '160px',
                  boxShadow: 'var(--shadow-lg)',
                  animation: 'fadeIn 0.15s ease',
                }}
              >
                {(['production', 'staging', 'pre-prod', 'dev'] as const).map(
                  (value) => {
                    const opt = ENV_STYLES[value];
                    const active = environment === value;
                    return (
                      <button
                        key={value}
                        onClick={() => {
                          setEnvironment(value);
                          setEnvDropdownOpen(false);
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          width: '100%',
                          padding: '8px 10px',
                          background: active
                            ? 'var(--accent-subtle)'
                            : 'transparent',
                          border: 'none',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: '12px',
                          fontWeight: active ? 600 : 500,
                          color: active ? 'var(--accent)' : 'var(--text)',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <span
                          style={{
                            width: '6px',
                            height: '6px',
                            borderRadius: '50%',
                            background: opt.dot,
                            flexShrink: 0,
                          }}
                        />
                        {opt.label}
                        {active && (
                          <span
                            style={{
                              marginLeft: 'auto',
                              fontSize: '11px',
                            }}
                          >
                            ✓
                          </span>
                        )}
                      </button>
                    );
                  },
                )}
              </div>
            )}
          </div>

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            title={
              theme === 'dark' ? 'Switch to light' : 'Switch to dark'
            }
            style={{
              width: '28px',
              height: '28px',
              borderRadius: 'var(--radius)',
              background: 'var(--surface-elevated)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
              transition: 'all 0.15s',
            }}
          >
            {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
          </button>

          {/* Bell */}
          <button
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
            }}
          >
            <Bell size={16} />
          </button>

          {/* Avatar */}
          <div
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '50%',
              background: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                color: '#ffffff',
                fontSize: '11px',
                fontWeight: 600,
              }}
            >
              {initials}
            </span>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main
        style={{
          marginLeft: '220px',
          marginTop: '52px',
          flex: 1,
          minHeight: 'calc(100vh - 52px)',
          padding: '24px',
          background: 'var(--bg)',
          color: 'var(--text)',
        }}
      >
        <Outlet />
      </main>
    </div>
  );
}

const menuItemStyle = (color: string): React.CSSProperties => ({
  display: 'block',
  width: '100%',
  padding: '7px 10px',
  fontSize: '12px',
  color,
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  textAlign: 'left',
});
