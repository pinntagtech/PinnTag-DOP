import {
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react';

interface DopUser {
  id: string;
  email: string;
  name: string;
  role: 'super_admin' | 'admin' | 'operator';
  environments: string[];
  lastLoginAt?: string;
}

type Theme = 'dark' | 'light';

interface AuthContextType {
  user: DopUser | null;
  accessToken: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  hasRole: (role: string | string[]) => boolean;
  hasEnvAccess: (env: string) => boolean;
  theme: Theme;
  toggleTheme: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

const ACCESS_TOKEN_KEY = 'dop_access_token';
const REFRESH_TOKEN_KEY = 'dop_refresh_token';
const USER_KEY = 'dop_user';
const THEME_KEY = 'dop_theme';

function apiBase(): string {
  return (
    (import.meta.env.VITE_API_URL as string | undefined) ||
    'https://dop-api.pinntag.com'
  );
}

export function AuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [user, setUser] = useState<DopUser | null>(() => {
    const stored = localStorage.getItem(USER_KEY);
    return stored ? JSON.parse(stored) : null;
  });
  const [accessToken, setAccessToken] = useState<string | null>(
    () => localStorage.getItem(ACCESS_TOKEN_KEY),
  );
  const [isLoading, setIsLoading] = useState(false);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(THEME_KEY) as Theme) || 'dark',
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const login = async (
    email: string,
    password: string,
  ): Promise<void> => {
    setIsLoading(true);
    try {
      const response = await fetch(
        `${apiBase()}/api/v1/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        },
      );

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || 'Login failed');
      }

      const data = await response.json();

      localStorage.setItem(ACCESS_TOKEN_KEY, data.accessToken);
      localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      sessionStorage.removeItem('dop_session_expired');

      setAccessToken(data.accessToken);
      setUser(data.user);
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async (): Promise<void> => {
    try {
      const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
      if (refreshToken && accessToken) {
        await fetch(`${apiBase()}/api/v1/auth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ refreshToken }),
        });
      }
    } catch {
      // ignore
    }

    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setAccessToken(null);
    setUser(null);
  };

  const hasRole = (role: string | string[]): boolean => {
    if (!user) return false;
    if (user.role === 'super_admin') return true;
    if (Array.isArray(role)) return role.includes(user.role);
    return user.role === role;
  };

  const hasEnvAccess = (env: string): boolean => {
    if (!user) return false;
    if (user.role === 'super_admin') return true;
    return user.environments?.includes(env) ?? false;
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        accessToken,
        isLoading,
        isAuthenticated: !!user && !!accessToken,
        login,
        logout,
        hasRole,
        hasEnvAccess,
        theme,
        toggleTheme,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
