/**
 * Resolves the signed-in Clerk user to a local integer userId via GET /api/me.
 * Passes the Clerk JWT in the Authorization header so the API server can
 * verify it in both dev and prod (cookie-only does not work with dev instances).
 */
import { useQuery } from '@tanstack/react-query';
import { useUser, useAuth } from '@clerk/react';

interface LocalUser {
  id: number;
  name: string;
}

export function useLocalUser() {
  const { isSignedIn, isLoaded } = useUser();
  const { getToken } = useAuth();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<LocalUser> => {
      const token = await getToken();
      const res = await fetch('/api/me', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`/api/me returned ${res.status}`);
      return res.json();
    },
    enabled: isLoaded && !!isSignedIn,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  return {
    localUserId: data?.id ?? null,
    name: data?.name ?? null,
    isLoading: !isLoaded || (!!isSignedIn && isLoading),
    isError: isLoaded && !!isSignedIn && isError,
  };
}
