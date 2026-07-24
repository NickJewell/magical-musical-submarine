import { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
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

const PROMPTS = [
  "A song you put on to focus",
  "Something you loved at 15 and still defend",
  "What plays when you're driving alone at night",
  "A track that feels like deep water",
  "Your personal anthem right now"
];

export default function OnboardPage() {
  const [, setLocation] = useLocation();
  const { localUserId: userId, isLoading } = useLocalUser();
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
    <div className="min-h-screen flex flex-col p-6 pt-12 max-w-md mx-auto">
      {phase === 1 && <Phase1Seeding userId={userId} onComplete={() => setPhase(2)} />}
      {phase === 2 && <Phase2Pairwise userId={userId} onComplete={() => setPhase(3)} />}
      {phase === 3 && <Phase3Portrait userId={userId} onComplete={(diveId) => setLocation(`/dive/${diveId}`)} />}
    </div>
  );
}

function Phase1Seeding({ userId, onComplete }: { userId: number, onComplete: () => void }) {
  const queryClient = useQueryClient();
  const { data: seeds } = useListSeeds({ userId }, { query: { enabled: !!userId, queryKey: getListSeedsQueryKey({ userId }) } });
  const [promptIdx, setPromptIdx] = useState(0);
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

  const handleAddSeed = (mbid: string, title: string, artist: string, year: number | null) => {
    addSeed.mutate({
      data: { userId, mbid, type: 'track', title, artist, year, prompt: PROMPTS[promptIdx] }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSeedsQueryKey({ userId }) });
        setQuery('');
        setAllResults([]);
        setPage(1);
        setPromptIdx((i) => (i + 1) % PROMPTS.length);
      }
    });
  };

  const seedCount = seeds?.length || 0;
  const canProceed = seedCount >= 5;
  const hasResults = allResults.length > 0;
  const canLoadMore = !!pageResults && pageResults.length === 10 && !isFetching;

  return (
    <div className="flex-1 flex flex-col animate-in fade-in duration-700">
      {/* Added seeds chips */}
      {seedCount > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {seeds?.map((s) => (
            <div key={s.id} className="text-xs bg-primary/20 text-primary px-3 py-1 rounded-full border border-primary/30 font-medium">
              {s.title}
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 flex flex-col justify-center">
        <h2 className="text-2xl font-bold text-foreground mb-6 text-center leading-snug">
          {PROMPTS[promptIdx]}
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

      <div className="pt-6 mt-auto">
        <Button
          onClick={onComplete}
          disabled={!canProceed}
          className="w-full h-14 rounded-full bg-primary text-primary-foreground text-lg"
        >
          {canProceed ? "Continue deeper" : `Seed ${5 - seedCount} more to proceed`}
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
