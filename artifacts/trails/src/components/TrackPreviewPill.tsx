/**
 * TrackPreviewPill — compact play/pause pill for 30s Deezer audio previews.
 * Fetches the preview URL on demand, streams audio through the server proxy
 * to avoid CORS restrictions. Only one track plays globally at a time.
 */

import { useState, useEffect, useRef } from 'react';
import { Play, Pause, Loader2 } from 'lucide-react';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

// ---- Global singleton: one Audio element across all pill instances ----
type StopFn = () => void;
let _audio: HTMLAudioElement | null = null;
let _stop: StopFn | null = null;

function stopGlobal() {
  _audio?.pause();
  _audio = null;
  const s = _stop;
  _stop = null;
  s?.();
}

// ---- Component ----

interface Props {
  title: string;
  artist: string;
  /** Optional: pre-fetched Deezer preview URL — skips the fetch if provided */
  previewUrl?: string | null;
}

export function TrackPreviewPill({ title, artist, previewUrl: cachedUrl }: Props) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  // Track whether *this* instance is the global owner
  const isOwnerRef = useRef(false);

  // If something else stops this instance externally, reset state
  useEffect(() => {
    return () => {
      // On unmount, release ownership if we hold it
      if (isOwnerRef.current) {
        isOwnerRef.current = false;
        _audio?.pause();
        _audio = null;
        _stop = null;
      }
    };
  }, []);

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (state === 'playing') {
      // Pause and release
      stopGlobal();
      isOwnerRef.current = false;
      setState('idle');
      return;
    }

    // Stop whatever else is playing globally
    if (_stop && !isOwnerRef.current) stopGlobal();

    setState('loading');

    try {
      let url = cachedUrl ?? null;

      if (!url) {
        const params = new URLSearchParams({ title, artist });
        const res = await fetch(`${basePath}/api/deezer-preview?${params}`);
        if (!res.ok) { setState('idle'); return; }
        const data = await res.json() as { previewUrl: string | null };
        url = data.previewUrl;
      }

      if (!url) { setState('idle'); return; }

      const proxyUrl = `${basePath}/api/audio-proxy?url=${encodeURIComponent(url)}`;
      const audio = new Audio(proxyUrl);
      _audio = audio;
      isOwnerRef.current = true;
      _stop = () => { setState('idle'); isOwnerRef.current = false; };

      audio.play().catch(() => {
        setState('idle');
        isOwnerRef.current = false;
        _audio = null;
        _stop = null;
      });

      audio.onended = () => {
        setState('idle');
        isOwnerRef.current = false;
        _audio = null;
        _stop = null;
      };

      setState('playing');
    } catch {
      setState('idle');
      isOwnerRef.current = false;
    }
  };

  return (
    <button
      onClick={toggle}
      className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono transition-all
        ${state === 'playing'
          ? 'bg-primary/20 text-primary border border-primary/40'
          : 'bg-secondary/40 text-muted-foreground border border-border/30 hover:text-primary hover:border-primary/30'
        }`}
    >
      {state === 'loading'
        ? <><Loader2 className="w-2.5 h-2.5 animate-spin" /> loading</>
        : state === 'playing'
          ? <><Pause className="w-2.5 h-2.5" /> pause</>
          : <><Play  className="w-2.5 h-2.5" /> preview</>
      }
    </button>
  );
}
