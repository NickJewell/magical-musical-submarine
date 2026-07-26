import { Compass, Loader2 } from 'lucide-react';
import { useSparkDive } from '@/lib/useSparkDive';
import { cn } from '@/lib/utils';

/**
 * Start a brand-new dive from any track shown anywhere in the app — powered by
 * the track's own personality plus the user's taste graph. Two shapes: a full
 * labelled button, or a compact icon for dense rows.
 */
export function DiveFromTrackButton({
  mbid, title, artist, variant = 'full', className,
}: {
  mbid?: string | null;
  title: string;
  artist: string;
  variant?: 'full' | 'compact';
  className?: string;
}) {
  const { start, isPending } = useSparkDive();

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isPending) return;
    start({ type: 'track', mbid: mbid ?? null, title, artist }, `From ${title}`);
  };

  if (variant === 'compact') {
    return (
      <button
        onClick={handleClick}
        disabled={isPending}
        title={`Dive from "${title}"`}
        className={cn(
          'p-1.5 rounded-full text-muted-foreground/40 hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-40',
          className,
        )}
      >
        {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Compass className="w-4 h-4" />}
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className={cn(
        'w-full flex items-center justify-center gap-2 h-11 rounded-full border border-primary/30 text-primary text-sm font-medium hover:bg-primary/10 transition-colors disabled:opacity-50',
        className,
      )}
    >
      {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Compass className="w-4 h-4" />}
      Dive from this track
    </button>
  );
}
