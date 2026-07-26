import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocalUser } from '@/lib/useLocalUser';
import { PairwiseSlider } from '@/components/PairwiseSlider';
import { Loader2, Scale } from 'lucide-react';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

interface Pair {
  done: boolean;
  aMbid: string; aTitle: string; aArtist: string;
  bMbid: string; bTitle: string; bArtist: string;
}

async function fetchPair(userId: number, last: { a: string; b: string } | null): Promise<Pair | null> {
  const params = new URLSearchParams({ userId: String(userId) });
  if (last) { params.set('lastA', last.a); params.set('lastB', last.b); }
  const r = await fetch(`${basePath}/api/compare/pair?${params}`);
  if (!r.ok) throw new Error('Failed to load pair');
  const d = await r.json();
  return d.done ? null : d;
}

export default function ComparePage() {
  const { localUserId: userId, isLoading } = useLocalUser();
  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center min-h-screen">
      <Loader2 className="w-8 h-8 text-primary animate-spin" />
    </div>
  );
  if (!userId) return null;
  return <CompareContent userId={userId} />;
}

function CompareContent({ userId }: { userId: number }) {
  const [pair, setPair] = useState<Pair | null>(null);
  const [loading, setLoading] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [count, setCount] = useState(0);
  const lastRef = useRef<{ a: string; b: string } | null>(null);

  const loadNext = useCallback(async () => {
    setLoading(true);
    try {
      const p = await fetchPair(userId, lastRef.current);
      if (!p) { setPair(null); setEmpty(true); }
      else { setPair(p); lastRef.current = { a: p.aMbid, b: p.bMbid }; setEmpty(false); }
    } catch {
      setEmpty(true);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { loadNext(); }, [loadNext]);

  // A comparison landed (or was skipped) → immediately serve the next one.
  const advance = (recorded: boolean) => {
    if (recorded) setCount((c) => c + 1);
    loadNext();
  };

  return (
    <div className="flex flex-col" style={{ height: 'calc(100dvh - 4rem)' }}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/30 flex items-baseline justify-between shrink-0">
        <h1 className="text-sm font-mono text-primary uppercase tracking-widest flex items-center gap-2">
          <Scale className="w-4 h-4" /> Compare
        </h1>
        <span className="text-[10px] font-mono text-muted-foreground/40 uppercase">
          {count} compared
        </span>
      </div>

      <div className="flex-1 overflow-y-auto flex items-center justify-center p-6">
        {loading && !pair ? (
          <Loader2 className="w-7 h-7 text-primary animate-spin" />
        ) : empty || !pair ? (
          <div className="flex flex-col items-center gap-4 text-center max-w-xs">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
              <Scale className="w-6 h-6 text-primary/50" />
            </div>
            <h2 className="text-xl font-serif text-foreground">Nothing to compare yet</h2>
            <p className="text-sm text-muted-foreground">
              You need at least two tracks in your rankings. Rate a few on the Rank Tracks or Home tabs, then come back.
            </p>
            <a href={`${basePath}/`} className="text-xs font-mono text-primary uppercase tracking-widest hover:underline mt-1">
              Rate some tracks →
            </a>
          </div>
        ) : (
          <div className="w-full max-w-sm">
            <PairwiseSlider
              key={`${pair.aMbid}:${pair.bMbid}`}
              userId={userId}
              aMbid={pair.aMbid} aTitle={pair.aTitle} aArtist={pair.aArtist}
              bMbid={pair.bMbid} bTitle={pair.bTitle} bArtist={pair.bArtist}
              onDone={() => advance(true)}
              onSkip={() => advance(false)}
            />
            <p className="text-center text-[10px] font-mono text-muted-foreground/40 uppercase tracking-widest mt-6">
              Keep comparing — your rankings sharpen with every pick
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
