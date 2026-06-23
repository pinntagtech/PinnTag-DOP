import { NavLink } from 'react-router-dom';

export function NavItem({
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
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          height: '36px',
          padding: '0 12px',
          marginLeft: isActive ? '0' : '0',
          borderRadius: '8px',
          fontSize: '13px',
          fontWeight: isActive ? 500 : 400,
          color: isActive ? '#0A0A0A' : '#71717A',
          backgroundColor: isActive ? '#F4F4F5' : 'transparent',
          cursor: 'pointer',
          position: 'relative',
          borderLeft: isActive
            ? '2px solid #1A6BFF'
            : '2px solid transparent',
          paddingLeft: isActive ? '10px' : '10px',
          transition: 'all 150ms',
        }}>
          <span style={{
            color: isActive ? '#1A6BFF' : '#A1A1AA',
            display: 'flex',
            alignItems: 'center',
            flexShrink: 0,
          }}>
            {icon}
          </span>
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {label}
          </span>
        </div>
      )}
    </NavLink>
  );
}
