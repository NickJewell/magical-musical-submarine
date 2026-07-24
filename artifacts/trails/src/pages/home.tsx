import { useState } from 'react';
import { useLocation } from 'wouter';
import { useUser, useClerk, Show } from '@clerk/react';
import { useGetState, useCreateDive, useGetTastePair, getGetStateQueryKey } from '@workspace/api-client-react';
import { useLocalUser } from '@/lib/useLocalUser';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { PairwiseSlider } from '@/components/PairwiseSlider';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

export default function HomePage() {
  const [, setLocation] = useLocation();
  const { isLoaded } = useUser();

  if (!isLoaded) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <>
      <Show when="signed-out">
        <Landing />
      </Show>
      <Show when="signed-in">
        <SignedInHome onNavigate={setLocation} />
      </Show>
    </>
  );
}

function Landing() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 min-h-screen">
      <div className="w-full max-w-sm space-y-8 text-center animate-in fade-in slide-in-from-bottom-4 duration-1000">
        <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center mx-auto mb-8 animate-sonar">
          <div className="w-4 h-4 rounded-full bg-primary" />
        </div>
        <h1 className="text-3xl font-serif text-primary-foreground tracking-tight">
          Magical Musical Submarine
        </h1>
        <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
          A private journal for your ears
        </p>
        <div className="mt-12 space-y-3">
          <Button
            asChild
            className="w-full h-12 bg-primary text-primary-foreground hover:bg-primary/90 rounded-full"
          >
            <a href={`${basePath}/sign-up`}>Begin your descent</a>
          </Button>
          <Button
            asChild
            variant="ghost"
            className="w-full h-12 text-muted-foreground hover:text-primary rounded-full"
          >
            <a href={`${basePath}/sign-in`}>Sign in</a>
          </Button>
        </div>
      </div>
    </div>
  );
}

function SignedInHome({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { localUserId, isLoading } = useLocalUser();

  if (isLoading || !localUserId) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-screen">
        <div className="space-y-4 text-center">
          <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
          <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest">
            Preparing your submarine…
          </p>
        </div>
      </div>
    );
  }

  return <HomeContent userId={localUserId} onNavigate={onNavigate} />;
}

function HomeContent({ userId, onNavigate }: { userId: number; onNavigate: (path: string) => void }) {
  const { signOut } = useClerk();
  const { user } = useUser();
  const [showPairwise] = useState(() => Math.random() < 0.5);
  const [pairwiseDone, setPairwiseDone] = useState(false);

  const { data: state, isLoading } = useGetState(
    { userId },
    { query: { enabled: !!userId, queryKey: getGetStateQueryKey({ userId }) } },
  );
  const createDive = useCreateDive();
  const { data: tastePair } = useGetTastePair(
    { userId },
    { query: { enabled: showPairwise && !pairwiseDone && !!userId && !!state?.onboarded } }
  );

  if (isLoading || !state) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (!state.onboarded) {
    setTimeout(() => onNavigate('/onboard'), 0);
    return null;
  }

  const handleNewDive = () => {
    createDive.mutate(
      { data: { userId, name: `Dive ${state.diveCount + 1}` } },
      { onSuccess: (dive) => onNavigate(`/dive/${dive.id}`) },
    );
  };

  const activePair = showPairwise && !pairwiseDone && tastePair && !tastePair.done;

  return (
    <div className="p-6 pt-16 max-w-md mx-auto space-y-10 animate-in fade-in duration-1000">
      {/* User bar */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-muted-foreground uppercase tracking-widest">
          {user?.firstName ?? user?.emailAddresses[0]?.emailAddress?.split('@')[0] ?? 'Diver'}
        </span>
        <button
          onClick={() => signOut({ redirectUrl: basePath || '/' })}
          className="text-xs font-mono text-muted-foreground/60 hover:text-muted-foreground transition-colors uppercase tracking-widest"
        >
          Surface
        </button>
      </div>

      <div className="space-y-4">
        <h2 className="text-sm font-mono text-muted-foreground uppercase tracking-widest">Your Depth</h2>
        {state.portraitText ? (
          <p className="text-xl font-serif leading-relaxed text-primary-foreground/90">
            {state.portraitText.substring(0, 120)}…
          </p>
        ) : (
          <p className="text-xl font-serif text-muted-foreground italic">Your portrait is still forming…</p>
        )}
      </div>

      {/* Pairwise taste check — shown on ~50% of logins when enough history exists */}
      {activePair && (
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
      )}

      {state.activeDiveId && (
        <div className="space-y-4 p-6 rounded-2xl bg-secondary/40 border border-border/50">
          <h3 className="text-sm font-mono text-primary uppercase tracking-widest flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            Active Dive
          </h3>
          <p className="text-lg font-medium">{state.activeDiveName}</p>
          <Button
            onClick={() => onNavigate(`/dive/${state.activeDiveId}`)}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 rounded-full h-12 mt-4"
          >
            Continue dive
          </Button>
        </div>
      )}

      <div>
        <Button
          onClick={handleNewDive}
          variant="outline"
          className="w-full border-primary/30 text-primary hover:bg-primary/10 rounded-full h-12"
          disabled={createDive.isPending}
        >
          {createDive.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Start new dive'}
        </Button>
      </div>
    </div>
  );
}
