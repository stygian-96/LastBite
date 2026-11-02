"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, errorStatus, type Profile } from "@/lib/api";

type Session = {
  me: Profile | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setMe: (me: Profile | null) => void;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.getProfile());
    } catch (err) {
      if (errorStatus(err) === 401) setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    return () => clearTimeout(first);
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.logout();
    setMe(null);
  }, []);

  const value = useMemo(() => ({ me, loading, refresh, setMe, signOut }), [me, loading, refresh, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession needs SessionProvider");
  return session;
}
