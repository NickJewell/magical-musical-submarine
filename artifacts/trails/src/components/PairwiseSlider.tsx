import { useState, useEffect } from 'react';
import { useSubmitPair } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { TrackPreviewPill } from '@/components/TrackPreviewPill';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

const LABEL: Record<number, string> = {
  [-2]: 'strongly this one',
  [-1]: 'slightly this one',
  [0]: 'tie',
  [1]: 'slightly this one',
  [2]: 'strongly this one',
};

interface PairwiseSliderProps {
  userId: number;
  aMbid: string;
  aTitle: string;
  aArtist: string;
  bMbid: string;
  bTitle: string;
  bArtist: string;
  onDone: () => void;
  onSkip?: () => void;
}

interface DeezerPreview { previewUrl: string | null; deezerId: string | null }

async function fetchPreview(title: string, artist: string): Promise<DeezerPreview> {
  try {
    const params = new URLSearchParams({ title, artist });
    const res = await fetch(`${basePath}/api/deezer-preview?${params}`);
    if (!res.ok) return { previewUrl: null, deezerId: null };
    return await res.json() as DeezerPreview;
  } catch {
    return { previewUrl: null, deezerId: null };
  }
}

export function PairwiseSlider({
  userId, aMbid, aTitle, aArtist, bMbid, bTitle, bArtist, onDone, onSkip,
}: PairwiseSliderProps) {
  const [value, setValue] = useState(0);
  const submitPair = useSubmitPair();

  // Pre-fetch preview URLs so TrackPreviewPill can play instantly
  const [aPreviewUrl, setAPreviewUrl] = useState<string | null | undefined>(undefined);
  const [bPreviewUrl, setBPreviewUrl] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setAPreviewUrl(undefined);
    setBPreviewUrl(undefined);
    let cancelled = false;
    Promise.all([
      fetchPreview(aTitle, aArtist),
      fetchPreview(bTitle, bArtist),
    ]).then(([a, b]) => {
      if (cancelled) return;
      setAPreviewUrl(a.previewUrl);
      setBPreviewUrl(b.previewUrl);
    });
    return () => { cancelled = true; };
  }, [aMbid, bMbid, aTitle, aArtist, bTitle, bArtist]);

  const handleConfirm = () => {
    submitPair.mutate(
      { data: { userId, aMbid, bMbid, result: value } },
      { onSuccess: () => { setValue(0); onDone(); } }
    );
  };

  const leftActive  = value < 0;
  const rightActive = value > 0;
  const isCenter    = value === 0;

  // undefined = still fetching, null = no preview available
  const PreviewButton = ({ side }: { side: 'a' | 'b' }) => {
    const url   = side === 'a' ? aPreviewUrl : bPreviewUrl;
    const title  = side === 'a' ? aTitle : bTitle;
    const artist = side === 'a' ? aArtist : bArtist;

    if (url === undefined) {
      return (
        <div className="mt-2 flex justify-center">
          <Loader2 className="w-3 h-3 text-muted-foreground/30 animate-spin" />
        </div>
      );
    }

    // Always render the pill — if pre-fetch returned null the pill fetches on
    // click; if Deezer still has nothing it returns to idle silently.
    return (
      <div className="mt-2 flex justify-center">
        <TrackPreviewPill title={title} artist={artist} previewUrl={url ?? undefined} />
      </div>
    );
  };

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest text-center">
        Which resonates more?
      </p>

      {/* Two cards */}
      <div className="grid grid-cols-2 gap-3">
        <div className={`p-4 rounded-2xl border text-center transition-all duration-200 ${
          leftActive ? 'border-primary/70 bg-primary/10 shadow-[0_0_12px_hsla(180,80%,40%,0.15)]' : 'border-border/30 bg-secondary/20'
        }`}>
          <p className="font-medium text-sm text-foreground leading-snug line-clamp-2">{aTitle}</p>
          <p className="text-xs text-muted-foreground mt-1 truncate">{aArtist}</p>
          {leftActive && (
            <p className="text-[10px] font-mono text-primary mt-2 uppercase tracking-wide">
              {LABEL[value]}
            </p>
          )}
          <PreviewButton side="a" />
        </div>
        <div className={`p-4 rounded-2xl border text-center transition-all duration-200 ${
          rightActive ? 'border-primary/70 bg-primary/10 shadow-[0_0_12px_hsla(180,80%,40%,0.15)]' : 'border-border/30 bg-secondary/20'
        }`}>
          <p className="font-medium text-sm text-foreground leading-snug line-clamp-2">{bTitle}</p>
          <p className="text-xs text-muted-foreground mt-1 truncate">{bArtist}</p>
          {rightActive && (
            <p className="text-[10px] font-mono text-primary mt-2 uppercase tracking-wide">
              {LABEL[value]}
            </p>
          )}
          <PreviewButton side="b" />
        </div>
      </div>

      {/* Slider */}
      <div className="space-y-2 px-1">
        <input
          type="range"
          min="-2"
          max="2"
          step="1"
          value={value}
          onChange={e => setValue(Number(e.target.value))}
          className="w-full h-2 rounded-full appearance-none cursor-pointer bg-secondary/60
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-5
            [&::-webkit-slider-thumb]:h-5
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-primary
            [&::-webkit-slider-thumb]:shadow-[0_0_8px_hsla(180,80%,40%,0.5)]
            [&::-webkit-slider-thumb]:cursor-pointer
            [&::-webkit-slider-thumb]:transition-transform
            [&::-webkit-slider-thumb]:hover:scale-110
            [&::-moz-range-thumb]:w-5
            [&::-moz-range-thumb]:h-5
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:bg-primary
            [&::-moz-range-thumb]:border-0
            [&::-moz-range-thumb]:cursor-pointer"
        />
        <div className="flex justify-between text-[9px] font-mono text-muted-foreground/50 px-0.5">
          <span>← strongly</span>
          {isCenter && <span className="text-primary/60">tie</span>}
          <span>strongly →</span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          onClick={handleConfirm}
          disabled={submitPair.isPending}
          className="flex-1 rounded-full bg-primary text-primary-foreground h-11 text-sm"
        >
          {submitPair.isPending ? 'Saving…' : 'Confirm'}
        </Button>
        {onSkip && (
          <Button
            onClick={onSkip}
            variant="ghost"
            className="rounded-full text-muted-foreground h-11 px-5 text-sm"
          >
            Skip
          </Button>
        )}
      </div>
    </div>
  );
}
