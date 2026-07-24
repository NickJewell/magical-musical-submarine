import { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { useClerk } from '@clerk/react';
import { 
  useSearchMusic, useAddSeed, useListSeeds, 
  useGetNextPair,
  useGeneratePortrait, useUpdatePortrait, useCreateDive,
  getListSeedsQueryKey, getSearchMusicQueryKey, getGetNextPairQueryKey,
  type SearchResult,
} from '@workspace/api-client-react';
import { useLocalUser } from '@/lib/useLocalUser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Search, Plus, ChevronDown } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { PairwiseSlider } from '@/components/PairwiseSlider';

interface PromptCategory {
  category: string;
  prompts: string[];
  isNegative?: boolean;
}

const PROMPT_CATEGORIES: PromptCategory[] = [
  {
    category: "Memory & autobiography",
    prompts: [
      "A song from a home you no longer live in.",
      "The first song you remember loving before you knew what music was.",
      "A song a parent or grandparent played that's now yours.",
      "A song that plays in a memory you can't fully explain.",
      "The song of a specific summer — you can smell it.",
      "A song from a bedroom you spent too much time in.",
      "A song tied to a meal, a kitchen, a smell of cooking.",
      "A song you associate with being very young and very bored.",
      "The song from the best night you can barely remember.",
      "A song that instantly makes you a teenager again.",
    ],
  },
  {
    category: "Place & motion",
    prompts: [
      "A song that is a particular city or town to you.",
      "What you'd play driving somewhere at night, alone.",
      "A song for a long train or plane window.",
      "The song of a specific walk you've done a hundred times.",
      "A song that sounds like a place you've never been but want to go.",
      "Music tied to water — a coast, a lake, rain.",
      "A song you'd want playing the moment you arrive somewhere new.",
      "A song that belongs to a road trip.",
    ],
  },
  {
    category: "People & love",
    prompts: [
      "A song that is entirely one person.",
      "The song from the start of a relationship.",
      "The song from the end of one.",
      "A song you'd never admit reminds you of someone.",
      "A song you'd put on to feel close to someone far away.",
      "A song a friend gave you that stuck.",
      "A song you associate with a group of people, not one.",
      "The song you'd want at your wedding — or refuse to have.",
      "A song about someone you've forgiven.",
      "A song you can't hear without thinking of someone gone.",
    ],
  },
  {
    category: "Mood regulation",
    prompts: [
      "What you play when you need to feel something.",
      "What you put on when you're already sad and want to stay there.",
      "A song that reliably lifts a bad mood.",
      "What you reach for when you're anxious.",
      "A song that's pure comfort, like a blanket.",
      "A song you use to get angry on purpose.",
      "What you play to feel calm and in control.",
      "A song that helps you cry when you need to.",
    ],
  },
  {
    category: "Function & ritual",
    prompts: [
      "What you play to focus and disappear into work.",
      "Your cleaning-the-house song.",
      "What's on when you cook.",
      "Your going-out, getting-ready song.",
      "What you'd run to when you want to push harder.",
      "A song for winding down before sleep.",
      "What you play first thing in the morning.",
      "A song that's basically a productivity cheat code for you.",
    ],
  },
  {
    category: "Identity & self-image",
    prompts: [
      "A song that feels like your personality in three minutes.",
      "The song you'd use to explain yourself to a stranger.",
      "Something you loved at 15 and still defend.",
      "A song that made you feel understood for the first time.",
      "A song that changed how you thought about music.",
      "A song you feel cooler for loving.",
      "A song that feels like the person you're becoming.",
      "A song you'd want on your funeral playlist.",
    ],
  },
  {
    category: "Shadow & guilty pleasure",
    prompts: [
      "Something embarrassing you'd defend to the death.",
      "A song you love but would turn down if someone walked in.",
      "A song you hated at first and now adore.",
      "A song you loved, then got sick of, then loved again.",
      "A song that's objectively bad and you don't care.",
      "A guilty-pleasure genre in one track.",
      "A song you'd never put on a playlist for anyone else.",
      "A song you're slightly ashamed of how much you've played.",
    ],
  },
  {
    category: "Body & sensation",
    prompts: [
      "A song that gives you chills every single time.",
      "A song you cannot physically sit still to.",
      "A song that makes the back of your neck prickle.",
      "The song that makes you turn the volume up.",
      "A song that hits you in the chest.",
      "A song you'd want played loud, on a real system.",
      "A song with a moment — a drop, a key change, a note — you wait for.",
      "A song that feels physical, almost too much.",
    ],
  },
  {
    category: "Time & era",
    prompts: [
      "A decade you feel homesick for, in one song.",
      "A song that sounds like autumn.",
      "A song that sounds like 2am.",
      "A song from before you were born that feels like yours.",
      "A song that was everywhere once and you still love.",
      "A song that sounds like the future used to sound.",
      "A song tied to a specific age you were.",
      "A song that feels like a Sunday.",
    ],
  },
  {
    category: "Aspiration & fantasy",
    prompts: [
      "A song you wish you'd written.",
      "The song playing in the movie of your life's best scene.",
      "A song you'd want to be able to play or sing.",
      "A song that makes you feel capable of anything.",
      "A song for a version of you that's braver.",
      "A song you'd score a triumphant moment with.",
      "A song that makes you want to be somewhere else entirely.",
    ],
  },
  {
    category: "Negative space",
    isNegative: true,
    prompts: [
      "A song you always skip — what is it about it?",
      "A hugely loved song you just don't get.",
      "A song ruined for you by overplay or association.",
      "A genre you actively steer away from, named by one track.",
      "A song you used to love that you can't listen to anymore.",
      "An artist everyone loves that leaves you cold.",
    ],
  },
  {
    category: "Meaning & depth",
    prompts: [
      "A song whose lyrics you'd frame on a wall.",
      "A song that says something you couldn't say yourself.",
      "The most honest song you know.",
      "A song that feels spiritual to you, religious or not.",
      "A song that asks a question you keep thinking about.",
      "A song that made you see something differently.",
      "A song that feels like it knows a secret about being alive.",
    ],
  },
  {
    category: "Social & inherited",
    prompts: [
      "A song that only makes sense in a crowd.",
      "A song you inherited from someone and never gave back.",
      "A song that's an inside joke with someone.",
      "A song you'd play to test if you'd get along with someone.",
      "The song that got you into a whole scene or genre.",
    ],
  },
];

// Pre-shuffle categories and pick one random prompt per category — called once per session
function buildPromptSequence() {
  const shuffledCats = [...PROMPT_CATEGORIES].sort(() => Math.random() - 0.5);
  return shuffledCats.map((cat) => ({
    category: cat.category,
    isNegative: cat.isNegative ?? false,
    prompt: cat.prompts[Math.floor(Math.random() * cat.prompts.length)],
  }));
}

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

export default function OnboardPage() {
  const [, setLocation] = useLocation();
  const { localUserId: userId, isLoading } = useLocalUser();
  const { signOut } = useClerk();
  const [phase, setPhase] = useState<1 | 2 | 3>(1);

  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center min-h-screen">
      <Loader2 className="w-8 h-8 text-primary animate-spin" />
    </div>
  );
  if (!userId) {
    setTimeout(() => setLocation('/'), 0);
    return null;
  }

  return (
    <div className="min-h-screen flex flex-col p-6 pt-6 max-w-md mx-auto">
      {/* Top bar with sign-out */}
      <div className="flex justify-end mb-6">
        <button
          onClick={() => signOut({ redirectUrl: basePath || '/' })}
          className="rounded-full bg-slate-600 hover:bg-slate-500 text-white text-xs font-mono uppercase tracking-widest px-4 py-2 transition-colors"
        >
          Sign out
        </button>
      </div>
      {phase === 1 && <Phase1Seeding userId={userId} onComplete={() => setPhase(2)} />}
      {phase === 2 && <Phase2Pairwise userId={userId} onComplete={() => setPhase(3)} />}
      {phase === 3 && <Phase3Portrait userId={userId} onComplete={(diveId) => setLocation(`/dive/${diveId}`)} />}
    </div>
  );
}

function Phase1Seeding({ userId, onComplete }: { userId: number, onComplete: () => void }) {
  const queryClient = useQueryClient();
  const { data: seeds } = useListSeeds({ userId }, { query: { enabled: !!userId, queryKey: getListSeedsQueryKey({ userId }) } });
  const [sequence] = useState(buildPromptSequence);
  const [seqIdx, setSeqIdx] = useState(0);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [allResults, setAllResults] = useState<SearchResult[]>([]);
  const prevQueryRef = useRef('');

  // Debounce + reset pagination whenever query changes
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
      if (query !== prevQueryRef.current) {
        setPage(1);
        setAllResults([]);
        prevQueryRef.current = query;
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const { data: pageResults, isLoading: isSearching, isFetching } = useSearchMusic(
    { userId, q: debouncedQuery, type: 'track', page },
    { query: { enabled: debouncedQuery.length > 2, queryKey: getSearchMusicQueryKey({ userId, q: debouncedQuery, type: 'track', page }) } }
  );

  // Append new page results; replace on page 1 (fresh query)
  useEffect(() => {
    if (!pageResults) return;
    setAllResults(prev => page === 1 ? pageResults : [...prev, ...pageResults]);
  }, [pageResults]); // eslint-disable-line react-hooks/exhaustive-deps

  const addSeed = useAddSeed();

  const currentEntry = sequence[seqIdx % sequence.length];

  const handleAddSeed = (mbid: string, title: string, artist: string, year: number | null) => {
    addSeed.mutate({
      data: { userId, mbid, type: 'track', title, artist, year, prompt: currentEntry.prompt }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSeedsQueryKey({ userId }) });
        setQuery('');
        setAllResults([]);
        setPage(1);
        setSeqIdx((i) => i + 1);
      }
    });
  };

  const seedCount = seeds?.length || 0;
  const canProceed = seedCount >= 5;
  const hasResults = allResults.length > 0;
  const canLoadMore = !!pageResults && pageResults.length === 10 && !isFetching;

  return (
    <div className="flex-1 flex flex-col animate-in fade-in duration-700">
      {/* Seed count indicator — no chip bubbles */}
      {seedCount > 0 && (
        <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-widest text-center mb-4">
          {seedCount} {seedCount === 1 ? 'track' : 'tracks'} added
          {canProceed ? ' · ready to continue' : ` · ${5 - seedCount} more to go`}
        </p>
      )}

      <div className="flex-1 flex flex-col justify-center">
        {/* Category label */}
        <div className="flex items-center justify-center gap-2 mb-3">
          {currentEntry.isNegative ? (
            <span className="text-[10px] font-mono uppercase tracking-widest px-2.5 py-0.5 rounded-full border border-amber-500/40 text-amber-400/80 bg-amber-500/5">
              what you avoid
            </span>
          ) : (
            <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-widest">
              {currentEntry.category}
            </span>
          )}
        </div>

        <h2 className="text-2xl font-bold text-foreground mb-6 text-center leading-snug">
          {currentEntry.prompt}
        </h2>

        <div className="relative mb-4">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground w-5 h-5" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for a track..."
            className="pl-12 h-14 rounded-full bg-secondary/20 border-primary/20 focus-visible:border-primary text-lg"
          />
        </div>

        <div className="flex-1 overflow-y-auto min-h-[200px] space-y-1.5">
          {/* Initial load spinner */}
          {isSearching && allResults.length === 0 && (
            <div className="text-center p-4">
              <Loader2 className="w-5 h-5 animate-spin mx-auto text-primary" />
            </div>
          )}

          {/* Result rows */}
          {hasResults && allResults.map((r) => (
            <button
              key={`${r.mbid}-${r.title}`}
              onClick={() => handleAddSeed(r.mbid, r.title, r.artist, r.year)}
              disabled={addSeed.isPending}
              className="w-full text-left p-4 rounded-xl bg-secondary/20 hover:bg-secondary/50 active:bg-secondary/70 transition-colors flex items-center gap-4 border border-border/30 hover:border-primary/40 group"
            >
              <div className="flex-1 min-w-0 space-y-0.5">
                <p className="font-semibold text-base text-foreground truncate leading-tight">{r.title}</p>
                <p className="text-sm font-medium text-primary/90 truncate">{r.artist}</p>
                {r.release && <p className="text-xs text-muted-foreground truncate">{r.release}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {r.year && (
                  <span className="text-xs font-mono text-muted-foreground bg-secondary/60 px-2 py-0.5 rounded-full border border-border/50">
                    {r.year}
                  </span>
                )}
                <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center group-hover:bg-primary/30 transition-colors">
                  <Plus className="w-3.5 h-3.5 text-primary" />
                </div>
              </div>
            </button>
          ))}

          {/* Load more */}
          {hasResults && (
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={!canLoadMore}
              className="w-full py-3 flex items-center justify-center gap-2 text-xs font-mono text-muted-foreground hover:text-primary transition-colors disabled:opacity-40"
            >
              {isFetching
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <ChevronDown className="w-3.5 h-3.5" />}
              {isFetching ? 'Loading…' : 'Load more results'}
            </button>
          )}
        </div>
      </div>

      <div className="pt-6 mt-auto space-y-3">
        {canProceed && (
          <p className="text-center text-xs font-mono text-primary/70 uppercase tracking-widest animate-pulse">
            Ready — tap below to build your taste portrait
          </p>
        )}
        <Button
          onClick={onComplete}
          disabled={!canProceed}
          className={`w-full h-14 rounded-full text-lg transition-all duration-300 ${
            canProceed
              ? 'bg-primary text-primary-foreground shadow-[0_0_24px_hsla(180,80%,40%,0.35)] hover:shadow-[0_0_32px_hsla(180,80%,40%,0.5)]'
              : 'bg-secondary/40 text-muted-foreground cursor-not-allowed'
          }`}
        >
          {canProceed ? 'Build my taste portrait →' : `Add ${5 - seedCount} more track${5 - seedCount === 1 ? '' : 's'} to continue`}
        </Button>
      </div>
    </div>
  );
}

function Phase2Pairwise({ userId, onComplete }: { userId: number, onComplete: () => void }) {
  const queryClient = useQueryClient();
  const { data: pair, isLoading } = useGetNextPair({ userId }, { query: { enabled: !!userId, queryKey: getGetNextPairQueryKey({ userId }) } });

  useEffect(() => {
    if (pair?.done) onComplete();
  }, [pair, onComplete]);

  if (isLoading || !pair) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="w-8 h-8 text-primary animate-spin" /></div>;
  }
  if (pair.done) return null;

  return (
    <div className="flex-1 flex flex-col justify-center animate-in fade-in duration-700">
      <PairwiseSlider
        userId={userId}
        aMbid={pair.aMbid!}
        aTitle={pair.aTitle!}
        aArtist={pair.aArtist!}
        bMbid={pair.bMbid!}
        bTitle={pair.bTitle!}
        bArtist={pair.bArtist!}
        onDone={() => queryClient.invalidateQueries({ queryKey: getGetNextPairQueryKey({ userId }) })}
      />
      {pair.pairIndex != null && pair.totalPairs != null && (
        <p className="mt-6 text-xs font-mono text-muted-foreground/50 text-center">
          Pair {pair.pairIndex + 1} of {pair.totalPairs}
        </p>
      )}
    </div>
  );
}

function Phase3Portrait({ userId, onComplete }: { userId: number, onComplete: (diveId: number) => void }) {
  const [text, setText] = useState('');
  const [isGenerated, setIsGenerated] = useState(false);
  
  const generatePortrait = useGeneratePortrait();
  const updatePortrait = useUpdatePortrait();
  const createDive = useCreateDive();

  useEffect(() => {
    generatePortrait.mutate(
      { data: { userId } },
      { onSuccess: (portrait) => {
        setText(portrait.text);
        setIsGenerated(true);
      }}
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const handleFinish = async () => {
    if (text !== generatePortrait.data?.text) {
      await updatePortrait.mutateAsync({ data: { userId, text } });
    }
    createDive.mutate(
      { data: { userId, name: 'First Dive' } },
      { onSuccess: (dive) => onComplete(dive.id) }
    );
  };

  if (!isGenerated) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center space-y-6">
        <div className="w-16 h-16 rounded-full border border-primary/30 flex items-center justify-center animate-float">
          <Loader2 className="w-6 h-6 text-primary animate-spin" />
        </div>
        <p className="font-serif text-xl text-primary-foreground">Analyzing currents...</p>
        <p className="text-sm font-mono text-muted-foreground uppercase tracking-widest">Drafting your portrait</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col animate-in fade-in zoom-in-95 duration-1000">
      <h2 className="text-sm font-mono text-muted-foreground uppercase tracking-widest mb-6 text-center">
        Your Portrait
      </h2>
      
      <div className="flex-1 relative">
        <Textarea 
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-full min-h-[400px] bg-secondary/10 border-primary/20 rounded-2xl p-6 font-serif text-lg leading-relaxed text-primary-foreground/90 resize-none focus-visible:ring-primary/50"
        />
      </div>

      <div className="pt-8 pb-4">
        <Button 
          onClick={handleFinish}
          disabled={createDive.isPending || updatePortrait.isPending}
          className="w-full h-14 rounded-full bg-primary text-primary-foreground text-lg shadow-[0_0_20px_hsla(180,80%,40%,0.2)] hover:shadow-[0_0_30px_hsla(180,80%,40%,0.4)] transition-all"
        >
          {createDive.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : "Begin first dive"}
        </Button>
      </div>
    </div>
  );
}
