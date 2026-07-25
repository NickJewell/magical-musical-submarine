import { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocalUser } from '@/lib/useLocalUser';
import {
  Loader2, Star, Trophy, ArrowUp, ArrowDown, Swords, Radio,
} from 'lucide-react';
import { InlinePlayer, type ResolvedLinks } from '@/components/InlinePlayer';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

// ---- Types ----

interface Elo {
  rating: number;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
}

interface RankTrack {
  mbid: string;
  type: string;
  title: string;
  artist: string;
  stars: number | null;
  listenState: string | null;
  reviewText: string | null;
  ratedAt: string | null;
  elo: Elo;
  recId: number | null;
  linksJson: Record<string, unknown> | null;
  artworkUrl: string | null;
}

type SortKey = 'stars' | 'elo' | 'matches' | 'title';
type SortDir = 'asc' | 'desc';

// ---- Fetch helpers ----

async function fetchRankings(userId: number): Promise<RankTrack[]> {
  const r = await fetch(`${basePath}/api/rankings?userId=${userId}`);
  if (!r.ok) throw new Error('Failed to load rankings');
  const d = await r.json();
  return d.tracks as RankTrack[];
}

async function rateByRec(userId: number, recId: number, listenState: string, score: number): Promise<void> {
  const r = await fetch(`${basePath}/api/rate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, recId, listenState, score }),
  });
  if (!r.ok) throw new Error('Failed to save rating');
}

async function rateByFocus(
  userId: number, mbid: string, title: string, artist: string, listenState: string, score: number,
): Promise<void> {
  const r = await fetch(`${basePath}/api/focus-rating`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, mbid, title, artist, listenState, score }),
  });
  if (!r.ok) throw new Error('Failed to save rating');
}

function linksToResolved(linksJson: Record<string, unknown> | null): ResolvedLinks | null {
  if (!linksJson) return null;
  return {
    spotify:        (linksJson.spotify        as string | null) ?? null,
    youtube:        (linksJson.youtube        as string | null) ?? null,
    spotifyTrackId: (linksJson.spotifyTrackId as string | null) ?? null,
    youtubeVideoId: (linksJson.youtubeVideoId as string | null) ?? null,
    deezerId:       (linksJson.deezerId       as string | null) ?? null,
  };
}

// ---- Editable stars ----

function StarPicker({
  score, onPick, saving,
}: { score: number | null; onPick: (s: number) => void; saving: boolean }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3].map((s) => (
        <button
          key={s}
          onClick={(e) => { e.stopPropagation(); onPick(s); }}
          disabled={saving}
          className="transition-transform hover:scale-110 disabled:opacity-50 p-0.5"
          title={`${s}/3`}
        >
          <Star
            className={`w-4 h-4 transition-colors ${
              score !== null && s <= score
                ? 'fill-amber-400 text-amber-400'
                : 'fill-transparent text-muted-foreground/30 hover:text-amber-400/60'
            }`}
          />
        </button>
      ))}
      {saving && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground/50 ml-1" />}
    </div>
  );
}

// ---- ELO badge ----

function EloBadge({ elo }: { elo: Elo }) {
  const unranked = elo.matches === 0;
  return (
    <div className="flex flex-col items-end leading-tight">
      <span
        className={`font-mono text-sm tabular-nums ${unranked ? 'text-muted-foreground/40' : 'text-primary/90'}`}
        title="Head-to-head ELO"
      >
        {Math.round(elo.rating)}
      </span>
      <span className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-wide text-muted-foreground/40">
        {unranked ? (
          'unranked'
        ) : (
          <>
            <Swords className="w-2.5 h-2.5" />
            {elo.wins}–{elo.losses}{elo.draws ? `–${elo.draws}` : ''}
          </>
        )}
      </span>
    </div>
  );
}

// ---- Row ----

function RankRow({
  track, rank, userId, activeIdx, index, onActivate, onRated,
}: {
  track: RankTrack;
  rank: number;
  userId: number;
  activeIdx: number | null;
  index: number;
  onActivate: (idx: number | null) => void;
  onRated: (mbid: string, score: number) => void;
}) {
  const [links, setLinks] = useState<ResolvedLinks | null>(() => linksToResolved(track.linksJson));
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  const handleNeedLinks = useCallback(async () => {
    if (loadingLinks) return;
    if (links?.spotifyTrackId || links?.youtubeVideoId || links?.deezerId) return;
    setLoadingLinks(true);
    try {
      const params = new URLSearchParams({
        mbid: track.mbid, type: track.type, title: track.title, artist: track.artist,
      });
      const r = await fetch(`${basePath}/api/links?${params}`);
      if (r.ok) setLinks(await r.json());
    } finally {
      setLoadingLinks(false);
    }
  }, [track.mbid, track.type, track.title, track.artist, links, loadingLinks]);

  const handlePick = async (s: number) => {
    setSaving(true);
    setError(false);
    const listenState = track.listenState ?? 'known';
    try {
      if (track.recId != null) {
        await rateByRec(userId, track.recId, listenState, s);
      } else {
        await rateByFocus(userId, track.mbid, track.title, track.artist, listenState, s);
      }
      onRated(track.mbid, s);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const artwork = (links as (ResolvedLinks & { artworkUrl?: string | null }) | null)?.artworkUrl ?? track.artworkUrl;

  return (
    <div className="border-b border-border/20">
      <div className="flex items-center gap-3 px-3 py-2.5">
        {/* Rank */}
        <span className="w-6 text-right font-mono text-xs text-muted-foreground/40 tabular-nums shrink-0">
          {rank}
        </span>

        {/* Artwork */}
        <div className="w-9 h-9 rounded-md bg-secondary/50 border border-primary/10 overflow-hidden relative flex items-center justify-center shrink-0">
          <span className="text-xs font-mono font-bold text-primary/20 absolute">
            {(track.artist[0] ?? track.title[0] ?? '?').toUpperCase()}
          </span>
          {artwork && (
            <img
              src={artwork}
              alt=""
              className="w-full h-full object-cover relative"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          )}
        </div>

        {/* Title + artist + preview */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate leading-snug">{track.title}</p>
          <p className="text-xs text-muted-foreground truncate">{track.artist}</p>
          <div className="mt-1">
            <InlinePlayer
              recId={index}
              links={links}
              isLoadingLinks={loadingLinks}
              onNeedLinks={handleNeedLinks}
              activeRecId={activeIdx}
              onActivate={onActivate}
            />
          </div>
        </div>

        {/* Stars */}
        <div className="shrink-0">
          <StarPicker score={track.stars} onPick={handlePick} saving={saving} />
          {error && <p className="text-[9px] text-destructive mt-0.5">retry</p>}
        </div>

        {/* ELO */}
        <div className="shrink-0 w-14">
          <EloBadge elo={track.elo} />
        </div>
      </div>
    </div>
  );
}

// ---- Sort header ----

function SortHeader({
  label, active, dir, onClick, className = '',
}: {
  label: string; active: boolean; dir: SortDir; onClick: () => void; className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest transition-colors ${
        active ? 'text-primary' : 'text-muted-foreground/50 hover:text-muted-foreground'
      } ${className}`}
    >
      {label}
      {active && (dir === 'desc' ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />)}
    </button>
  );
}

// ---- Page ----

export default function RankingsPage() {
  const { localUserId: userId, isLoading: userLoading } = useLocalUser();
  if (userLoading) return (
    <div className="flex-1 flex items-center justify-center min-h-screen">
      <Loader2 className="w-8 h-8 text-primary animate-spin" />
    </div>
  );
  if (!userId) return null;
  return <RankingsContent userId={userId} />;
}

function RankingsContent({ userId }: { userId: number }) {
  const [sortKey, setSortKey] = useState<SortKey>('stars');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  // Local overrides for stars the user adjusts, so the table updates without a refetch.
  const [starOverrides, setStarOverrides] = useState<Record<string, number>>({});

  const { data, isLoading, isError } = useQuery({
    queryKey: ['rankings', userId],
    queryFn: () => fetchRankings(userId),
  });

  const handleRated = useCallback((mbid: string, score: number) => {
    setStarOverrides((prev) => ({ ...prev, [mbid]: score }));
  }, []);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'title' ? 'asc' : 'desc');
    }
  };

  const tracks = useMemo(() => {
    const list = (data ?? []).map((t) =>
      t.mbid in starOverrides ? { ...t, stars: starOverrides[t.mbid] } : t,
    );
    const dirMul = sortDir === 'desc' ? -1 : 1;
    const cmp = (a: RankTrack, b: RankTrack): number => {
      switch (sortKey) {
        case 'stars': {
          // Null stars always sink to the bottom regardless of direction; ELO breaks ties.
          const as = a.stars, bs = b.stars;
          if (as === null && bs === null) return (b.elo.rating - a.elo.rating);
          if (as === null) return 1;
          if (bs === null) return -1;
          if (as !== bs) return (as - bs) * dirMul;
          return b.elo.rating - a.elo.rating;
        }
        case 'elo':
          return (a.elo.rating - b.elo.rating) * dirMul;
        case 'matches':
          return (a.elo.matches - b.elo.matches) * dirMul;
        case 'title':
          return a.title.localeCompare(b.title) * dirMul;
        default:
          return 0;
      }
    };
    return [...list].sort(cmp);
  }, [data, starOverrides, sortKey, sortDir]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-screen px-6 text-center">
        <p className="text-sm text-muted-foreground">Couldn't load your rankings. Try again in a moment.</p>
      </div>
    );
  }

  if (tracks.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-screen gap-4 px-6 text-center">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
          <Trophy className="w-6 h-6 text-primary/50" />
        </div>
        <h2 className="text-xl font-serif text-foreground">No rankings yet</h2>
        <p className="text-sm text-muted-foreground max-w-xs">
          Rate a few tracks and pit some against each other — they'll show up here with stars and ELO.
        </p>
        <a href={`${basePath}/`} className="text-xs font-mono text-primary uppercase tracking-widest hover:underline mt-2">
          Start diving →
        </a>
      </div>
    );
  }

  const ranked = tracks.filter((t) => t.elo.matches > 0).length;

  return (
    <div className="flex flex-col" style={{ height: 'calc(100dvh - 4rem)' }}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/30 flex items-baseline justify-between shrink-0">
        <h1 className="text-sm font-mono text-primary uppercase tracking-widest flex items-center gap-2">
          <Trophy className="w-4 h-4" /> Rankings
        </h1>
        <span className="text-[10px] font-mono text-muted-foreground/40 uppercase">
          {tracks.length} tracks · {ranked} ranked
        </span>
      </div>

      {/* Sort controls (column header) */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border/30 bg-background/95 shrink-0">
        <span className="w-6 shrink-0" />
        <span className="w-9 shrink-0" />
        <SortHeader label="Track" active={sortKey === 'title'} dir={sortDir} onClick={() => toggleSort('title')} className="flex-1" />
        <SortHeader label="Stars" active={sortKey === 'stars'} dir={sortDir} onClick={() => toggleSort('stars')} className="shrink-0" />
        <SortHeader label="ELO" active={sortKey === 'elo'} dir={sortDir} onClick={() => toggleSort('elo')} className="shrink-0 w-14 justify-end" />
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto">
        {tracks.map((t, i) => (
          <RankRow
            key={t.mbid}
            track={t}
            rank={i + 1}
            index={i}
            userId={userId}
            activeIdx={activeIdx}
            onActivate={setActiveIdx}
            onRated={handleRated}
          />
        ))}
        <div className="h-4" />
      </div>

      {/* Footnote */}
      <div className="px-4 py-2 border-t border-border/30 shrink-0 flex items-center gap-1.5">
        <Radio className="w-3 h-3 text-muted-foreground/40" />
        <p className="text-[10px] font-mono text-muted-foreground/40">
          ELO moves when you compare tracks head-to-head. Tap a star to adjust.
        </p>
      </div>
    </div>
  );
}
