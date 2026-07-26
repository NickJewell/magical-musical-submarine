import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRateRec, getGetPortraitQueryKey } from '@workspace/api-client-react';
import { useLocalUser } from '@/lib/useLocalUser';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Loader2, ChevronDown, ChevronUp, Star, ExternalLink,
  Music, Radio, Check, Trash2, RefreshCw, NotebookPen, Compass,
} from 'lucide-react';
import { TrackPreviewPill } from '@/components/TrackPreviewPill';
import { DiveFromTrackButton } from '@/components/DiveFromTrackButton';
import { useSparkDive } from '@/lib/useSparkDive';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

// ---- Types ----

interface Song {
  recId: number;
  mbid: string;
  type: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
  score: number | null;
  listenState: string | null;
  reviewText: string | null;
  arm: string;
  linksJson: Record<string, unknown> | null;
  narrativeText: string | null;
}

interface PathSummary { count: number; avgScore: number | null; newCount: number }

interface DivePath {
  diveStepId: number;
  diveId: number;
  diveName: string;
  title: string;
  summary: PathSummary;
  songs: Song[];
  wellTrodden: Song | null;
  tastingNote: string | null;
  tastingNoteAt: string | null;
}

interface DayData { date: string; label: string; paths: DivePath[] }

interface TimelineResponse { days: DayData[]; nextCursor: string | null }

interface SpotifyStatus { enabled: boolean; connected: boolean; spotifyUserId: string | null }

// ---- Fetch helpers ----

async function fetchTimeline(userId: number, before?: string): Promise<TimelineResponse> {
  const params = new URLSearchParams({ userId: String(userId), days: '14' });
  if (before) params.set('before', before);
  const r = await fetch(`${basePath}/api/timeline?${params}`);
  if (!r.ok) throw new Error('Failed to load timeline');
  return r.json();
}

async function fetchSpotifyStatus(userId: number): Promise<SpotifyStatus> {
  const r = await fetch(`${basePath}/api/spotify/status?userId=${userId}`);
  if (!r.ok) return { enabled: false, connected: false, spotifyUserId: null };
  return r.json();
}

async function generateTrackNotes(userId: number, diveStepId: number): Promise<{ tastingNote: string; tastingNoteAt: string }> {
  const r = await fetch(`${basePath}/api/timeline/tasting-note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, diveStepId }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? 'Failed to generate note');
  return d;
}

async function deleteDiveStep(userId: number, diveStepId: number): Promise<{ diveDeleted: boolean; diveId: number }> {
  const r = await fetch(`${basePath}/api/step/${diveStepId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? 'Failed to delete');
  return d;
}

async function deleteDive(userId: number, diveId: number): Promise<void> {
  const r = await fetch(`${basePath}/api/dive/${diveId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error ?? 'Failed to delete dive');
  }
}

// ---- Star display (1–3 scale) ----

function Stars({ score, max = 3 }: { score: number | null; max?: number }) {
  return (
    <div className="flex gap-0.5 items-center">
      {Array.from({ length: max }, (_, i) => (
        <Star
          key={i}
          className={`w-3 h-3 ${
            score !== null && i < Math.round(score)
              ? 'fill-amber-400 text-amber-400'
              : 'fill-transparent text-muted-foreground/25 stroke-muted-foreground/30'
          }`}
        />
      ))}
    </div>
  );
}

// ---- Listen-state dot ----

function ListenDot({ state }: { state: string | null }) {
  if (!state) return null;
  const cls =
    state === 'listened' ? 'bg-primary' :
    state === 'known'    ? 'bg-amber-400' :
    state === 'skipped'  ? 'bg-muted-foreground/30' : 'bg-transparent';
  const label =
    state === 'listened' ? 'new' :
    state === 'known'    ? 'known' : state;
  return (
    <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls} shrink-0 mt-0.5`} title={label} />
  );
}

// ---- Song row ----

function SongRow({ song, onOpen }: { song: Song; onOpen: (s: Song) => void }) {
  const dimmed = song.listenState === 'skipped';
  return (
    <button
      onClick={() => onOpen(song)}
      className={`w-full flex items-start gap-2 px-3 py-2 rounded-xl hover:bg-secondary/30 transition-colors text-left group ${dimmed ? 'opacity-40' : ''}`}
    >
      <ListenDot state={song.listenState} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate leading-snug">{song.title}</p>
        <p className="text-xs text-muted-foreground truncate">{song.artist}</p>
        {song.reviewText && (
          <p className="text-xs text-muted-foreground/70 italic mt-0.5 line-clamp-2">{song.reviewText}</p>
        )}
      </div>
      <Stars score={song.score} />
    </button>
  );
}

// ---- Spotify export button ----

function SpotifyExportButton({
  userId, diveStepId, spotify,
}: { userId: number; diveStepId: number; spotify: SpotifyStatus | null }) {
  const [result, setResult] = useState<{ url: string; added: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!spotify?.enabled) return null;

  if (result) {
    return (
      <a
        href={result.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 text-[10px] font-mono text-green-400 hover:text-green-300 uppercase tracking-wide"
      >
        <ExternalLink className="w-3 h-3" />
        Open playlist ({result.added}/{result.total})
      </a>
    );
  }

  if (!spotify.connected) {
    return (
      <a
        href={`${basePath}/api/spotify/connect?userId=${userId}`}
        className="text-[10px] font-mono text-muted-foreground/60 hover:text-primary uppercase tracking-wide"
      >
        Connect Spotify to export →
      </a>
    );
  }

  const handleExport = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${basePath}/api/spotify/export-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, diveStepId }),
      });
      const d = await r.json() as { playlistUrl?: string; added?: number; total?: number; error?: string };
      if (!r.ok || d.error) {
        setError(d.error === 'dev_mode_allowlist'
          ? 'Your Spotify account isn\'t on the developer allowlist'
          : d.error ?? 'Export failed');
      } else {
        setResult({ url: d.playlistUrl!, added: d.added!, total: d.total! });
      }
    } catch {
      setError('Export failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-1">
      <button
        onClick={handleExport}
        disabled={loading}
        className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/60 hover:text-[#1DB954] transition-colors uppercase tracking-wide disabled:opacity-40"
      >
        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Music className="w-3 h-3" />}
        Export to Spotify
      </button>
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  );
}

// ---- Track notes (per dive leg) ----

function TrackNotes({
  path, userId, onGenerated,
}: {
  path: DivePath;
  userId: number;
  onGenerated: (diveStepId: number, note: string, at: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Collapsed by default — the note can be long, so keep the card compact until asked.
  const [open, setOpen] = useState(false);

  // Any track heard/rated on this leg → generation is possible.
  const hasRatings = path.songs.some((s) => s.listenState || s.score !== null);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await generateTrackNotes(userId, path.diveStepId);
      onGenerated(path.diveStepId, d.tastingNote, d.tastingNoteAt);
      setOpen(true); // reveal a freshly generated note
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate');
    } finally {
      setLoading(false);
    }
  };

  if (path.tastingNote) {
    return (
      <div className="mx-3 mb-1 mt-2 rounded-xl border border-primary/15 bg-primary/[0.04] px-3 py-2.5">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-1.5 text-[10px] font-mono text-primary/70 uppercase tracking-widest hover:text-primary transition-colors"
          >
            <NotebookPen className="w-3 h-3" /> Track Notes
            {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          <button
            onClick={handleGenerate}
            disabled={loading}
            title="Regenerate"
            className="text-muted-foreground/40 hover:text-primary transition-colors disabled:opacity-40"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          </button>
        </div>
        {open && (
          <p className="text-xs font-serif leading-relaxed text-foreground/80 mt-2 animate-in fade-in slide-in-from-top-1 duration-200">
            {path.tastingNote}
          </p>
        )}
        {error && <p className="text-[10px] text-destructive mt-1">{error}</p>}
      </div>
    );
  }

  if (!hasRatings) return null;

  return (
    <div className="px-3 pt-2">
      <button
        onClick={handleGenerate}
        disabled={loading}
        className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/60 hover:text-primary transition-colors uppercase tracking-wide disabled:opacity-40"
      >
        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <NotebookPen className="w-3 h-3" />}
        {loading ? 'Writing…' : 'Write track notes'}
      </button>
      {error && <p className="text-[10px] text-destructive mt-1">{error}</p>}
    </div>
  );
}

// ---- Dive-path card ----

function PathCard({
  path, userId, defaultExpanded, spotify, onOpenSong, onRequestDelete, onTastingNote,
}: {
  path: DivePath;
  userId: number;
  defaultExpanded: boolean;
  spotify: SpotifyStatus | null;
  onOpenSong: (s: Song) => void;
  onRequestDelete: (path: DivePath) => void;
  onTastingNote: (diveStepId: number, note: string, at: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { count, avgScore, newCount } = path.summary;

  const collapsedLabel = [
    `${count} song${count === 1 ? '' : 's'}`,
    avgScore !== null ? `avg ★${avgScore.toFixed(1)}` : null,
    newCount > 0 ? `${newCount} new` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="rounded-2xl border border-border/40 bg-secondary/10 overflow-hidden group/card">
      {/* Path header */}
      <div className="w-full flex items-start gap-2 px-4 py-3 hover:bg-secondary/20 transition-colors">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex-1 min-w-0 text-left"
        >
          {path.diveName && (
            <p className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-widest truncate mb-0.5">
              {path.diveName}
            </p>
          )}
          <p className="text-sm font-medium italic text-foreground/90 leading-snug">
            {path.title}
          </p>
          {!expanded && (
            <p className="text-[10px] font-mono text-muted-foreground/50 mt-1">{collapsedLabel}</p>
          )}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onRequestDelete(path); }}
          title="Delete this path"
          className="shrink-0 mt-0.5 text-muted-foreground/30 hover:text-destructive transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => setExpanded((e) => !e)} className="shrink-0 mt-0.5 text-muted-foreground/40">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-border/20 py-2">
          {/* Track notes — directly under the title; they cover the whole section */}
          <TrackNotes path={path} userId={userId} onGenerated={onTastingNote} />

          {/* Song list */}
          {path.songs.length === 0 && (
            <p className="text-xs text-muted-foreground px-4 py-2 italic">No tracks yet</p>
          )}
          {path.songs.map((s) => (
            <SongRow key={s.recId} song={s} onOpen={onOpenSong} />
          ))}

          {/* Footer actions */}
          <div className="flex items-center justify-between gap-3 px-3 pt-2 pb-1">
            <SpotifyExportButton userId={userId} diveStepId={path.diveStepId} spotify={spotify} />
          </div>

          {/* Dive deeper into this category — a fresh expedition from these songs + notes */}
          {path.songs.length > 0 && (
            <div className="px-3 pt-1">
              <DiveIntoCategoryButton path={path} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Dive deeper into a section's category ----

function DiveIntoCategoryButton({ path }: { path: DivePath }) {
  const { start, isPending } = useSparkDive();
  const handleClick = () => {
    if (isPending) return;
    start(
      {
        type: 'session',
        label: path.title,
        tracks: path.songs.map((s) => ({ title: s.title, artist: s.artist })),
        notes: path.tastingNote,
      },
      path.title,
    );
  };
  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="w-full flex items-center justify-center gap-2 h-10 rounded-full border border-primary/25 text-primary/90 text-xs font-medium hover:bg-primary/10 transition-colors disabled:opacity-50"
    >
      {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Compass className="w-3.5 h-3.5" />}
      Dive deeper into "{path.title}"
    </button>
  );
}

// ---- Day column ----

function DayColumn({
  day, userId, isToday, spotify, onOpenSong, onRequestDelete, onTastingNote,
}: {
  day: DayData;
  userId: number;
  isToday: boolean;
  spotify: SpotifyStatus | null;
  onOpenSong: (s: Song) => void;
  onRequestDelete: (path: DivePath) => void;
  onTastingNote: (diveStepId: number, note: string, at: string) => void;
}) {
  const totalSongs = day.paths.reduce((n, p) => n + p.summary.count, 0);
  const autoExpand  = isToday || (day.paths.length <= 2 && totalSongs <= 8);

  return (
    <div
      className="
        flex-none w-[min(280px,calc(100vw-24px))] overflow-y-auto
        border-r border-border/30 px-3 py-4 space-y-3
        scroll-snap-align-start
      "
      style={{ maxHeight: 'calc(100dvh - 8rem)' }}
    >
      {/* Date header */}
      <div className="sticky top-0 bg-background/95 backdrop-blur-sm pb-2 z-10">
        <h2 className={`text-sm font-mono uppercase tracking-widest ${isToday ? 'text-primary' : 'text-muted-foreground/70'}`}>
          {day.label}
        </h2>
        <div className="h-px bg-border/40 mt-2" />
      </div>

      {/* Path cards */}
      {day.paths.map((path) => (
        <PathCard
          key={path.diveStepId}
          path={path}
          userId={userId}
          defaultExpanded={autoExpand}
          spotify={spotify}
          onOpenSong={onOpenSong}
          onRequestDelete={onRequestDelete}
          onTastingNote={onTastingNote}
        />
      ))}
    </div>
  );
}

// ---- Song detail dialog (with inline rating) ----

const LISTEN_STATES = [
  { value: 'listened', label: 'Listened' },
  { value: 'known',    label: 'Already knew it' },
  { value: 'skipped',  label: 'Skipped' },
] as const;

const STAR_LABELS: Record<number, string> = { 1: 'less of this', 2: 'middle ground', 3: 'more of this' };

function SongDetail({
  song, userId, onClose, onRated,
}: {
  song: Song;
  userId: number;
  onClose: () => void;
  onRated: (recId: number, score: number | null, listenState: string) => void;
}) {
  const [listenState, setListenState] = useState<string | null>(song.listenState);
  const [score, setScore]             = useState<number | null>(song.score);
  const [saved, setSaved]             = useState(false);

  // Artwork from DB column
  const artworkUrl = song.artworkUrl;

  const rateRec = useRateRec();
  const showStars = listenState === 'listened' || listenState === 'known';

  function handleListenState(state: string) {
    const newScore = state === 'skipped' ? null : score;
    setListenState(state);
    if (state === 'skipped') setScore(null);
    submit(state, newScore);
  }

  function handleStar(s: number) {
    setScore(s);
    if (listenState) submit(listenState, s);
  }

  function submit(state: string, s: number | null) {
    rateRec.mutate(
      { data: { userId, recId: song.recId, listenState: state as 'listened' | 'known' | 'skipped', score: s ?? undefined } },
      {
        onSuccess: () => {
          setSaved(true);
          onRated(song.recId, s, state);
          setTimeout(() => setSaved(false), 1500);
        },
      },
    );
  }

  const rawLinks = song.linksJson as Record<string, string | null> | null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm mx-auto rounded-2xl bg-background border-border/50 space-y-4">

        {/* ── Header with artwork ── */}
        <DialogHeader>
          <div className="flex items-center gap-3">
            {/* Artwork thumbnail */}
            <div className="w-16 h-16 rounded-xl bg-secondary/50 border border-primary/10 overflow-hidden relative flex items-center justify-center flex-shrink-0 shadow-md">
              <span className="text-xl font-mono font-bold text-primary/20 select-none absolute">
                {(song.artist[0] ?? song.title[0] ?? '?').toUpperCase()}
              </span>
              {artworkUrl && (
                <img
                  src={artworkUrl}
                  alt=""
                  className="w-full h-full object-cover relative"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
            </div>
            <div className="min-w-0">
              <DialogTitle className="font-serif text-lg text-foreground leading-snug">{song.title}</DialogTitle>
              <p className="text-sm text-muted-foreground">{song.artist}</p>
            </div>
          </div>
        </DialogHeader>

        {/* ── Preview pill ── */}
        <TrackPreviewPill title={song.title} artist={song.artist} />

        {/* ── Rating section ── */}
        <div className="space-y-3 border border-border/30 rounded-xl p-3 bg-secondary/10">
          <div className="flex gap-1.5 flex-wrap">
            {LISTEN_STATES.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => handleListenState(value)}
                className={`text-xs font-mono px-3 py-1.5 rounded-full border transition-colors ${
                  listenState === value
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border/40 text-muted-foreground hover:border-primary/50 hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {showStars && (
            <div className="flex items-center gap-2">
              <div className="flex gap-1">
                {[1, 2, 3].map((s) => (
                  <button key={s} onClick={() => handleStar(s)} className="transition-transform hover:scale-110">
                    <Star
                      className={`w-6 h-6 transition-colors ${
                        score !== null && s <= score
                          ? 'fill-amber-400 text-amber-400'
                          : 'fill-transparent text-muted-foreground/30'
                      }`}
                    />
                  </button>
                ))}
              </div>
              {score !== null && (
                <span className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wide">
                  {STAR_LABELS[score]}
                </span>
              )}
            </div>
          )}

          {saved && (
            <p className="flex items-center gap-1 text-[10px] font-mono text-primary uppercase tracking-wide animate-in fade-in duration-200">
              <Check className="w-3 h-3" /> Saved
            </p>
          )}
          {rateRec.isError && (
            <p className="text-[10px] text-destructive">Failed to save — try again</p>
          )}
        </div>

        {/* ── Narrative ── */}
        {song.narrativeText && (
          <p className="text-sm font-serif leading-relaxed text-foreground/80 whitespace-pre-wrap">
            {song.narrativeText}
          </p>
        )}

        {/* ── External streaming links ── */}
        {rawLinks && (
          <div className="flex flex-wrap gap-2">
            {rawLinks.spotify && (
              <a href={rawLinks.spotify} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs bg-[#1DB954]/15 text-[#1DB954] border border-[#1DB954]/30 px-3 py-1.5 rounded-full hover:bg-[#1DB954]/25 transition-colors">
                <Music className="w-3 h-3" /> Spotify
              </a>
            )}
            {rawLinks.youtube && (
              <a href={rawLinks.youtube} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs bg-red-500/10 text-red-400 border border-red-500/20 px-3 py-1.5 rounded-full hover:bg-red-500/20 transition-colors">
                <Radio className="w-3 h-3" /> YouTube
              </a>
            )}
            {rawLinks.appleMusic && (
              <a href={rawLinks.appleMusic} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs bg-pink-500/10 text-pink-400 border border-pink-500/20 px-3 py-1.5 rounded-full hover:bg-pink-500/20 transition-colors">
                <Music className="w-3 h-3" /> Apple Music
              </a>
            )}
          </div>
        )}

        {/* ── Start a new dive from this track ── */}
        <DiveFromTrackButton mbid={song.mbid} title={song.title} artist={song.artist} />
      </DialogContent>
    </Dialog>
  );
}

// ---- Delete confirmation dialog ----

function DeleteDialog({
  path, siblingCount, userId, onClose, onDeletedStep, onDeletedDive,
}: {
  path: DivePath;
  siblingCount: number; // total paths belonging to the same dive
  userId: number;
  onClose: () => void;
  onDeletedStep: (diveStepId: number, diveAlsoDeleted: boolean, diveId: number) => void;
  onDeletedDive: (diveId: number) => void;
}) {
  const [busy, setBusy] = useState<null | 'step' | 'dive'>(null);
  const [error, setError] = useState<string | null>(null);
  const multiPath = siblingCount > 1;

  const doDeleteStep = async () => {
    setBusy('step');
    setError(null);
    try {
      const d = await deleteDiveStep(userId, path.diveStepId);
      onDeletedStep(path.diveStepId, d.diveDeleted, path.diveId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
      setBusy(null);
    }
  };

  const doDeleteDive = async () => {
    setBusy('dive');
    setError(null);
    try {
      await deleteDive(userId, path.diveId);
      onDeletedDive(path.diveId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete dive');
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-sm mx-auto rounded-2xl bg-background border-border/50 space-y-4">
        <DialogHeader>
          <DialogTitle className="font-serif text-lg text-foreground leading-snug">Delete this?</DialogTitle>
        </DialogHeader>

        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            Path <span className="italic text-foreground/90">"{path.title}"</span>
            {path.diveName && <> in <span className="font-mono text-xs uppercase tracking-wide">{path.diveName}</span></>}.
          </p>
          <p className="text-xs text-muted-foreground/70">
            This removes its tracks and your ratings on them. Can't be undone.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Button
            variant="destructive"
            onClick={doDeleteStep}
            disabled={!!busy}
            className="w-full justify-center"
          >
            {busy === 'step' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Delete this path
          </Button>

          {multiPath && (
            <Button
              variant="outline"
              onClick={doDeleteDive}
              disabled={!!busy}
              className="w-full justify-center border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {busy === 'dive' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Delete entire dive ({siblingCount} paths)
            </Button>
          )}

          <Button variant="ghost" onClick={onClose} disabled={!!busy} className="w-full justify-center">
            Cancel
          </Button>
        </div>

        {error && <p className="text-xs text-destructive text-center">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}

// ---- Main page ----

export default function TimelinePage() {
  const { localUserId: userId, isLoading: userLoading } = useLocalUser();
  if (userLoading) return (
    <div className="flex-1 flex items-center justify-center min-h-screen">
      <Loader2 className="w-8 h-8 text-primary animate-spin" />
    </div>
  );
  if (!userId) return null;
  return <TimelineContent userId={userId} />;
}

function TimelineContent({ userId }: { userId: number }) {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [allDays, setAllDays] = useState<DayData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [selectedSong, setSelectedSong] = useState<Song | null>(null);
  const [ratedCount, setRatedCount] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<DivePath | null>(null);

  const today = new Date().toISOString().slice(0, 10);

  // Store a generated tasting note in place
  const handleTastingNote = useCallback((diveStepId: number, note: string, at: string) => {
    setAllDays((prev) =>
      prev.map((day) => ({
        ...day,
        paths: day.paths.map((p) =>
          p.diveStepId === diveStepId ? { ...p, tastingNote: note, tastingNoteAt: at } : p,
        ),
      })),
    );
  }, []);

  // Remove a single path after deletion (and its dive if the backend emptied it)
  const handleDeletedStep = useCallback((diveStepId: number, diveAlsoDeleted: boolean, diveId: number) => {
    setAllDays((prev) =>
      prev
        .map((day) => ({
          ...day,
          paths: day.paths.filter((p) =>
            diveAlsoDeleted ? p.diveId !== diveId : p.diveStepId !== diveStepId,
          ),
        }))
        .filter((day) => day.paths.length > 0),
    );
  }, []);

  // Remove every path belonging to a deleted dive
  const handleDeletedDive = useCallback((diveId: number) => {
    setAllDays((prev) =>
      prev
        .map((day) => ({ ...day, paths: day.paths.filter((p) => p.diveId !== diveId) }))
        .filter((day) => day.paths.length > 0),
    );
  }, []);

  // How many paths share the delete target's dive (across all loaded days)
  const targetSiblingCount = deleteTarget
    ? allDays.reduce((n, day) => n + day.paths.filter((p) => p.diveId === deleteTarget.diveId).length, 0)
    : 0;

  // Update a song's score + listenState in-place after a rating is saved
  const handleRated = useCallback((recId: number, score: number | null, listenState: string) => {
    setAllDays((prev) =>
      prev.map((day) => ({
        ...day,
        paths: day.paths.map((path) => ({
          ...path,
          songs: path.songs.map((s) =>
            s.recId === recId ? { ...s, score, listenState } : s,
          ),
        })),
      })),
    );
    setSelectedSong((s) => (s && s.recId === recId ? { ...s, score, listenState } : s));
    setRatedCount((n) => n + 1);
  }, []);

  // Invalidate portrait 6 s after every 3rd rating
  useEffect(() => {
    if (ratedCount > 0 && ratedCount % 3 === 0) {
      const t = setTimeout(
        () => queryClient.invalidateQueries({ queryKey: getGetPortraitQueryKey({ userId }) }),
        6000,
      );
      return () => clearTimeout(t);
    }
    return undefined;
  }, [ratedCount, userId, queryClient]);

  // Initial load
  const { data: initial, isLoading } = useQuery({
    queryKey: ['timeline', userId],
    queryFn: () => fetchTimeline(userId),
  });

  useEffect(() => {
    if (initial && !initialLoaded) {
      setAllDays(initial.days);
      setNextCursor(initial.nextCursor);
      setInitialLoaded(true);
    }
  }, [initial, initialLoaded]);

  // Scroll to rightmost (today) on initial load
  useEffect(() => {
    if (initialLoaded && scrollRef.current) {
      const el = scrollRef.current;
      el.scrollLeft = el.scrollWidth;
    }
  }, [initialLoaded]);

  // Spotify status
  const { data: spotify } = useQuery({
    queryKey: ['spotify-status', userId],
    queryFn: () => fetchSpotifyStatus(userId),
  });

  // Load older days
  const loadMore = useCallback(async () => {
    if (loadingMore || !nextCursor) return;
    setLoadingMore(true);
    try {
      const older = await fetchTimeline(userId, nextCursor);
      setAllDays((prev) => [...older.days, ...prev]);
      setNextCursor(older.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [userId, nextCursor, loadingMore]);

  // IntersectionObserver on left sentinel
  useEffect(() => {
    if (!sentinelRef.current) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore(); },
      { root: scrollRef.current, threshold: 0.1 },
    );
    obs.observe(sentinelRef.current);
    return () => obs.disconnect();
  }, [loadMore]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (initialLoaded && allDays.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-screen gap-4 px-6 text-center">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
          <Radio className="w-6 h-6 text-primary/50" />
        </div>
        <h2 className="text-xl font-serif text-foreground">Your trail starts here</h2>
        <p className="text-sm text-muted-foreground max-w-xs">
          Complete your first dive to see your musical journey mapped out over time.
        </p>
        <a href={`${basePath}/`} className="text-xs font-mono text-primary uppercase tracking-widest hover:underline mt-2">
          Start diving →
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col" style={{ height: 'calc(100dvh - 4rem)' }}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/30 flex items-baseline justify-between shrink-0">
        <h1 className="text-sm font-mono text-primary uppercase tracking-widest">Your Trail</h1>
        <span className="text-[10px] font-mono text-muted-foreground/40 uppercase">
          {allDays.length} {allDays.length === 1 ? 'day' : 'days'}
        </span>
      </div>

      {/* Horizontal scroll area */}
      <div
        ref={scrollRef}
        className="flex flex-1 overflow-x-auto overflow-y-hidden"
        style={{ scrollSnapType: 'x mandatory', scrollBehavior: 'smooth' }}
      >
        {/* Left sentinel — triggers loadMore */}
        <div ref={sentinelRef} className="flex-none w-1 shrink-0">
          {loadingMore && (
            <div className="flex items-center justify-center h-full w-12">
              <Loader2 className="w-4 h-4 text-muted-foreground/40 animate-spin" />
            </div>
          )}
        </div>

        {/* ← earlier affordance */}
        {nextCursor && !loadingMore && (
          <button
            onClick={loadMore}
            className="flex-none flex items-center gap-1 px-3 self-center text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground uppercase tracking-widest"
          >
            ← earlier
          </button>
        )}

        {allDays.map((day) => (
          <DayColumn
            key={day.date}
            day={day}
            userId={userId}
            isToday={day.date === today}
            spotify={spotify ?? null}
            onOpenSong={setSelectedSong}
            onRequestDelete={setDeleteTarget}
            onTastingNote={handleTastingNote}
          />
        ))}
      </div>

      {/* Song detail modal */}
      {selectedSong && (
        <SongDetail
          song={selectedSong}
          userId={userId}
          onClose={() => setSelectedSong(null)}
          onRated={handleRated}
        />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <DeleteDialog
          path={deleteTarget}
          siblingCount={targetSiblingCount}
          userId={userId}
          onClose={() => setDeleteTarget(null)}
          onDeletedStep={handleDeletedStep}
          onDeletedDive={handleDeletedDive}
        />
      )}
    </div>
  );
}
