import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { SESSION_EXPIRED, api, tokenStore, unwrap, type User } from "./api/client";

interface AuthState {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState(() => tokenStore.get());

  const me = useQuery({
    queryKey: ["me", token],
    queryFn: () => unwrap(api.GET("/v1/auth/me")),
    enabled: token !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const reset = useCallback(() => {
    tokenStore.clear();
    setToken(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED, reset);
    return () => window.removeEventListener(SESSION_EXPIRED, reset);
  }, [reset]);

  const start = useCallback((session: { token: string }) => {
    tokenStore.set(session.token);
    setToken(session.token);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user: token ? (me.data ?? null) : null,
      loading: token !== null && me.isPending,
      signIn: async (email, password) => start(await unwrap(api.POST("/v1/auth/login", { body: { email, password } }))),
      register: async (email, password, name) =>
        start(await unwrap(api.POST("/v1/auth/register", { body: { email, password, ...(name ? { name } : {}) } }))),
      signOut: async () => {
        await api.POST("/v1/auth/logout").catch(() => undefined);
        reset();
      },
    }),
    [token, me.data, me.isPending, start, reset],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
