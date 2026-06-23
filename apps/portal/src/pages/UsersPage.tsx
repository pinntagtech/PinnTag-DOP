import { useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { apiClient } from '../lib/api-client';
import { Button } from '../components/ui/Button';
import { PasswordInput } from '../components/ui/PasswordInput';

type Role = 'super_admin' | 'admin' | 'operator';
type Env = 'dev' | 'pre-prod' | 'staging' | 'production';

interface DopUser {
  _id: string;
  email: string;
  name: string;
  role: Role;
  environments: string[];
  isActive: boolean;
  isRootAdmin: boolean;
  lastLoginAt?: string;
  createdAt?: string;
}

const ROLE_COLORS: Record<Role, string> = {
  super_admin: '#0A0A0A',
  admin: '#2563EB',
  operator: '#71717A',
};

const ENV_COLORS: Record<Env, string> = {
  dev: '#2563EB',
  'pre-prod': '#059669',
  staging: '#7C3AED',
  production: '#0A0A0A',
};

const ROLE_LABEL: Record<Role, string> = {
  super_admin: 'Super admin',
  admin: 'Admin',
  operator: 'Operator',
};

export default function UsersPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<DopUser | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const usersQuery = useQuery({
    queryKey: ['dop-users'],
    queryFn: async () => {
      const { data } = await apiClient.get<DopUser[]>('/auth/users');
      return data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async (payload: {
      email: string;
      password: string;
      name: string;
      role: Role;
      environments: Env[];
    }) => {
      const { data } = await apiClient.post('/auth/users', payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dop-users'] });
      setShowCreate(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (payload: {
      id: string;
      body: {
        name?: string;
        role?: Role;
        environments?: Env[];
        isActive?: boolean;
        password?: string;
      };
    }) => {
      const { data } = await apiClient.patch(
        `/auth/users/${payload.id}`,
        payload.body,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dop-users'] });
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.delete(`/auth/users/${id}`);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dop-users'] });
    },
  });

  const users = usersQuery.data ?? [];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '20px',
        }}
      >
        <div>
          <h1
            style={{
              fontSize: '20px',
              fontWeight: 600,
              color: '#0A0A0A',
              margin: 0,
            }}
          >
            Team
          </h1>
          <p
            style={{
              fontSize: '13px',
              color: '#71717A',
              marginTop: '4px',
            }}
          >
            Manage DOP users, roles, and environment access.
          </p>
        </div>
        <Button
          variant="primary"
          icon={<Plus size={14} />}
          onClick={() => setShowCreate(true)}
        >
          New user
        </Button>
      </div>

      <div
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E4E4E7',
          borderRadius: '10px',
          overflow: 'hidden',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #E4E4E7' }}>
              {[
                'Name',
                'Email',
                'Role',
                'Environments',
                'Status',
                'Last login',
                '',
              ].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: 'left',
                    fontSize: '11px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: '#A1A1AA',
                    fontWeight: 500,
                    padding: '12px 16px',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {usersQuery.isLoading && (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    padding: '40px',
                    textAlign: 'center',
                    color: '#A1A1AA',
                    fontSize: '13px',
                  }}
                >
                  Loading users…
                </td>
              </tr>
            )}
            {!usersQuery.isLoading && users.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    padding: '40px',
                    textAlign: 'center',
                    color: '#A1A1AA',
                    fontSize: '13px',
                  }}
                >
                  No users yet.
                </td>
              </tr>
            )}
            {users.map((u) => (
              <tr
                key={u._id}
                style={{ borderBottom: '1px solid #F4F4F5' }}
              >
                <td
                  style={{
                    padding: '12px 16px',
                    fontSize: '13px',
                    fontWeight: 500,
                    color: '#0A0A0A',
                  }}
                >
                  {u.name}
                  {u.isRootAdmin && (
                    <span
                      style={{
                        marginLeft: '8px',
                        fontSize: '10px',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        backgroundColor: '#FEF3C7',
                        color: '#92400E',
                      }}
                    >
                      ROOT
                    </span>
                  )}
                </td>
                <td
                  style={{
                    padding: '12px 16px',
                    fontSize: '12px',
                    color: '#71717A',
                  }}
                >
                  {u.email}
                </td>
                <td style={{ padding: '12px 16px' }}>
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 500,
                      padding: '3px 8px',
                      borderRadius: '4px',
                      backgroundColor: ROLE_COLORS[u.role],
                      color: '#ffffff',
                    }}
                  >
                    {ROLE_LABEL[u.role]}
                  </span>
                </td>
                <td style={{ padding: '12px 16px' }}>
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '4px',
                    }}
                  >
                    {(u.environments ?? []).map((env) => (
                      <span
                        key={env}
                        style={{
                          fontSize: '10px',
                          fontWeight: 500,
                          padding: '2px 6px',
                          borderRadius: '4px',
                          backgroundColor:
                            ENV_COLORS[env as Env] ?? '#71717A',
                          color: '#ffffff',
                        }}
                      >
                        {env}
                      </span>
                    ))}
                  </div>
                </td>
                <td style={{ padding: '12px 16px' }}>
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 500,
                      padding: '3px 8px',
                      borderRadius: '4px',
                      backgroundColor: u.isActive
                        ? '#DCFCE7'
                        : '#F4F4F5',
                      color: u.isActive ? '#166534' : '#71717A',
                    }}
                  >
                    {u.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td
                  style={{
                    padding: '12px 16px',
                    fontSize: '12px',
                    color: '#71717A',
                  }}
                >
                  {u.lastLoginAt
                    ? new Date(u.lastLoginAt).toLocaleString()
                    : '—'}
                </td>
                <td
                  style={{
                    padding: '12px 16px',
                    textAlign: 'right',
                  }}
                >
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <button
                      onClick={() => setEditing(u)}
                      title="Edit"
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#71717A',
                        cursor: 'pointer',
                        padding: '4px',
                        display: 'flex',
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() =>
                        updateMutation.mutate({
                          id: u._id,
                          body: { isActive: !u.isActive },
                        })
                      }
                      disabled={u.isRootAdmin}
                      style={{
                        fontSize: '11px',
                        padding: '4px 8px',
                        background: 'none',
                        border: '1px solid #E4E4E7',
                        borderRadius: '4px',
                        color: u.isRootAdmin
                          ? '#D4D4D8'
                          : '#0A0A0A',
                        cursor: u.isRootAdmin
                          ? 'not-allowed'
                          : 'pointer',
                      }}
                    >
                      {u.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => {
                        if (
                          confirm(`Delete ${u.email}?`)
                        ) {
                          deleteMutation.mutate(u._id);
                        }
                      }}
                      disabled={u.isRootAdmin}
                      title="Delete"
                      style={{
                        background: 'none',
                        border: 'none',
                        color: u.isRootAdmin
                          ? '#D4D4D8'
                          : '#DC2626',
                        cursor: u.isRootAdmin
                          ? 'not-allowed'
                          : 'pointer',
                        padding: '4px',
                        display: 'flex',
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <UserModal
          mode="create"
          onClose={() => setShowCreate(false)}
          onSubmit={(values) => createMutation.mutate(values as any)}
          submitting={createMutation.isPending}
          error={
            (createMutation.error as Error | null)?.message
          }
        />
      )}
      {editing && (
        <UserModal
          mode="edit"
          user={editing}
          onClose={() => setEditing(null)}
          onSubmit={(values) =>
            updateMutation.mutate({
              id: editing._id,
              body: {
                name: values.name,
                role: values.role,
                environments: values.environments,
                ...(values.password
                  ? { password: values.password }
                  : {}),
              },
            })
          }
          submitting={updateMutation.isPending}
          error={
            (updateMutation.error as Error | null)?.message
          }
        />
      )}
    </div>
  );
}

function UserModal({
  mode,
  user,
  onClose,
  onSubmit,
  submitting,
  error,
}: {
  mode: 'create' | 'edit';
  user?: DopUser;
  onClose: () => void;
  onSubmit: (values: {
    email: string;
    password?: string;
    name: string;
    role: Role;
    environments: Env[];
    sendCredentials?: boolean;
  }) => void;
  submitting: boolean;
  error?: string;
}) {
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(user?.role ?? 'operator');
  const [environments, setEnvironments] = useState<Env[]>(
    (user?.environments as Env[]) ?? ['dev'],
  );
  const [sendCredentials, setSendCredentials] = useState(true);

  const toggleEnv = (env: Env) => {
    setEnvironments((prev) =>
      prev.includes(env)
        ? prev.filter((e) => e !== env)
        : [...prev, env],
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      email,
      password: password || undefined,
      name,
      role,
      environments,
      ...(mode === 'create' ? { sendCredentials } : {}),
    });
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: '#ffffff',
          width: '100%',
          maxWidth: '440px',
          borderRadius: '12px',
          padding: '24px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '16px',
          }}
        >
          <h2
            style={{
              fontSize: '16px',
              fontWeight: 600,
              color: '#0A0A0A',
              margin: 0,
            }}
          >
            {mode === 'create' ? 'New user' : 'Edit user'}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#71717A',
              padding: '4px',
              display: 'flex',
            }}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <Field label="Name">
            <input
              type="text"
              value={name}
              required
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={email}
              required
              disabled={mode === 'edit'}
              onChange={(e) => setEmail(e.target.value)}
              style={{
                ...inputStyle,
                backgroundColor:
                  mode === 'edit' ? '#F4F4F5' : '#ffffff',
              }}
            />
          </Field>
          <Field
            label={
              mode === 'edit'
                ? 'Password (leave blank to keep)'
                : 'Password'
            }
          >
            <PasswordInput
              value={password}
              required={mode === 'create'}
              onChange={(e) => setPassword(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Role">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              style={inputStyle}
            >
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
              <option value="super_admin">Super admin</option>
            </select>
          </Field>
          <Field label="Environments">
            <div style={{ display: 'flex', gap: '12px' }}>
              {(['dev', 'pre-prod', 'staging', 'production'] as Env[]).map(
                (env) => (
                  <label
                    key={env}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '13px',
                      color: '#0A0A0A',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={environments.includes(env)}
                      onChange={() => toggleEnv(env)}
                    />
                    {env}
                  </label>
                ),
              )}
            </div>
          </Field>

          {mode === 'create' && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 0',
                borderTop: '1px solid #E4E4E7',
                marginTop: '8px',
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: '13px',
                    fontWeight: 500,
                    color: '#0A0A0A',
                  }}
                >
                  Send credentials via email
                </div>
                <div
                  style={{
                    fontSize: '11px',
                    color: '#71717A',
                    marginTop: '2px',
                  }}
                >
                  Send login details to the user's email address
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  setSendCredentials((prev) => !prev)
                }
                style={{
                  width: '44px',
                  height: '24px',
                  borderRadius: '12px',
                  backgroundColor: sendCredentials
                    ? '#0A0A0A'
                    : '#E4E4E7',
                  border: 'none',
                  cursor: 'pointer',
                  position: 'relative',
                  transition: 'background-color 0.2s',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: '2px',
                    left: sendCredentials ? '22px' : '2px',
                    width: '20px',
                    height: '20px',
                    backgroundColor: '#ffffff',
                    borderRadius: '50%',
                    transition: 'left 0.2s',
                  }}
                />
              </button>
            </div>
          )}

          {error && (
            <div
              style={{
                padding: '8px 10px',
                backgroundColor: '#FEF2F2',
                border: '1px solid #FECACA',
                borderRadius: '6px',
                fontSize: '12px',
                color: '#DC2626',
                marginBottom: '12px',
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
              marginTop: '16px',
            }}
          >
            <Button variant="secondary" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              loading={submitting}
            >
              {mode === 'create' ? 'Create' : 'Save'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: '12px' }}>
      <label
        style={{
          display: 'block',
          fontSize: '12px',
          fontWeight: 500,
          color: '#0A0A0A',
          marginBottom: '4px',
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid #E4E4E7',
  borderRadius: '6px',
  fontSize: '13px',
  outline: 'none',
  boxSizing: 'border-box',
};
