import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User } from '../types';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  activeWorkspace: string;
  setActiveWorkspace: (ws: string) => void;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeWorkspace, setActiveWorkspace] = useState('');

  const refreshMe = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/me', { credentials: 'include' });
      if (!res.ok) {
        setUser(null);
        setActiveWorkspace('');
        return;
      }
      const data = (await res.json()) as User;
      setUser(data);
      setActiveWorkspace((prev) => {
        if (prev && data.workspaces.some((w) => w.id === prev)) return prev;
        return data.workspaces[0]?.id ?? '';
      });
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  const logout = useCallback(async () => {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null);
    setActiveWorkspace('');
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loading, activeWorkspace, setActiveWorkspace, logout, refreshMe }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
