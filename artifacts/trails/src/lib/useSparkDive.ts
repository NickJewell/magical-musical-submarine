import { useLocation } from 'wouter';
import { useCreateDive } from '@workspace/api-client-react';
import { useLocalUser } from '@/lib/useLocalUser';

/** A dive started from a nugget the user found, rather than their portrait alone. */
export type SparkSource =
  | { type: 'track'; mbid?: string | null; title: string; artist: string }
  | { type: 'session'; label: string; tracks: Array<{ title: string; artist: string }>; notes?: string | null };

const sparkKey = (diveId: number) => `dive-spark:${diveId}`;

/** Read (without consuming) the pending spark stashed for a freshly created dive. */
export function peekSparkSource(diveId: number): SparkSource | null {
  try {
    const raw = sessionStorage.getItem(sparkKey(diveId));
    return raw ? (JSON.parse(raw) as SparkSource) : null;
  } catch {
    return null;
  }
}

/** Clear a consumed spark so a later revisit of the dive loads normally. */
export function clearSparkSource(diveId: number): void {
  try {
    sessionStorage.removeItem(sparkKey(diveId));
  } catch { /* ignore */ }
}

/**
 * Start a brand-new dive sparked from a track or a dive section. Creates the
 * dive, stashes the source for the dive page to pick up, and navigates there.
 */
export function useSparkDive() {
  const createDive = useCreateDive();
  const [, setLocation] = useLocation();
  const { localUserId: userId } = useLocalUser();

  const start = (source: SparkSource, name: string) => {
    if (!userId || createDive.isPending) return;
    createDive.mutate(
      { data: { userId, name: name.slice(0, 60) } },
      {
        onSuccess: (dive) => {
          try {
            sessionStorage.setItem(sparkKey(dive.id), JSON.stringify(source));
          } catch { /* private mode etc. — dive still works, just as a taste dive */ }
          setLocation(`/dive/${dive.id}`);
        },
      },
    );
  };

  return { start, isPending: createDive.isPending };
}
