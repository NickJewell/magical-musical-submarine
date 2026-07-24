import { useEffect, useState, useRef } from 'react';
import { useParams, useLocation } from 'wouter';
import { 
  useLoadDive, useLoadRecap, useGetDirections, useChooseStep, useGetTastePair,
  getLoadDiveQueryKey, getLoadRecapQueryKey 
} from '@workspace/api-client-react';
import { useLocalUser } from '@/lib/useLocalUser';
import { Button } from '@/components/ui/button';
import { Loader2, ArrowRight } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { PairwiseSlider } from '@/components/PairwiseSlider';

export default function DivePage() {
  const { id: diveIdStr } = useParams();
  const diveId = parseInt(diveIdStr || '0', 10);
  const { localUserId: userId, isLoading } = useLocalUser();
  const [, setLocation] = useLocation();

  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center min-h-[100dvh]">
      <Loader2 className="w-6 h-6 text-primary animate-spin" />
    </div>
  );
  if (!userId || !diveId) return null;

  return <DiveContent userId={userId} diveId={diveId} onNavigate={setLocation} />;
}

function DiveContent({ userId, diveId, onNavigate }: { userId: number, diveId: number, onNavigate: (p: string) => void }) {
  // Generated hook sends both diveId and userId as required query params (ownership-safe)
  const { data: dive, isLoading: diveLoading } = useLoadDive(
    { diveId, userId },
    { query: { enabled: !!diveId && !!userId, queryKey: getLoadDiveQueryKey({ diveId, userId }) } }
  );
  
  const [directionsReady, setDirectionsReady] = useState(false);
  const [showPairwise] = useState(() => Math.random() < 0.5);
  const [pairwiseDone, setPairwiseDone] = useState(false);

  const getDirections = useGetDirections();
  const chooseStep = useChooseStep();

  const { data: tastePair } = useGetTastePair(
    { userId },
    { query: { enabled: showPairwise && !!userId } }
  );
  
  const [directionsFailed, setDirectionsFailed] = useState(false);

  const getDirsMutateRef = useRef(getDirections.mutate);
  getDirsMutateRef.current = getDirections.mutate;

  useEffect(() => {
    if (dive && !directionsReady && !directionsFailed) {
      getDirsMutateRef.current(
        { data: { userId, diveId } },
        {
          onSuccess: () => setDirectionsReady(true),
          onError: () => setDirectionsFailed(true),
        }
      );
    }
  }, [dive, userId, diveId, directionsReady, directionsFailed]);

  const handleRetryDirections = () => {
    setDirectionsFailed(false);
    getDirections.reset();
  };

  const { data: recap, isLoading: recapLoading } = useLoadRecap(
    { diveId, userId },
    { query: { enabled: !!dive && dive.steps.length > 1, queryKey: getLoadRecapQueryKey({ diveId, userId }) } }
  );

  const handleChoose = (label: string) => {
    if (!getDirections.data) return;
    chooseStep.mutate(
      { 
        data: {
          userId,
          diveId,
          chosenDirection: label,
          hypothesisText: getDirections.data.hypothesis,
          directionsJson: getDirections.data
        }
      },
      {
        onSuccess: () => {
          onNavigate(`/dive/${diveId}/queue`);
        }
      }
    );
  };

  const activePair = showPairwise && !pairwiseDone && tastePair && !tastePair.done;

  if (diveLoading || getDirections.isPending) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-[100dvh] p-6">
        {activePair ? (
          <div className="w-full max-w-sm space-y-6">
            <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest text-center animate-pulse">
              Charting your course…
            </p>
            <div className="p-5 rounded-2xl bg-secondary/20 border border-primary/15">
              <PairwiseSlider
                userId={userId}
                aMbid={tastePair.aMbid!}
                aTitle={tastePair.aTitle!}
                aArtist={tastePair.aArtist!}
                bMbid={tastePair.bMbid!}
                bTitle={tastePair.bTitle!}
                bArtist={tastePair.bArtist!}
                onDone={() => setPairwiseDone(true)}
                onSkip={() => setPairwiseDone(true)}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center space-y-6">
            <div className="w-16 h-16 rounded-full border border-primary/30 flex items-center justify-center animate-float">
              <Loader2 className="w-6 h-6 text-primary animate-spin" />
            </div>
            <p className="text-sm font-mono text-muted-foreground uppercase tracking-widest animate-pulse">Ping...</p>
          </div>
        )}
      </div>
    );
  }

  const dirs = getDirections.data;

  return (
    <div className="p-6 pt-12 max-w-md mx-auto space-y-12 pb-24 animate-in fade-in duration-1000">
      <div className="text-center space-y-2">
        <h1 className="text-sm font-mono text-muted-foreground uppercase tracking-widest">{dive?.name}</h1>
        {dive && <p className="text-xs text-muted-foreground/50">Depth: {dive.steps.length * 100}m</p>}
      </div>

      {recap && (
        <div className="space-y-3 p-5 rounded-2xl bg-secondary/20 border border-border/50">
          <h2 className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Previously on this dive</h2>
          <p className="text-sm font-serif text-primary-foreground/80 leading-relaxed">{recap.recap}</p>
        </div>
      )}

      {directionsFailed && (
        <div className="space-y-4 text-center py-8">
          <p className="text-sm text-muted-foreground">Couldn't reach the surface — the navigation system timed out.</p>
          <Button
            variant="outline"
            className="rounded-full border-primary/30 text-primary hover:bg-primary/10"
            onClick={handleRetryDirections}
          >
            Try again
          </Button>
        </div>
      )}

      {dirs && (
        <div className="space-y-8">
          <div className="space-y-4">
            <h2 className="text-[10px] font-mono text-primary uppercase tracking-widest flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              Current Hypothesis
            </h2>
            <p className="text-xl font-serif leading-snug text-primary-foreground">{dirs.hypothesis}</p>
          </div>

          <div className="space-y-4">
            {dirs.directions.map((dir, i) => (
              <button
                key={i}
                onClick={() => handleChoose(dir.label)}
                disabled={chooseStep.isPending}
                className="w-full text-left p-6 rounded-2xl bg-secondary/40 border border-primary/20 hover:border-primary/60 hover:bg-secondary/60 transition-all group block"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-2">
                    <h3 className="text-lg font-medium text-primary-foreground group-hover:text-primary transition-colors">{dir.label}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{dir.rationale}</p>
                  </div>
                  <ArrowRight className="w-5 h-5 text-primary opacity-0 group-hover:opacity-100 transition-opacity mt-1 shrink-0" />
                </div>
              </button>
            ))}
          </div>

          {dirs.wellTroddenDirection && (
            <div className="pt-8 text-center">
              <button
                onClick={() => handleChoose(dirs.wellTroddenDirection.label)}
                disabled={chooseStep.isPending}
                className="text-sm text-muted-foreground/60 hover:text-muted-foreground transition-colors underline decoration-border underline-offset-4"
              >
                Or take the well-trodden road: {dirs.wellTroddenDirection.label}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
