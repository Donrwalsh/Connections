import { createContext, useContext } from "react";

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
 * login flow. Kept in its own module, separate from the AdminAuthProvider
 * component in AdminAuthContext.tsx — react-refresh/only-export-components
 * requires a component file to export components only. */
export const AdminAuthContext = createContext<AdminAuthValue>(defaultValue);

/** Reads the current admin session — defaults to a logged-out, non-loading
 * state when no AdminAuthProvider is mounted (e.g. a component rendered in
 * isolation in a test), so consumers never need to guard against a missing
 * provider. */
export function useAdminAuth(): AdminAuthValue {
  return useContext(AdminAuthContext);
}
