import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ADMIN_SESSION_EXPIRED_EVENT } from "../data/benchmark/api";
import { fetchAuthMe, loginAdmin, logoutAdmin } from "../data/authApi";
import { AdminAuthContext } from "./useAdminAuth";

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
