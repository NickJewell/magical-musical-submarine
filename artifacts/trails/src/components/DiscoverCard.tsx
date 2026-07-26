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
  spotifyId: string | null;
  artworkUrl: string | null;
}

interface InfoState {
  artist: string | null;
  track: string | null;
}

/**
 * A rapid "rate to rank" feed on Home.
 *
 * Layout: full-bleed three-column row (breaks out of the parent p-6 with -mx-6).
 * Left panel = artist bio, centre = card, right panel = song blurb.
 * Info blurbs load eagerly from /api/discover/info as soon as each track arrives.
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
  const [info, setInfo]               = useState<InfoState | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const servedRef = useRef<string[]>([]);

  const fetchArtwork = useCallback(async (artist: string, title: string) => {
    try {
      const r = await fetch(`${basePath}/api/discover/artwork?${new URLSearchParams({ artist, title })}`);
      if (!r.ok) return;
      const d = await r.json() as { artworkUrl: string | null };
      if (d.artworkUrl) setArtwork(d.artworkUrl);
    } catch { /* non-critical */ }
  }, []);

  const fetchInfo = useCallback(async (artist: string, title: string) => {
    setInfoLoading(true);
    setInfo(null);
    try {
      const r = await fetch(`${basePath}/api/discover/info?${new URLSearchParams({ artist, title })}`);
      setInfo(r.ok ? await r.json() : { artist: null, track: null });
    } catch {
      setInfo({ artist: null, track: null });
    } finally {
      setInfoLoading(false);
    }
  }, []);

  const loadNext = useCallback(async () => {
    setLoading(true);
    setArtwork(null);
    setInfo(null);
    setNote('');
    setNoteOpen(false);
    try {
      const params = new URLSearchParams({
        userId: String(userId),
        exclude: servedRef.current.slice(-40).join(','),
      });
      const r = await fetch(`${basePath}/api/discover/track?${params}`);
      const d = await r.json() as { track: DiscoverTrack | null };
      if (!d.track) { setTrack(null); setEmpty(true); }
      else {
        setTrack(d.track);
        servedRef.current.push(`${d.track.title}|${d.track.artist}`.toLowerCase());
        setEmpty(false);
        if (d.track.artworkUrl) setArtwork(d.track.artworkUrl);
        else fetchArtwork(d.track.artist, d.track.title);
        fetchInfo(d.track.artist, d.track.title);
      }
    } catch {
      setEmpty(true);
    } finally {
      setLoading(false);
    }
  }, [userId, fetchArtwork, fetchInfo]);

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
    finally { setSaving(null); loadNext(); }
  };

  const skip = () => {
    if (saving !== null) return;
    setSaving('skip');
    setHoveredStar(null);
    loadNext().finally(() => setSaving(null));
  };

  // Show info panels whenever a track is present (loading state shows skeleton)
  const showPanels = !!(track && !empty);

  return (
    /* -mx-6 breaks out of the parent's p-6 padding to use full viewport width */
    <div className="-mx-6 flex items-start gap-1.5 sm:gap-2">

      {/* ── LEFT panel: Artist ── */}
      <InfoPanel
        label="Artist"
        heading={track?.artist ?? ''}
        text={info?.artist ?? null}
        loading={infoLoading}
        visible={showPanels}
      />

      {/* ── Centre: the card ── */}
      <div className="flex-1 min-w-0 rounded-2xl border border-primary/15 bg-secondary/10 p-3.5 sm:p-5 space-y-3">

        {/* Header */}
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
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 text-primary animate-spin" />
          </div>
        ) : empty || !track ? (
          <div className="text-center py-5 space-y-1">
            <p className="text-sm text-muted-foreground">No fresh picks right now.</p>
            <p className="text-xs text-muted-foreground/60">Rate or seed a few tracks first.</p>
          </div>
        ) : (
          <>
            {/* Track: thumbnail + title/artist */}
            <div className="flex items-center gap-2.5">
              <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-secondary/50 border border-primary/10 overflow-hidden relative flex items-center justify-center shrink-0">
                <span className="text-base font-mono font-bold text-primary/20 absolute">
                  {(track.artist[0] ?? track.title[0] ?? '?').toUpperCase()}
                </span>
                {artwork && (
                  <img src={artwork} alt="" className="w-full h-full object-cover relative"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm sm:text-base font-medium text-foreground truncate leading-snug">{track.title}</p>
                <p className="text-xs sm:text-sm text-muted-foreground truncate">{track.artist}</p>
              </div>
            </div>

            {/* Preview pill + Spotify */}
            <div className="flex items-center gap-2">
              <TrackPreviewPill key={track.mbid} title={track.title} artist={track.artist} />
              <a
                href={`https://open.spotify.com/search/${encodeURIComponent(`${track.title} ${track.artist}`)}/tracks`}
                target="_blank"
                rel="noopener noreferrer"
                title="Open in Spotify"
                className="flex items-center justify-center w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-[#1DB954]/10 hover:bg-[#1DB954]/25 border border-[#1DB954]/30 hover:border-[#1DB954]/60 transition-colors shrink-0"
              >
                <SiSpotify className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-[#1DB954]" />
              </a>
            </div>

            {/* Notes */}
            {noteOpen ? (
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What do you notice?"
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
            <div
              className="flex items-center justify-between"
              onMouseLeave={() => setHoveredStar(null)}
            >
              <div className="flex items-center gap-0.5">
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
                      <Star className={`w-5 h-5 sm:w-6 sm:h-6 transition-colors ${
                        filled ? 'fill-amber-400 text-amber-400' : 'fill-transparent text-muted-foreground/30'
                      }`} />
                    </button>
                  );
                })}
                <span className="text-[10px] font-mono text-muted-foreground/40 uppercase tracking-wide ml-1">
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

      {/* ── RIGHT panel: Song ── */}
      <InfoPanel
        label="Song"
        heading={track?.title ?? ''}
        text={info?.track ?? null}
        loading={infoLoading}
        visible={showPanels}
      />
    </div>
  );
}

/** Side info panel — slides in when visible. Scrollable for long blurbs. */
function InfoPanel({
  label, heading, text, loading, visible,
}: {
  label: string;
  heading: string;
  text: string | null;
  loading: boolean;
  visible: boolean;
}) {
  return (
    <div
      className={`
        w-[26vw] max-w-[180px] shrink-0 self-stretch
        flex flex-col
        rounded-xl border border-border/25 bg-secondary/15
        overflow-hidden
        transition-all duration-300 ease-out
        ${visible ? 'opacity-100 translate-x-0' : 'opacity-0 pointer-events-none'}
      `}
    >
      {/* Fixed header */}
      <div className="px-3 pt-3 pb-1.5 shrink-0">
        <p className="text-[10px] font-mono text-primary/60 uppercase tracking-widest mb-1">{label}</p>
        <p className="text-sm font-semibold text-foreground leading-snug line-clamp-2">{heading}</p>
      </div>

      {/* Scrollable blurb */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 min-h-0 overscroll-contain">
        {loading && !text ? (
          <div className="flex items-center gap-1.5 text-muted-foreground/40 pt-1">
            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
            <span className="text-[10px] font-mono uppercase tracking-wide">Reading…</span>
          </div>
        ) : text ? (
          <p className="text-xs leading-relaxed text-muted-foreground pt-0.5">{text}</p>
        ) : !loading ? (
          <p className="text-xs italic text-muted-foreground/40 pt-1">No write-up.</p>
        ) : null}
      </div>
    </div>
  );
}
