import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, Star, Sparkles, SkipForward } from 'lucide-react';
import { InlinePlayer, type ResolvedLinks } from '@/components/InlinePlayer';

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

/**
 * A rapid "rate to rank" feed on Home: collaborative-filtering pulls a fresh
 * track from what the user already ranks highest; a star (or skip) records it
 * and immediately serves the next — the fastest way to grow the rankings table.
 * Preview uses the same lazy InlinePlayer as elsewhere.
 */
export function DiscoverCard({ userId }: { userId: number }) {
  const [track, setTrack] = useState<DiscoverTrack | null>(null);
  const [loading, setLoading] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [saving, setSaving] = useState<number | 'skip' | null>(null);
  const [added, setAdded] = useState(0);
  const servedRef = useRef<string[]>([]);

  const [links, setLinks] = useState<ResolvedLinks | null>(null);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [playerActive, setPlayerActive] = useState(false);

  // Info bubbles: artist + song blurbs, fetched when the preview is opened.
  const [info, setInfo] = useState<{ artist: string | null; track: string | null } | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);

  const loadNext = useCallback(async () => {
    setLoading(true);
    setLinks(null);
    setPlayerActive(false);
    setInfo(null);
    try {
      const params = new URLSearchParams({
        userId: String(userId),
        exclude: servedRef.current.slice(-40).join(','),
      });
      const r = await fetch(`${basePath}/api/discover/track?${params}`);
      const d = await r.json();
      if (!d.track) { setTrack(null); setEmpty(true); }
      else {
        const t = d.track as DiscoverTrack;
        setTrack(t);
        servedRef.current.push(`${t.title}|${t.artist}`.toLowerCase());
        setEmpty(false);
        // Pool tracks carry a Spotify id → seed the player for an instant preview.
        if (t.spotifyId) {
          setLinks({
            spotify: `https://open.spotify.com/track/${t.spotifyId}`,
            youtube: null,
            spotifyTrackId: t.spotifyId,
            youtubeVideoId: null,
            deezerId: null,
          });
        }
      }
    } catch {
      setEmpty(true);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { loadNext(); }, [loadNext]);

  const handleNeedLinks = useCallback(async () => {
    if (!track || loadingLinks) return;
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
  }, [track, links, loadingLinks]);

  const loadInfo = useCallback(async () => {
    if (!track || info || infoLoading) return;
    setInfoLoading(true);
    try {
      const params = new URLSearchParams({ artist: track.artist, title: track.title });
      const r = await fetch(`${basePath}/api/discover/info?${params}`);
      setInfo(r.ok ? await r.json() : { artist: null, track: null });
    } catch {
      setInfo({ artist: null, track: null });
    } finally {
      setInfoLoading(false);
    }
  }, [track, info, infoLoading]);

  const rate = async (score: number) => {
    if (!track || saving !== null) return;
    setSaving(score);
    try {
      await fetch(`${basePath}/api/focus-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId, mbid: track.mbid, title: track.title, artist: track.artist,
          listenState: 'known', score,
        }),
      });
      setAdded((n) => n + 1);
    } catch { /* best-effort — advance regardless */ }
    finally {
      setSaving(null);
      loadNext();
    }
  };

  const skip = () => { if (saving === null) { setSaving('skip'); loadNext().finally(() => setSaving(null)); } };

  const artwork = track?.artworkUrl ?? (links as (ResolvedLinks & { artworkUrl?: string | null }) | null)?.artworkUrl ?? null;

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
          {/* Track */}
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
            <div className="min-w-0">
              <p className="text-base font-medium text-foreground truncate leading-snug">{track.title}</p>
              <p className="text-sm text-muted-foreground truncate">{track.artist}</p>
            </div>
          </div>

          {/* Preview */}
          <InlinePlayer
            key={track.mbid}
            recId={0}
            links={links}
            isLoadingLinks={loadingLinks}
            onNeedLinks={handleNeedLinks}
            activeRecId={playerActive ? 0 : null}
            onActivate={(id) => {
              setPlayerActive(id !== null);
              if (id !== null) { handleNeedLinks(); loadInfo(); }
            }}
          />

          {/* Info bubbles — appear when the preview is open (side-by-side on wider
              screens, stacked on mobile) */}
          {playerActive && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 animate-in fade-in slide-in-from-top-1 duration-200">
              <InfoBubble label="Artist" heading={track.artist} text={info?.artist ?? null} loading={infoLoading && !info} />
              <InfoBubble label="Song" heading={track.title} text={info?.track ?? null} loading={infoLoading && !info} />
            </div>
          )}

          {/* Rate → adds to rankings and advances */}
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-1">
              {[1, 2, 3].map((s) => (
                <button
                  key={s}
                  onClick={() => rate(s)}
                  disabled={saving !== null}
                  className="p-1 transition-transform hover:scale-110 disabled:opacity-40"
                  title={`${s}/3`}
                >
                  <Star className={`w-6 h-6 transition-colors ${
                    saving === s ? 'fill-amber-400 text-amber-400' : 'fill-transparent text-muted-foreground/30 hover:text-amber-400/70'
                  }`} />
                </button>
              ))}
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

function InfoBubble({
  label, heading, text, loading,
}: { label: string; heading: string; text: string | null; loading: boolean }) {
  return (
    <div className="rounded-xl border border-border/30 bg-secondary/20 p-3">
      <p className="text-[9px] font-mono text-primary/60 uppercase tracking-widest mb-1">{label}</p>
      <p className="text-xs font-medium text-foreground/90 truncate mb-1.5">{heading}</p>
      {loading ? (
        <div className="flex items-center gap-1.5 text-muted-foreground/40">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span className="text-[10px] font-mono uppercase tracking-wide">Reading up…</span>
        </div>
      ) : text ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground max-h-36 overflow-y-auto">{text}</p>
      ) : (
        <p className="text-[11px] italic text-muted-foreground/40">No write-up found.</p>
      )}
    </div>
  );
}
