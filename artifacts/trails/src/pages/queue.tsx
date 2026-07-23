import { useState, useEffect, useRef } from 'react';
import { useParams, useLocation } from 'wouter';
import { 
  useGetRecommendations, useResolveLinks, useRateRec, useRateStep, useLoadDive,
  getLoadDiveQueryKey, getResolveLinksQueryKey,
  type Recommendation
} from '@workspace/api-client-react';
import { getUserId } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Loader2, Play, Star } from 'lucide-react';
import { SiSpotify, SiYoutube } from 'react-icons/si';

export default function QueuePage() {
  const { id: diveIdStr } = useParams();
  const diveId = parseInt(diveIdStr || '0', 10);
  const userId = getUserId();
  const [, setLocation] = useLocation();

  if (!userId || !diveId) return null;

  return <QueueContent userId={userId} diveId={diveId} onNavigate={setLocation} />;
}

function QueueContent({ userId, diveId, onNavigate }: { userId: number, diveId: number, onNavigate: (p: string) => void }) {
  // Generated hook sends both diveId and userId as required query params (ownership-safe)
  const { data: dive } = useLoadDive(
    { diveId, userId },
    { query: { enabled: !!diveId && !!userId, queryKey: getLoadDiveQueryKey({ diveId, userId }) } }
  );
  
  const stepId = dive?.steps?.[dive.steps.length - 1]?.id;

  const [hasStartedFetch, setHasStartedFetch] = useState(false);
  const getRecommendations = useGetRecommendations();

  const mutateRef = useRef(getRecommendations.mutate);
  mutateRef.current = getRecommendations.mutate;

  useEffect(() => {
    if (stepId && !hasStartedFetch) {
      setHasStartedFetch(true);
      mutateRef.current({ data: { stepId, userId } });
    }
  }, [stepId, userId, hasStartedFetch]);

  if (!stepId || getRecommendations.isPending || !getRecommendations.data) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-[100dvh] space-y-8 bg-background relative overflow-hidden">
        {/* Bubbles animation */}
        <div className="absolute inset-0 pointer-events-none">
          {[...Array(10)].map((_, i) => (
            <div 
              key={i} 
              className="absolute w-2 h-2 rounded-full bg-primary/20 animate-float"
              style={{
                left: `${Math.random() * 100}%`,
                top: `${Math.random() * 100}%`,
                animationDelay: `${Math.random() * 5}s`,
                animationDuration: `${4 + Math.random() * 4}s`
              }}
            />
          ))}
        </div>
        
        <div className="w-24 h-24 rounded-full bg-primary/10 flex items-center justify-center animate-sonar border border-primary/20">
          <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center animate-float">
             <div className="w-8 h-8 rounded-full bg-primary/40 flex items-center justify-center">
               <div className="w-3 h-3 rounded-full bg-primary" />
             </div>
          </div>
        </div>
        
        <div className="text-center space-y-2 z-10">
          <h2 className="text-xl font-serif text-primary-foreground">Descending...</h2>
          <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest animate-pulse">
            Proposing • Resolving • Narrating
          </p>
        </div>
      </div>
    );
  }

  const recs = getRecommendations.data;
  const llmRecs = recs.filter(r => r.arm === 'llm');
  const controlRecs = recs.filter(r => r.arm === 'well_trodden');
  
  // To show path rating, we need at least one rating submitted
  const [ratedCount, setRatedCount] = useState(0);

  return (
    <div className="p-6 pt-12 max-w-md mx-auto space-y-12 pb-32 animate-in fade-in duration-1000">
      <div className="space-y-2 text-center">
        <h1 className="text-xl font-serif text-primary-foreground">Today's Findings</h1>
        <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest">
          {llmRecs.length} discoveries waiting
        </p>
      </div>

      <div className="space-y-8">
        {llmRecs.map(rec => (
          <RecCard key={rec.id} rec={rec} userId={userId} onRated={() => setRatedCount(c => c + 1)} />
        ))}
      </div>

      {controlRecs.length > 0 && (
        <div className="pt-12 space-y-6">
          <div className="flex items-center gap-4">
            <div className="h-px bg-border flex-1" />
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">The Obvious Pick</span>
            <div className="h-px bg-border flex-1" />
          </div>
          {controlRecs.map(rec => (
            <RecCard key={rec.id} rec={rec} userId={userId} onRated={() => setRatedCount(c => c + 1)} />
          ))}
        </div>
      )}

      {ratedCount > 0 && (
        <PathRatingSection 
          userId={userId} 
          stepId={stepId} 
          onComplete={() => onNavigate(`/dive/${diveId}`)} 
        />
      )}
    </div>
  );
}

function RecCard({ rec, userId, onRated }: { rec: Recommendation, userId: number, onRated: () => void }) {
  const [links, setLinks] = useState(rec.linksJson);
  const [shouldFetchLinks, setShouldFetchLinks] = useState(false);
  
  const { data: fetchedLinks, isLoading: isResolvingLinks } = useResolveLinks(
    { mbid: rec.mbid, type: rec.type, title: rec.title, artist: rec.artist },
    { query: { 
      enabled: shouldFetchLinks && !links,
      queryKey: getResolveLinksQueryKey({ mbid: rec.mbid, type: rec.type, title: rec.title, artist: rec.artist })
    } }
  );
  
  useEffect(() => {
    if (fetchedLinks && !links) {
      setLinks(fetchedLinks);
    }
  }, [fetchedLinks, links]);
  
  const [listenState, setListenState] = useState<string | null>(rec.latestRating?.listenState || null);
  const [score, setScore] = useState<number | null>(rec.latestRating?.score || null);
  const rateRec = useRateRec();

  const handleResolveLinks = () => {
    if (links) return;
    setShouldFetchLinks(true);
  };

  const handleRate = (state: string, newScore: number | null) => {
    setListenState(state);
    setScore(newScore);
    rateRec.mutate(
      { data: { userId, recId: rec.id, listenState: state as any, score: newScore } },
      { onSuccess: () => onRated() }
    );
  };

  return (
    <div className="bg-secondary/20 rounded-3xl p-6 border border-primary/10 space-y-6 shadow-xl relative overflow-hidden group">
      {/* Background glow */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none" />

      <div>
        <h3 className="text-2xl font-serif text-primary-foreground leading-tight">{rec.title}</h3>
        <p className="text-sm font-medium text-primary mt-1">{rec.artist} {rec.year ? <span className="text-muted-foreground font-normal">· {rec.year}</span> : ''}</p>
      </div>

      {rec.narrativeText && (
        <p className="text-sm leading-relaxed text-primary-foreground/80 font-serif">
          {rec.narrativeText}
        </p>
      )}

      <div className="pt-2">
        {!links ? (
          <Button 
            onClick={handleResolveLinks} 
            variant="outline" 
            className="rounded-full h-10 border-primary/30 text-primary hover:bg-primary/10"
            disabled={isResolvingLinks}
          >
            {isResolvingLinks ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
            Find streams
          </Button>
        ) : (
          <div className="flex gap-3">
            {links.spotify && (
              <a href={links.spotify} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center w-12 h-12 rounded-full bg-[#1DB954]/10 text-[#1DB954] hover:bg-[#1DB954]/20 transition-colors">
                <SiSpotify className="w-5 h-5" />
              </a>
            )}
            {links.youtube && (
              <a href={links.youtube} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center w-12 h-12 rounded-full bg-[#FF0000]/10 text-[#FF0000] hover:bg-[#FF0000]/20 transition-colors">
                <SiYoutube className="w-5 h-5" />
              </a>
            )}
          </div>
        )}
      </div>

      <div className="pt-6 border-t border-border/50">
        <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-3">Feedback</p>
        <div className="flex gap-2 mb-4 bg-secondary/40 p-1 rounded-xl">
          {(['listened', 'skipped', 'known'] as const).map(state => (
            <button
              key={state}
              onClick={() => handleRate(state, score)}
              className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors capitalize ${
                listenState === state 
                  ? 'bg-primary text-primary-foreground shadow-sm' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
              }`}
            >
              {state}
            </button>
          ))}
        </div>

        {(listenState === 'listened' || listenState === 'known') && (
          <div className="flex items-center justify-between px-2 pt-2 animate-in slide-in-from-top-2">
            <span className="text-xs text-muted-foreground">Rating</span>
            <HalfStarRating score={score} onChange={(s) => handleRate(listenState, s)} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Half-star rating — supports 0.5 increments from 1.0 to 5.0 */
function HalfStarRating({
  score,
  onChange,
  size = 'sm',
}: {
  score: number | null;
  onChange: (s: number) => void;
  size?: 'sm' | 'lg';
}) {
  const iconClass = size === 'lg' ? 'w-8 h-8' : 'w-6 h-6';
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Star rating">
      {[1, 2, 3, 4, 5].map((star) => {
        const half = star - 0.5;
        const filledFull = score !== null && score >= star;
        const filledHalf = score !== null && score >= half && score < star;
        return (
          <div key={star} className="relative" style={{ width: size === 'lg' ? 32 : 24, height: size === 'lg' ? 32 : 24 }}>
            {/* Base empty star */}
            <Star className={`${iconClass} text-muted-foreground/30 absolute inset-0`} />
            {/* Half-fill overlay */}
            {filledHalf && (
              <div className="absolute inset-0 overflow-hidden" style={{ width: '50%' }}>
                <Star className={`${iconClass} fill-primary text-primary`} />
              </div>
            )}
            {/* Full-fill overlay */}
            {filledFull && (
              <Star className={`${iconClass} fill-primary text-primary absolute inset-0`} />
            )}
            {/* Left click = half star (minimum 1.0, so star-1 left half also gives 1.0) */}
            <button
              data-testid={`rate-${Math.max(half, 1.0)}`}
              className="absolute inset-y-0 left-0 w-1/2 cursor-pointer"
              onClick={() => onChange(Math.max(half, 1.0))}
              aria-label={`${Math.max(half, 1.0)} stars`}
            />
            {/* Right click = full star */}
            <button
              data-testid={`rate-${star}`}
              className="absolute inset-y-0 right-0 w-1/2 cursor-pointer"
              onClick={() => onChange(star)}
              aria-label={`${star} stars`}
            />
          </div>
        );
      })}
      {score !== null && (
        <span className="text-xs text-muted-foreground ml-2">{score}/5</span>
      )}
    </div>
  );
}

function PathRatingSection({ userId, stepId, onComplete }: { userId: number, stepId: number, onComplete: () => void }) {
  const [score, setScore] = useState<number | null>(null);
  const rateStep = useRateStep();

  const handleRate = (s: number) => {
    setScore(s);
    rateStep.mutate({ data: { userId, diveStepId: stepId, score: s } });
  };

  return (
    <div className="pt-12 mt-12 border-t border-border animate-in fade-in zoom-in-95 duration-700">
      <div className="text-center space-y-6">
        <h3 className="text-lg font-serif text-primary-foreground">How good was this direction?</h3>
        
        <div className="flex justify-center">
          <HalfStarRating score={score} onChange={handleRate} size="lg" />
        </div>

        {rateStep.isError && (
          <p className="text-xs text-destructive text-center">Rating failed to save — please try again.</p>
        )}
        <Button
          onClick={onComplete}
          disabled={!rateStep.isSuccess || rateStep.isPending}
          className="w-full h-14 rounded-full bg-primary text-primary-foreground text-lg shadow-[0_0_20px_hsla(180,80%,40%,0.2)] mt-8"
        >
          {rateStep.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : "Continue dive"}
        </Button>
      </div>
    </div>
  );
}
