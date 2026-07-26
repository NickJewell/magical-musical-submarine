import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useUser, useClerk, Show } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetState, useCreateDive, useGetTastePair,
  useGetPortrait, useUpdatePortrait, useGeneratePortrait,
  getGetStateQueryKey, getGetPortraitQueryKey, getGetTastePairQueryKey,
  type AppState,
} from '@workspace/api-client-react';
import { useLocalUser } from '@/lib/useLocalUser';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, RefreshCw, Check, Pencil } from 'lucide-react';
import { InlineDiveRename } from '@/components/InlineDiveRename';
import { PairwiseSlider } from '@/components/PairwiseSlider';
import { DiscoverCard } from '@/components/DiscoverCard';
import { useToast } from '@/hooks/use-toast';

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
            className="w-full h-12 bg-primary text-primary-foreground hover:bg-primary/90 rounded-full font-semibold"
          >
            <a href={`${basePath}/sign-up`}>Create account</a>
          </Button>
          <Button
            asChild
            className="w-full h-12 rounded-full bg-slate-600 hover:bg-slate-500 text-white font-semibold"
          >
            <a href={`${basePath}/sign-in`}>Sign in</a>
          </Button>
        </div>
      </div>
    </div>
  );
}

function SignedInHome({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { localUserId, isLoading, isError } = useLocalUser();

  if (isError) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-screen">
        <div className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">Couldn't reach the server.</p>
          <button
            onClick={() => window.location.reload()}
            className="text-xs font-mono text-primary/70 hover:text-primary uppercase tracking-widest"
          >
            Tap to retry
          </button>
        </div>
      </div>
    );
  }

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
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Tab state
  const [activeTab, setActiveTab] = useState<'dive' | 'portrait'>('dive');

  // Dive state
  const [showPairwise] = useState(() => Math.random() < 0.5);
  const [pairwiseDone, setPairwiseDone] = useState(false);

  const { data: state, isLoading } = useGetState(
    { userId },
    { query: { enabled: !!userId, queryKey: getGetStateQueryKey({ userId }) } },
  );
  const createDive = useCreateDive();
  const { data: tastePair } = useGetTastePair(
    { userId },
    { query: { enabled: showPairwise && !pairwiseDone && !!userId && !!state?.onboarded, queryKey: getGetTastePairQueryKey({ userId }) } }
  );

  // Portrait state
  const { data: portrait, isLoading: portraitLoading } = useGetPortrait(
    { userId },
    { query: { enabled: !!userId, queryKey: getGetPortraitQueryKey({ userId }) } }
  );
  const [portraitDraft, setPortraitDraft] = useState('');
  const [isEditingPortrait, setIsEditingPortrait] = useState(false);
  const updatePortrait = useUpdatePortrait();
  const generatePortrait = useGeneratePortrait();

  useEffect(() => {
    if (portrait && !isEditingPortrait) {
      setPortraitDraft(portrait.text);
    }
  }, [portrait, isEditingPortrait]);

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

  const handleSavePortrait = () => {
    if (portraitDraft === portrait?.text) { setIsEditingPortrait(false); return; }
    updatePortrait.mutate(
      { data: { userId, text: portraitDraft } },
      {
        onSuccess: (updated) => {
          queryClient.setQueryData(getGetPortraitQueryKey({ userId }), updated);
          setIsEditingPortrait(false);
          toast({ title: 'Portrait updated', description: 'Your edits have been saved.' });
        }
      }
    );
  };

  const handleRegeneratePortrait = () => {
    generatePortrait.mutate(
      { data: { userId } },
      {
        onSuccess: (updated) => {
          queryClient.setQueryData(getGetPortraitQueryKey({ userId }), updated);
          setPortraitDraft(updated.text);
          setIsEditingPortrait(false);
          toast({ title: 'Portrait regenerated', description: 'A new interpretation has been formed.' });
        }
      }
    );
  };

  const activePair = showPairwise && !pairwiseDone && tastePair && !tastePair.done;

  return (
    <div className="p-6 pt-10 max-w-md mx-auto min-h-screen animate-in fade-in duration-1000 overflow-x-hidden">

      {/* User bar */}
      <div className="flex items-center justify-between mb-6">
        <span className="text-xs font-mono text-muted-foreground uppercase tracking-widest">
          {user?.firstName ?? user?.emailAddresses[0]?.emailAddress?.split('@')[0] ?? 'Diver'}
        </span>
        <button
          onClick={() => signOut({ redirectUrl: basePath || '/' })}
          className="rounded-full bg-slate-600 hover:bg-slate-500 text-white text-xs font-mono uppercase tracking-widest px-4 py-1.5 transition-colors"
        >
          Sign out
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 p-1 bg-secondary/30 rounded-full mb-8">
        {(['dive', 'portrait'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 rounded-full py-2 text-xs font-mono uppercase tracking-widest transition-all duration-200 ${
              activeTab === tab
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-primary-foreground'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* ── Dive tab ── */}
      {activeTab === 'dive' && (
        <div className="space-y-6 animate-in fade-in duration-300">

          {/* Discover & rank — a fast rate-to-rank feed */}
          <DiscoverCard userId={userId} />

          {/* Pairwise taste check */}
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

          <Button
            onClick={handleNewDive}
            variant="outline"
            className="w-full border-primary/30 text-primary hover:bg-primary/10 rounded-full h-12"
            disabled={createDive.isPending}
          >
            {createDive.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Start new dive'}
          </Button>
        </div>
      )}

      {/* ── Portrait tab ── */}
      {activeTab === 'portrait' && (
        <div className="space-y-6 animate-in fade-in duration-300 pb-24">

          {portraitLoading && (
            <div className="flex justify-center pt-12">
              <Loader2 className="w-6 h-6 text-primary animate-spin" />
            </div>
          )}

          {!portraitLoading && !portrait && (
            <p className="text-center font-serif text-muted-foreground italic pt-8">
              Your portrait is still forming — complete a dive to generate one.
            </p>
          )}

          {portrait && (
            <>
              {/* Metadata */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-widest">
                  v{portrait.version} · {portrait.source === 'llm' ? 'LLM generated' : 'Edited by you'}
                </span>
                {!isEditingPortrait && (
                  <button
                    onClick={() => setIsEditingPortrait(true)}
                    className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/60 hover:text-primary transition-colors uppercase tracking-widest"
                  >
                    <Pencil className="w-3 h-3" />
                    Edit
                  </button>
                )}
              </div>

              {/* Portrait body */}
              {isEditingPortrait ? (
                <Textarea
                  value={portraitDraft}
                  onChange={(e) => setPortraitDraft(e.target.value)}
                  className="min-h-[55dvh] bg-secondary/10 border-primary/20 rounded-2xl p-6 font-serif text-base leading-relaxed text-primary-foreground/90 resize-none focus-visible:ring-primary/50"
                  autoFocus
                />
              ) : (
                <div className="font-serif text-lg leading-[1.75] text-primary-foreground/90 whitespace-pre-wrap">
                  {portrait.text}
                </div>
              )}

              {/* Actions */}
              <div className="space-y-3 pt-2">
                {isEditingPortrait && (
                  <div className="flex gap-2">
                    <Button
                      onClick={handleSavePortrait}
                      disabled={updatePortrait.isPending}
                      className="flex-1 h-11 rounded-xl bg-primary text-primary-foreground"
                    >
                      {updatePortrait.isPending
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : <><Check className="w-4 h-4 mr-2" />Save edits</>}
                    </Button>
                    <Button
                      onClick={() => { setPortraitDraft(portrait.text); setIsEditingPortrait(false); }}
                      variant="ghost"
                      className="h-11 px-4 rounded-xl text-muted-foreground"
                    >
                      Cancel
                    </Button>
                  </div>
                )}

                <Button
                  onClick={handleRegeneratePortrait}
                  disabled={generatePortrait.isPending || updatePortrait.isPending}
                  variant="outline"
                  className="w-full h-11 rounded-xl border-border/50 hover:bg-secondary/50 text-muted-foreground text-sm"
                >
                  {generatePortrait.isPending
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating…</>
                    : <><RefreshCw className="w-4 h-4 mr-2" />Regenerate from latest taste data</>}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
