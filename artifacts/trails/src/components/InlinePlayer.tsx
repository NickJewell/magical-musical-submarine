/**
 * InlinePlayer — §18
 * Lazy-mounted Spotify / YouTube / Deezer embed inside a rec card.
 * Only one player is active at a time (controlled by parent via activeRecId).
 */

import { useState, useEffect } from 'react';
import { Play, ChevronUp, Loader2 } from 'lucide-react';
import { SiSpotify, SiYoutube, SiDeezer } from 'react-icons/si';
import { cn } from '@/lib/utils';

type Provider = 'spotify' | 'youtube' | 'deezer';

export interface ResolvedLinks {
  spotify:        string | null;
  youtube:        string | null;
  spotifyTrackId: string | null;
  youtubeVideoId: string | null;
  deezerId:       string | null;
}

interface Props {
  recId:           number;
  links:           ResolvedLinks | null;
  isLoadingLinks:  boolean;
  onNeedLinks:     () => void;
  activeRecId:     number | null;
  onActivate:      (id: number | null) => void;
}

export function InlinePlayer({
  recId, links, isLoadingLinks, onNeedLinks, activeRecId, onActivate,
}: Props) {
  const isActive = activeRecId === recId;

  const hasSpotify = !!(links?.spotifyTrackId);
  const hasYoutube = !!(links?.youtubeVideoId);
  const hasDeezer  = !!(links?.deezerId);
  const hasEmbed   = hasSpotify || hasYoutube || hasDeezer;

  // Default provider priority: Spotify → YouTube → Deezer
  const defaultProvider: Provider = hasSpotify ? 'spotify' : hasYoutube ? 'youtube' : 'deezer';
  const [provider, setProvider]   = useState<Provider>(defaultProvider);

  // Sync provider when links first arrive
  useEffect(() => {
    if (hasSpotify) setProvider('spotify');
    else if (hasYoutube) setProvider('youtube');
    else if (hasDeezer) setProvider('deezer');
  }, [hasSpotify, hasYoutube, hasDeezer]);

  // Actual provider to render (fallback if preferred unavailable)
  const activeProvider: Provider =
    provider === 'spotify' && !hasSpotify ? (hasYoutube ? 'youtube' : 'deezer') :
    provider === 'youtube' && !hasYoutube ? (hasSpotify ? 'spotify' : 'deezer') :
    provider === 'deezer'  && !hasDeezer  ? (hasSpotify ? 'spotify' : 'youtube') :
    provider;

  const handleOpen = () => {
    onActivate(recId);
    if (!links) onNeedLinks();
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onActivate(null);
  };

  // ---- Collapsed affordance ----
  if (!isActive) {
    return (
      <button
        onClick={handleOpen}
        className="flex items-center gap-2 text-xs font-mono text-muted-foreground/60 hover:text-primary/80 transition-colors group"
      >
        <div className="w-7 h-7 rounded-full border border-primary/20 bg-primary/5 flex items-center justify-center group-hover:bg-primary/15 group-hover:border-primary/40 transition-all">
          <Play className="w-3 h-3 text-primary fill-primary" />
        </div>
        <span className="uppercase tracking-widest text-[10px]">Preview</span>
      </button>
    );
  }

  // ---- Expanded ----
  return (
    <div className="space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">

      {/* Provider toggle + collapse */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 p-0.5 bg-secondary/30 rounded-lg border border-border/30">
          {hasSpotify && (
            <button
              onClick={() => setProvider('spotify')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono transition-all',
                activeProvider === 'spotify'
                  ? 'bg-[#1DB954]/20 text-[#1DB954] border border-[#1DB954]/30'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <SiSpotify className="w-3 h-3" />
              Spotify
            </button>
          )}
          {hasYoutube && (
            <button
              onClick={() => setProvider('youtube')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono transition-all',
                activeProvider === 'youtube'
                  ? 'bg-[#FF0000]/15 text-[#FF0000] border border-[#FF0000]/25'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <SiYoutube className="w-3.5 h-3.5" />
              YouTube
            </button>
          )}
          {hasDeezer && (
            <button
              onClick={() => setProvider('deezer')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono transition-all',
                activeProvider === 'deezer'
                  ? 'bg-[#EF5466]/15 text-[#EF5466] border border-[#EF5466]/25'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <SiDeezer className="w-3.5 h-3.5" />
              Deezer
            </button>
          )}
        </div>

        <button
          onClick={handleClose}
          className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground transition-colors"
        >
          <ChevronUp className="w-3.5 h-3.5" />
          close
        </button>
      </div>

      {/* Embed area */}
      {isLoadingLinks ? (
        <div className="flex items-center justify-center h-20 rounded-xl bg-secondary/20 border border-border/20">
          <Loader2 className="w-5 h-5 animate-spin text-primary/50" />
        </div>
      ) : !hasEmbed ? (
        <p className="text-xs text-muted-foreground/50 text-center py-4 font-mono">
          No embeddable preview found
        </p>
      ) : activeProvider === 'spotify' && links?.spotifyTrackId ? (
        <iframe
          key={`sp-${links.spotifyTrackId}`}
          src={`https://open.spotify.com/embed/track/${links.spotifyTrackId}?theme=0`}
          width="100%"
          height="152"
          frameBorder="0"
          loading="lazy"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          className="rounded-xl"
          title="Spotify player"
        />
      ) : activeProvider === 'youtube' && links?.youtubeVideoId ? (
        <iframe
          key={`yt-${links.youtubeVideoId}`}
          src={`https://www.youtube.com/embed/${links.youtubeVideoId}?autoplay=1`}
          width="100%"
          height="152"
          frameBorder="0"
          loading="lazy"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          className="rounded-xl"
          title="YouTube player"
        />
      ) : activeProvider === 'deezer' && links?.deezerId ? (
        <iframe
          key={`dz-${links.deezerId}`}
          src={`https://widget.deezer.com/widget/auto/track/${links.deezerId}?autoplay=true`}
          width="100%"
          height="152"
          frameBorder="0"
          loading="lazy"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          className="rounded-xl"
          title="Deezer player"
        />
      ) : null}
    </div>
  );
}
