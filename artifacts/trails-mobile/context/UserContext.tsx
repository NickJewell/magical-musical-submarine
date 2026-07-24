import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getGetStateQueryOptions,
  type AppState,
} from '@workspace/api-client-react';

interface UserContextValue {
  userId: number | null;
  userName: string | null;
  appState: AppState | null;
  isLoading: boolean;
  login: (userId: number, userName: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshState: () => void;
}

const UserContext = createContext<UserContextValue | null>(null);

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [userId, setUserId] = useState<number | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    (async () => {
      try {
        const [storedId, storedName] = await Promise.all([
          AsyncStorage.getItem('userId'),
          AsyncStorage.getItem('userName'),
        ]);
        if (storedId) setUserId(Number(storedId));
        if (storedName) setUserName(storedName);
      } finally {
        setStorageLoaded(true);
      }
    })();
  }, []);

  const stateQuery = useQuery({
    ...getGetStateQueryOptions({ userId: userId ?? 0 }),
    enabled: !!userId && storageLoaded,
  });

  const login = useCallback(async (id: number, name: string) => {
    await AsyncStorage.setItem('userId', String(id));
    await AsyncStorage.setItem('userName', name);
    setUserId(id);
    setUserName(name);
  }, []);

  const logout = useCallback(async () => {
    await AsyncStorage.multiRemove(['userId', 'userName']);
    queryClient.clear();
    setUserId(null);
    setUserName(null);
  }, [queryClient]);

  const isLoading =
    !storageLoaded || (storageLoaded && !!userId && stateQuery.isPending);

  return (
    <UserContext.Provider
      value={{
        userId,
        userName,
        appState: stateQuery.data ?? null,
        isLoading,
        login,
        logout,
        refreshState: stateQuery.refetch,
      }}
    >
      {children}
    </UserContext.Provider>
  );
}

export function useUser(): UserContextValue {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useUser must be inside <UserProvider>');
  return ctx;
}
