import { useState } from 'react';
import { useLocation } from 'wouter';
import { useCreateUser, useGetState, useCreateDive, getGetStateQueryKey } from '@workspace/api-client-react';
import { getUserId, setUserId } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2 } from 'lucide-react';

export default function HomePage() {
  const [location, setLocation] = useLocation();
  const userId = getUserId();
  
  if (!userId) {
    return <NameGate onLogin={() => setLocation('/onboard')} />;
  }

  return <HomeContent userId={userId} onNavigate={setLocation} />;
}

function NameGate({ onLogin }: { onLogin: () => void }) {
  const [name, setName] = useState('');
  const createUser = useCreateUser();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createUser.mutate({ data: { name } }, {
      onSuccess: (user) => {
        setUserId(user.id, user.name);
        onLogin();
      }
    });
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 min-h-screen">
      <div className="w-full max-w-sm space-y-8 text-center animate-in fade-in slide-in-from-bottom-4 duration-1000">
        <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center mx-auto mb-8 animate-sonar">
          <div className="w-4 h-4 rounded-full bg-primary" />
        </div>
        <h1 className="text-3xl font-serif text-primary-foreground tracking-tight">Magical Musical Submarine</h1>
        <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">A private journal for your ears</p>
        
        <form onSubmit={handleSubmit} className="mt-12 space-y-4">
          <Input 
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What's your name?"
            className="text-center bg-transparent border-t-0 border-l-0 border-r-0 border-b-2 border-primary/30 rounded-none focus-visible:ring-0 focus-visible:border-primary text-xl h-14 placeholder:text-muted-foreground/50"
            disabled={createUser.isPending}
          />
          <Button 
            type="submit" 
            className="w-full h-12 bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 rounded-full transition-all"
            disabled={!name.trim() || createUser.isPending}
          >
            {createUser.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : "Descend"}
          </Button>
        </form>
      </div>
    </div>
  );
}

function HomeContent({ userId, onNavigate }: { userId: number, onNavigate: (path: string) => void }) {
  const { data: state, isLoading } = useGetState({ userId }, { query: { enabled: !!userId, queryKey: getGetStateQueryKey({ userId }) } });
  const createDive = useCreateDive();

  if (isLoading || !state) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (!state.onboarded) {
    // Need to use timeout to avoid setting state while rendering
    setTimeout(() => onNavigate('/onboard'), 0);
    return null;
  }

  const handleNewDive = () => {
    createDive.mutate(
      { data: { userId, name: `Dive ${state.diveCount + 1}` } },
      { onSuccess: (dive) => onNavigate(`/dive/${dive.id}`) }
    );
  };

  return (
    <div className="p-6 pt-16 max-w-md mx-auto space-y-10 animate-in fade-in duration-1000">
      <div className="space-y-4">
        <h2 className="text-sm font-mono text-muted-foreground uppercase tracking-widest">Your Depth</h2>
        {state.portraitText ? (
          <p className="text-xl font-serif leading-relaxed text-primary-foreground/90">
            {state.portraitText.substring(0, 120)}...
          </p>
        ) : (
          <p className="text-xl font-serif text-muted-foreground italic">Your portrait is still forming...</p>
        )}
      </div>

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
          {createDive.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : "Start new dive"}
        </Button>
      </div>
    </div>
  );
}
