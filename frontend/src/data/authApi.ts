import { apiUrl } from "./benchmark/api";

export interface AdminMe {
  isAdmin: boolean;
}

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), { ...init, credentials: "include" });
}

/** Whether this browser session is currently logged in as admin. Never
 * rejects — a network failure or non-2xx response both just mean "not
 * admin," which is the safe default to render. */
export async function fetchAuthMe(signal?: AbortSignal): Promise<AdminMe> {
  try {
    const res = await authFetch("/auth/me", { signal });
    if (!res.ok) return { isAdmin: false };
    return await res.json();
  } catch {
    return { isAdmin: false };
  }
}

/** Logs in against DISPATCH_PASSWORD — on success the backend sets the
 * signed admin_session cookie. Rejects (thrown Error, backend message) on a
 * wrong password. */
export async function loginAdmin(password: string): Promise<void> {
  const res = await authFetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message ?? "Incorrect password.");
  }
}

/** Clears the admin_session cookie. Never rejects — logging out an
 * already-logged-out session is a no-op either way. */
export async function logoutAdmin(): Promise<void> {
  await authFetch("/auth/logout", { method: "POST" }).catch(() => {});
}
