import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ADMIN_SESSION_EXPIRED_EVENT } from "../data/benchmark/api";
import { fetchAuthMe, loginAdmin, logoutAdmin } from "../data/authApi";

export interface AdminAuthValue {
  /** Whether this browser session is currently logged in as admin. Always
   * true outside production (see backend AuthController.me) and false while
   * the initial /auth/me check is still in flight. */
  isAdmin: boolean;
  /** True only until the first /auth/me check resolves. */
  isLoading: boolean;
  /** Logs in against DISPATCH_PASSWORD; rejects (thrown Error, backend
   * message) on a wrong password. Refreshes isAdmin on success. */
  login: (password: string) => Promise<void>;
  /** Clears the session cookie and flips isAdmin false. */
  logout: () => Promise<void>;
}

const defaultValue: AdminAuthValue = {
  isAdmin: false,
  isLoading: false,
  login: async () => {},
  logout: async () => {},
};

/** Exported (not just the hook below) so tests can override it directly via
 * `<AdminAuthContext.Provider value={...}>` without going through a real
 * login flow. */
export const AdminAuthContext = createContext<AdminAuthValue>(defaultValue);

/** Reads the current admin session — defaults to a logged-out, non-loading
 * state when no AdminAuthProvider is mounted (e.g. a component rendered in
 * isolation in a test), so consumers never need to guard against a missing
 * provider. */
export function useAdminAuth(): AdminAuthValue {
  return useContext(AdminAuthContext);
}

/** Mounted once near the app root (see main.tsx). Checks /auth/me on mount
 * to learn whether this browser already holds a valid session cookie, and
 * listens for ADMIN_SESSION_EXPIRED_EVENT (dispatched by api.ts's
 * fetchJsonAdmin on a 401/403) to flip isAdmin false the moment a session
 * goes stale. */
export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { isAdmin: admin } = await fetchAuthMe();
    setIsAdmin(admin);
  }, []);

  useEffect(() => {
    refresh().finally(() => setIsLoading(false));
  }, [refresh]);

  useEffect(() => {
    function handleExpired() {
      setIsAdmin(false);
    }
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, handleExpired);
    return () => window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, handleExpired);
  }, []);

  const login = useCallback(
    async (password: string) => {
      await loginAdmin(password);
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await logoutAdmin();
    setIsAdmin(false);
  }, []);

  return (
    <AdminAuthContext.Provider value={{ isAdmin, isLoading, login, logout }}>
      {children}
    </AdminAuthContext.Provider>
  );
}
