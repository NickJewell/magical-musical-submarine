/**
 * CanonDuelCard — §17.9
 * Fetches a pair from GET /api/duel/next, shows two song cards with a 5-point
 * preference axis and a familiarity pick, submits to POST /api/duel.
 */

import { useState, useEffect } from 'react';
import { Loader2, Music, ExternalLink, SkipForward } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

interface DuelPair {
  aMbid: string; aTitle: string; aArtist: string; aYear: number | null;
  bMbid: string; bTitle: string; bArtist: string; bYear: number | null;
  strategy: string;
}

type Familiarity = 'both' | 'a_only' | 'b_only' | 'neither';

const PREF_OPTIONS = [
  { value: -2, label: 'Much more A' },
  { value: -1, label: 'A' },
  { value:  0, label: 'Love both / tie' },
  { value:  1, label: 'B' },
  { value:  2, label: 'Much more B' },
] as const;

const FAM_OPTIONS: Array<{ value: Familiarity; label: string }> = [
  { value: 'both',    label: 'Knew both' },
  { value: 'a_only',  label: 'Knew A only' },
  { value: 'b_only',  label: 'Knew B only' },
  { value: 'neither', label: 'New to both' },
];

interface Props {
  userId: number;
  strategy?: string;
  onDone: () => void;
}

export function CanonDuelCard({ userId, strategy = 'contrastive', onDone }: Props) {
  const [pair, setPair] = useState<DuelPair | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pref, setPref] = useState<number | null>(null);
  const [fam, setFam] = useState<Familiarity | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchPair = async () => {
    setLoading(true);
    setError(null);
    setPref(null);
    setFam(null);
    try {
      const r = await fetch(`${basePath}/api/duel/next?userId=${userId}&strategy=${strategy}`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { message?: string };
        setError(body.message ?? 'Could not load a duel pair right now.');
        return;
      }
      setPair(await r.json() as DuelPair);
    } catch {
      setError('Network error — check your connection.');
    } finally {
      setLoading(false);
    }
  };

  // Fetch on first render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchPair(); }, []);

  const canSubmit = pref !== null && fam !== null;

  const submit = async (skipResult?: { result: 0; knewA: false; knewB: false }) => {
    if (!pair) return;
    setSubmitting(true);

    const result   = skipResult?.result  ?? pref!;
    const knewA    = skipResult ? false : (fam === 'both' || fam === 'a_only');
    const knewB    = skipResult ? false : (fam === 'both' || fam === 'b_only');

    await fetch(`${basePath}/api/duel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        aMbid: pair.aMbid, bMbid: pair.bMbid,
        result, knewA, knewB,
        strategy: pair.strategy,
      }),
    }).catch(() => null);

    setSubmitting(false);
    onDone();
  };

  // ---- Loading / error states ----
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16">
        <div className="w-12 h-12 rounded-full border border-primary/30 flex items-center justify-center">
          <Loader2 className="w-5 h-5 text-primary animate-spin" />
        </div>
        <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest">Finding a duel…</p>
      </div>
    );
  }

  if (error || !pair) {
    return (
      <div className="flex flex-col items-center gap-6 py-12 text-center">
        <p className="text-sm text-muted-foreground max-w-xs">
          {error ?? 'No canon tracks available yet.'}
          {error?.includes('canon_pool') && (
            <> The pool will be built soon — skip this for now.</>
          )}
        </p>
        <Button variant="outline" size="sm" onClick={onDone}>
          Skip →
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      {/* Header */}
      <div className="text-center">
        <span className="text-[10px] font-mono text-primary/70 uppercase tracking-widest px-2.5 py-1 rounded-full border border-primary/20 bg-primary/5">
          Canon Duel
        </span>
        <p className="mt-3 text-lg font-bold text-foreground leading-snug">
          Which pulls you harder?
        </p>
        <p className="text-xs text-muted-foreground/60 mt-1">One tap — gut reaction</p>
      </div>

      {/* Two song cards */}
      <div className="grid grid-cols-2 gap-3">
        <SongCard label="A" title={pair.aTitle} artist={pair.aArtist} year={pair.aYear} mbid={pair.aMbid} highlighted={pref !== null && pref < 0} />
        <SongCard label="B" title={pair.bTitle} artist={pair.bArtist} year={pair.bYear} mbid={pair.bMbid} highlighted={pref !== null && pref > 0} />
      </div>

      {/* 5-point preference axis */}
      <div className="flex items-stretch gap-1.5">
        {PREF_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setPref(opt.value)}
            className={cn(
              'flex-1 py-2.5 rounded-xl text-[11px] font-mono leading-tight text-center transition-all border',
              pref === opt.value
                ? 'bg-primary text-primary-foreground border-primary shadow-[0_0_12px_hsla(180,80%,40%,0.3)]'
                : 'bg-secondary/20 text-muted-foreground border-border/30 hover:bg-secondary/40 hover:text-foreground',
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Familiarity (appears after preference is chosen) */}
      {pref !== null && (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
          <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-widest mb-2 text-center">
            Did you know these?
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {FAM_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setFam(opt.value)}
                className={cn(
                  'py-2 rounded-lg text-xs font-mono transition-all border',
                  fam === opt.value
                    ? 'bg-primary/20 text-primary border-primary/40'
                    : 'bg-secondary/20 text-muted-foreground border-border/30 hover:bg-secondary/30',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3 mt-1">
        <button
          onClick={() => submit({ result: 0, knewA: false, knewB: false })}
          disabled={submitting}
          className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground/60 hover:text-muted-foreground transition-colors disabled:opacity-40"
        >
          <SkipForward className="w-3.5 h-3.5" />
          Don't know these
        </button>
        <div className="flex-1" />
        <Button
          onClick={() => submit()}
          disabled={!canSubmit || submitting}
          className={cn(
            'rounded-full px-6 transition-all duration-300',
            canSubmit
              ? 'bg-primary text-primary-foreground shadow-[0_0_16px_hsla(180,80%,40%,0.25)] hover:shadow-[0_0_24px_hsla(180,80%,40%,0.4)]'
              : 'bg-secondary/40 text-muted-foreground cursor-not-allowed',
          )}
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Submit →'}
        </Button>
      </div>
    </div>
  );
}

// ---- Song card ----

interface SongCardProps {
  label: 'A' | 'B';
  title: string;
  artist: string;
  year: number | null;
  mbid: string;
  highlighted: boolean;
}

function SongCard({ label, title, artist, year, mbid, highlighted }: SongCardProps) {
  const listenUrl = `https://musicbrainz.org/recording/${mbid}`;

  return (
    <div className={cn(
      'relative flex flex-col gap-2 p-3 rounded-2xl border transition-all duration-300',
      highlighted
        ? 'border-primary/60 bg-primary/10 shadow-[0_0_16px_hsla(180,80%,40%,0.15)]'
        : 'border-border/30 bg-secondary/10',
    )}>
      {/* Side label */}
      <span className={cn(
        'absolute top-2 right-2 text-[10px] font-mono font-bold w-5 h-5 rounded-full flex items-center justify-center',
        highlighted ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 text-muted-foreground',
      )}>
        {label}
      </span>

      {/* Artwork placeholder */}
      <div className="w-full aspect-square rounded-xl bg-secondary/30 flex items-center justify-center">
        <Music className="w-8 h-8 text-muted-foreground/30" />
      </div>

      {/* Metadata */}
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm text-foreground leading-tight line-clamp-2">{title}</p>
        <p className="text-xs text-primary/80 mt-0.5 truncate">{artist}</p>
        {year && (
          <p className="text-[10px] font-mono text-muted-foreground/50 mt-1">{year}</p>
        )}
      </div>

      {/* Open link */}
      <a
        href={listenUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground/50 hover:text-primary transition-colors"
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink className="w-3 h-3" />
        MusicBrainz
      </a>
    </div>
  );
}
