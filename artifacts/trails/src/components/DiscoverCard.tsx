import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, Star, Sparkles, SkipForward, PenLine } from 'lucide-react';
import { SiSpotify } from 'react-icons/si';
import { TrackPreviewPill } from '@/components/TrackPreviewPill';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

interface DiscoverTrack {
  mbid: string;
  type: string;
  title: string;
  artist: string;
  year: number | null;
}

interface DiscoverResponse {
  track?: DiscoverTrack;
  artworkUrl?: string | null;
}

/**
 * A rapid "rate to rank" feed on Home: collaborative-filtering pulls a fresh
 * track from what the user already ranks highest; a star (or skip) records it
 * and immediately serves the next — the fastest way to grow the rankings table.
 */
export function DiscoverCard({ userId }: { userId: number }) {
  const [track, setTrack]             = useState<DiscoverTrack | null>(null);
  const [artwork, setArtwork]         = useState<string | null>(null);
  const [loading, setLoading]         = useState(true);
  const [empty, setEmpty]             = useState(false);
  const [saving, setSaving]           = useState<number | 'skip' | null>(null);
  const [added, setAdded]             = useState(0);
  const [hoveredStar, setHoveredStar] = useState<number | null>(null);
  const [note, setNote]               = useState('');
  const [noteOpen, setNoteOpen]       = useState(false);
  const servedRef = useRef<string[]>([]);

  const loadNext = useCallback(async () => {
    setLoading(true);
    setArtwork(null);
    setNote('');
    setNoteOpen(false);
    try {
      const params = new URLSearchParams({
        userId: String(userId),
        exclude: servedRef.current.slice(-40).join(','),
      });
      const r = await fetch(`${basePath}/api/discover/track?${params}`);
      const d: DiscoverResponse = await r.json();
      if (!d.track) { setTrack(null); setEmpty(true); }
      else {
        setTrack(d.track);
        setArtwork(d.artworkUrl ?? null);
        servedRef.current.push(`${d.track.title}|${d.track.artist}`.toLowerCase());
        setEmpty(false);
      }
    } catch {
      setEmpty(true);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { loadNext(); }, [loadNext]);

  const rate = async (score: number) => {
    if (!track || saving !== null) return;
    setSaving(score);
    setHoveredStar(null);
    try {
      await fetch(`${basePath}/api/focus-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId, mbid: track.mbid, title: track.title, artist: track.artist,
          listenState: 'known', score,
          reviewText: note.trim() || undefined,
        }),
      });
      setAdded((n) => n + 1);
    } catch { /* best-effort */ }
    finally {
      setSaving(null);
      loadNext();
    }
  };

  const skip = () => {
    if (saving !== null) return;
    setSaving('skip');
    setHoveredStar(null);
    loadNext().finally(() => setSaving(null));
  };

  return (
    <div className="rounded-2xl border border-primary/15 bg-secondary/10 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[10px] font-mono text-primary/70 uppercase tracking-widest">
          <Sparkles className="w-3 h-3" /> Discover &amp; rank
        </span>
        {added > 0 && (
          <span className="text-[10px] font-mono text-muted-foreground/40 uppercase tracking-widest">
            {added} added
          </span>
        )}
      </div>

      {loading && !track ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-6 h-6 text-primary animate-spin" />
        </div>
      ) : empty || !track ? (
        <div className="text-center py-6 space-y-1">
          <p className="text-sm text-muted-foreground">No fresh picks right now.</p>
          <p className="text-xs text-muted-foreground/60">
            Rate or seed a few tracks first, then recommendations will flow.
          </p>
        </div>
      ) : (
        <>
          {/* Track info */}
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-xl bg-secondary/50 border border-primary/10 overflow-hidden relative flex items-center justify-center shrink-0">
              <span className="text-lg font-mono font-bold text-primary/20 absolute">
                {(track.artist[0] ?? track.title[0] ?? '?').toUpperCase()}
              </span>
              {artwork && (
                <img src={artwork} alt="" className="w-full h-full object-cover relative"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium text-foreground truncate leading-snug">{track.title}</p>
              <p className="text-sm text-muted-foreground truncate">{track.artist}</p>
              {track.year && (
                <p className="text-xs text-muted-foreground/50">{track.year}</p>
              )}
            </div>
          </div>

          {/* Preview pill + Spotify link */}
          <div className="flex items-center gap-2">
            <TrackPreviewPill key={track.mbid} title={track.title} artist={track.artist} />
            <a
              href={`https://open.spotify.com/search/${encodeURIComponent(`${track.title} ${track.artist}`)}/tracks`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in Spotify"
              className="flex items-center justify-center w-7 h-7 rounded-full bg-[#1DB954]/10 hover:bg-[#1DB954]/25 border border-[#1DB954]/30 hover:border-[#1DB954]/60 transition-colors shrink-0"
            >
              <SiSpotify className="w-3.5 h-3.5 text-[#1DB954]" />
            </a>
          </div>

          {/* Notes */}
          {noteOpen ? (
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What do you notice? Mood, memory, texture…"
              rows={2}
              autoFocus
              className="w-full rounded-xl bg-secondary/30 border border-primary/20 focus:border-primary/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 resize-none focus:outline-none"
            />
          ) : (
            <button
              onClick={() => setNoteOpen(true)}
              className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/40 hover:text-primary/60 uppercase tracking-widest transition-colors"
            >
              <PenLine className="w-3 h-3" /> add a note
            </button>
          )}

          {/* Stars + skip */}
          <div className="flex items-center justify-between">
            <div
              className="flex items-center gap-1"
              onMouseLeave={() => setHoveredStar(null)}
            >
              {[1, 2, 3].map((s) => {
                const active = typeof saving === 'number' ? saving : (hoveredStar ?? 0);
                const filled = s <= active;
                return (
                  <button
                    key={s}
                    onClick={() => rate(s)}
                    onMouseEnter={() => setHoveredStar(s)}
                    disabled={saving !== null}
                    className="p-1 transition-transform hover:scale-110 disabled:opacity-40"
                    title={`${s}/3`}
                  >
                    <Star className={`w-6 h-6 transition-colors ${
                      filled ? 'fill-amber-400 text-amber-400' : 'fill-transparent text-muted-foreground/30'
                    }`} />
                  </button>
                );
              })}
              <span className="text-[10px] font-mono text-muted-foreground/40 uppercase tracking-wide ml-2">
                tap to rank
              </span>
            </div>
            <button
              onClick={skip}
              disabled={saving !== null}
              className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground/50 hover:text-muted-foreground uppercase tracking-widest disabled:opacity-40"
            >
              Skip <SkipForward className="w-3 h-3" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
