/**
 * Resolves the signed-in Clerk user to a local integer userId via GET /api/me.
 * Returns { localUserId, name, isLoading, isError } — null while loading or signed out.
 */
import { useQuery } from '@tanstack/react-query';
import { useUser } from '@clerk/react';

interface LocalUser {
  id: number;
  name: string;
}

async function fetchMe(): Promise<LocalUser> {
  const res = await fetch('/api/me', { credentials: 'include' });
  if (!res.ok) throw new Error(`/api/me returned ${res.status}`);
  return res.json();
}

export function useLocalUser() {
  const { isSignedIn, isLoaded } = useUser();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
    enabled: isLoaded && !!isSignedIn,
    staleTime: 5 * 60 * 1000,
    retry: 1, // one retry in case of a transient 401 on first load
  });

  return {
    localUserId: data?.id ?? null,
    name: data?.name ?? null,
    isLoading: !isLoaded || (!!isSignedIn && isLoading),
    isError: isLoaded && !!isSignedIn && isError,
  };
}
