import { useEffect, useState, useRef } from 'react';
import { useParams, useLocation } from 'wouter';
import { 
  useLoadDive, useLoadRecap, useGetDirections, useChooseStep,
  getLoadDiveQueryKey, getLoadRecapQueryKey 
} from '@workspace/api-client-react';
import { useLocalUser } from '@/lib/useLocalUser';
import { Button } from '@/components/ui/button';
import { Loader2, ArrowRight } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

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
  
  // Active step is the last one if it has no recommendations yet, otherwise we need a new step.
  // Actually, the API says `useGetDirections` gets hypothesis + 3 directions when the step hasn't started yet.
  // We can just call it unconditionally; if it's already generated for the current empty step, it returns it.
  
  const [directionsReady, setDirectionsReady] = useState(false);

  const getDirections = useGetDirections();
  const chooseStep = useChooseStep();
  
  const getDirsMutateRef = useRef(getDirections.mutate);
  getDirsMutateRef.current = getDirections.mutate;

  useEffect(() => {
    if (dive && !directionsReady) {
      getDirsMutateRef.current(
        { data: { userId, diveId } },
        { onSuccess: () => setDirectionsReady(true) }
      );
    }
  }, [dive, userId, diveId, directionsReady]);

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

  if (diveLoading || getDirections.isPending) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-[100dvh] space-y-6">
        <div className="w-16 h-16 rounded-full border border-primary/30 flex items-center justify-center animate-float">
          <Loader2 className="w-6 h-6 text-primary animate-spin" />
        </div>
        <p className="text-sm font-mono text-muted-foreground uppercase tracking-widest animate-pulse">Ping...</p>
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
