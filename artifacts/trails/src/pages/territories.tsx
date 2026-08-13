import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalUser } from '@/lib/useLocalUser';
import {
  Loader2, Map, Compass, RefreshCw, Telescope,
} from 'lucide-react';
import { useSparkDive } from '@/lib/useSparkDive';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

// ---- Types (mirror lib/territories.ts) ----

interface MapTrack { mbid: string; title: string; artist: string }

interface Territory {
  key: string;
  tag: string;
  name: string;
  blurb: string;
  artists: string[];
  tracks: MapTrack[];
  trackCount: number;
}

interface BeyondSuggestion {
  name: string;
  blurb: string;
  tracks: Array<{ title: string; artist: string }>;
}

interface TerritoryMap { territories: Territory[]; beyond: BeyondSuggestion[] }

interface TerritoriesResponse { map: TerritoryMap | null; generatedAt: string | null; cached: boolean }

async function fetchTerritories(userId: number): Promise<TerritoriesResponse> {
  const r = await fetch(`${basePath}/api/territories?userId=${userId}`);
  if (!r.ok) throw new Error('Failed to load territories');
  return r.json();
}

async function generateTerritories(userId: number, force: boolean): Promise<TerritoriesResponse> {
  const r = await fetch(`${basePath}/api/territories/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, force }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? 'Charting failed');
  return d;
}

// ---- Charting progress (generation takes a while cold) ----

const CHARTING_LINES = [
  'Reading the tags on everything you’ve ranked…',
  'Drawing borders between scenes…',
  'Working out where the strongholds are…',
  'Naming what it finds…',
  'Peering past the edge of the map…',
];

function ChartingState() {
  const [line, setLine] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setLine((l) => (l + 1) % CHARTING_LINES.length), 4000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-[50vh] gap-4 px-6 text-center">
      <Loader2 className="w-8 h-8 text-primary animate-spin" />
      <p className="text-sm font-serif italic text-muted-foreground animate-in fade-in duration-500" key={line}>
        {CHARTING_LINES[line]}
      </p>
      <p className="text-[10px] font-mono text-muted-foreground/40 uppercase tracking-widest">
        First charting takes a minute
      </p>
    </div>
  );
}

// ---- Territory card ----

function TerritoryCard({ territory }: { territory: Territory }) {
  const { start, isPending } = useSparkDive();

  const diveIn = () => {
    if (isPending) return;
    start(
      {
        type: 'session',
        label: territory.name,
        tracks: territory.tracks.map((t) => ({ title: t.title, artist: t.artist })).slice(0, 8),
        notes: territory.blurb,
      },
      territory.name,
    );
  };

  return (
    <div className="rounded-2xl border border-border/40 bg-secondary/10 p-4 space-y-3">
      <div>
        <h3 className="font-serif text-lg italic text-foreground leading-snug">{territory.name}</h3>
        <p className="text-[10px] font-mono text-muted-foreground/40 uppercase tracking-widest mt-0.5">
          {territory.trackCount} track{territory.trackCount === 1 ? '' : 's'} · {territory.tag}
        </p>
      </div>

      <p className="text-sm font-serif leading-relaxed text-foreground/80">{territory.blurb}</p>

      {territory.artists.length > 0 && (
        <p className="text-xs text-muted-foreground truncate">
          {territory.artists.join(' · ')}
        </p>
      )}

      <button
        onClick={diveIn}
        disabled={isPending}
        className="w-full flex items-center justify-center gap-2 h-10 rounded-full border border-primary/25 text-primary/90 text-xs font-medium hover:bg-primary/10 transition-colors disabled:opacity-50"
      >
        {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Compass className="w-3.5 h-3.5" />}
        Dive into {territory.name}
      </button>
    </div>
  );
}

// ---- Beyond-the-map card ----

function BeyondCard({ suggestion }: { suggestion: BeyondSuggestion }) {
  const { start, isPending } = useSparkDive();

  const chartIt = () => {
    if (isPending || suggestion.tracks.length === 0) return;
    start(
      {
        type: 'session',
        label: suggestion.name,
        tracks: suggestion.tracks,
        notes: suggestion.blurb,
      },
      suggestion.name,
    );
  };

  return (
    <div className="rounded-2xl border border-dashed border-primary/25 bg-primary/[0.03] p-4 space-y-2.5">
      <h3 className="font-serif text-base italic text-foreground/90 leading-snug flex items-center gap-2">
        <Telescope className="w-4 h-4 text-primary/60 shrink-0" /> {suggestion.name}
      </h3>
      <p className="text-sm font-serif leading-relaxed text-foreground/75">{suggestion.blurb}</p>
      {suggestion.tracks.length > 0 && (
        <p className="text-xs text-muted-foreground/70">
          Start with {suggestion.tracks.map((t) => `“${t.title}” (${t.artist})`).join(' or ')}
        </p>
      )}
      <button
        onClick={chartIt}
        disabled={isPending || suggestion.tracks.length === 0}
        className="w-full flex items-center justify-center gap-2 h-9 rounded-full border border-primary/20 text-primary/80 text-xs font-medium hover:bg-primary/10 transition-colors disabled:opacity-50"
      >
        {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Compass className="w-3.5 h-3.5" />}
        Chart it
      </button>
    </div>
  );
}

// ---- Page ----

export default function TerritoriesPage() {
  const { localUserId: userId, isLoading: userLoading } = useLocalUser();
  if (userLoading) return (
    <div className="flex-1 flex items-center justify-center min-h-screen">
      <Loader2 className="w-8 h-8 text-primary animate-spin" />
    </div>
  );
  if (!userId) return null;
  return <TerritoriesContent userId={userId} />;
}

function TerritoriesContent({ userId }: { userId: number }) {
  const queryClient = useQueryClient();
  const [charting, setCharting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['territories', userId],
    queryFn: () => fetchTerritories(userId),
  });

  const chart = async (force: boolean) => {
    if (charting) return;
    setCharting(true);
    setError(null);
    try {
      const result = await generateTerritories(userId, force);
      queryClient.setQueryData(['territories', userId], result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Charting failed');
    } finally {
      setCharting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (charting) return <ChartingState />;

  const map = data?.map ?? null;

  if (!map) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-screen gap-4 px-6 text-center">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
          <Map className="w-6 h-6 text-primary/50" />
        </div>
        <h2 className="text-xl font-serif text-foreground">Chart your territories</h2>
        <p className="text-sm text-muted-foreground max-w-xs">
          See your rankings as a map — the scenes you hold, what unites the music
          in each one, and the unexplored land next door.
        </p>
        <button
          onClick={() => chart(false)}
          className="flex items-center gap-2 h-10 px-5 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors mt-2"
        >
          <Map className="w-4 h-4" /> Chart my territories
        </button>
        {error && <p className="text-xs text-destructive max-w-xs">{error}</p>}
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-4 pb-24">
      {/* Header */}
      <div className="py-3 border-b border-border/30 flex items-baseline justify-between sticky top-0 bg-background/95 backdrop-blur-sm z-10">
        <h1 className="text-sm font-mono text-primary uppercase tracking-widest flex items-center gap-2">
          <Map className="w-4 h-4" /> Territories
        </h1>
        <button
          onClick={() => chart(true)}
          title="Re-chart from your latest rankings"
          className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground/60 hover:text-primary uppercase tracking-widest transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Re-chart
        </button>
      </div>

      {error && <p className="text-xs text-destructive mt-3">{error}</p>}

      {/* Territories — biggest holdings first (pre-sorted by the server) */}
      <div className="space-y-3 mt-4">
        {map.territories.map((t) => (
          <TerritoryCard key={t.key} territory={t} />
        ))}
      </div>

      {/* Beyond the map */}
      {map.beyond.length > 0 && (
        <div className="mt-8 space-y-3">
          <h2 className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-widest flex items-center gap-1.5">
            <Telescope className="w-3 h-3" /> Beyond the map
          </h2>
          {map.beyond.map((b) => (
            <BeyondCard key={b.name} suggestion={b} />
          ))}
        </div>
      )}
    </div>
  );
}
