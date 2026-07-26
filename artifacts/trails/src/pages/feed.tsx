import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useSearchMusic, useAddSeed, useGeneratePortrait,
  getListSeedsQueryKey, getSearchMusicQueryKey, getGetPortraitQueryKey,
  type SearchResult,
} from '@workspace/api-client-react';
import { useLocalUser } from '@/lib/useLocalUser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Search, Check, ChevronDown, ListPlus, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TrackPreviewPill } from '@/components/TrackPreviewPill';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

// Persist a star rating for a track at the point of addition. Keyed by
// (userId, mbid) via the focus-rating upsert, so it flows into ELO, the
// rankings screen, and the portrait pipeline like any other rating.
async function saveStar(
  userId: number, r: SearchResult, score: number,
): Promise<void> {
  if (!r.mbid) return; // unverified results have no stable id to key a rating on
  await fetch(`${basePath}/api/focus-rating`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId, mbid: r.mbid, title: r.title, artist: r.artist,
      listenState: 'known', score,
    }),
  }).catch(() => {/* rating is best-effort — never block the add */});
}

export default function FeedPage() {
  const { localUserId: userId, isLoading } = useLocalUser();
  const [, setLocation] = useLocation();

  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center min-h-screen">
      <Loader2 className="w-8 h-8 text-primary animate-spin" />
    </div>
  );
  if (!userId) { setTimeout(() => setLocation('/'), 0); return null; }

  return <FeedContent userId={userId} onDone={() => setLocation('/')} />;
}

function FeedContent({ userId, onDone }: { userId: number; onDone: () => void }) {
  const queryClient = useQueryClient();

  const [query, setQuery]               = useState('');
  const [debouncedQuery, setDebounced]  = useState('');
  const [page, setPage]                 = useState(1);
  const [allResults, setAllResults]     = useState<SearchResult[]>([]);
  const [sessionAdded, setSessionAdded] = useState<SearchResult[]>([]);
  const [sessionStars, setSessionStars] = useState<Record<string, number>>({}); // resultKey → 1-3
  const [justAdded, setJustAdded]       = useState<string | null>(null); // resultKey flash
  const [addError, setAddError]         = useState<string | null>(null);
  const [finishing, setFinishing]       = useState(false);
  const [portraitDone, setPortraitDone] = useState(false);
  const prevQueryRef = useRef('');
  const inputRef     = useRef<HTMLInputElement>(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(query);
      if (query !== prevQueryRef.current) {
        setPage(1);
        setAllResults([]);
        prevQueryRef.current = query;
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data: pageResults, isLoading: isSearching, isFetching, isError } = useSearchMusic(
    { userId, q: debouncedQuery, type: 'track', page },
    { query: { enabled: debouncedQuery.length > 2, queryKey: getSearchMusicQueryKey({ userId, q: debouncedQuery, type: 'track', page }), retry: false } }
  );

  useEffect(() => {
    if (!pageResults) return;
    setAllResults(prev => page === 1 ? pageResults : [...prev, ...pageResults]);
  }, [pageResults]); // eslint-disable-line react-hooks/exhaustive-deps

  const addSeed        = useAddSeed();
  const generatePortrait = useGeneratePortrait();

  // Use a stable composite key for each result — empty-mbid (unverified) results
  // fall back to title+artist so they don't all share '' as their dedup key.
  const resultKey = (r: SearchResult) => r.mbid || `${r.title}__${r.artist}`;

  const addedKeys  = new Set(sessionAdded.map(resultKey));
  const canLoadMore = !!pageResults && pageResults.length === 10 && !isFetching;
  const hasResults  = allResults.length > 0;

  const handleAdd = (r: SearchResult) => {
    const key = resultKey(r);
    if (addedKeys.has(key) || addSeed.isPending) return;
    setAddError(null);
    addSeed.mutate(
      { data: { userId, mbid: r.mbid, type: r.type === 'album' ? 'album' : 'track', title: r.title, artist: r.artist, year: r.year, prompt: null } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSeedsQueryKey({ userId }) });
          setSessionAdded(prev => [r, ...prev]);
          // Default every added track to three stars, adjustable in the tray below.
          setSessionStars(prev => ({ ...prev, [key]: 3 }));
          saveStar(userId, r, 3);
          setJustAdded(key);
          setTimeout(() => setJustAdded(null), 1000);
          // Clear search so they're ready for the next track
          setQuery('');
          setAllResults([]);
          setPage(1);
          inputRef.current?.focus();
        },
        onError: () => {
          setAddError("Couldn't save that track — please try again.");
          setTimeout(() => setAddError(null), 3000);
        },
      }
    );
  };

  const handleFinish = () => {
    if (sessionAdded.length === 0) { onDone(); return; }
    setFinishing(true);
    generatePortrait.mutate(
      { data: { userId } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPortraitQueryKey({ userId }) });
          setPortraitDone(true);
          setTimeout(onDone, 1600);
        },
        onError: () => setFinishing(false),
      }
    );
  };

  // ---- Done state ----
  if (portraitDone) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-5 animate-in fade-in duration-500">
        <div className="w-16 h-16 rounded-full border border-primary/40 bg-primary/5 flex items-center justify-center">
          <Check className="w-7 h-7 text-primary" />
        </div>
        <p className="text-sm font-mono text-primary/80 uppercase tracking-widest">Portrait updated</p>
        <p className="text-xs font-mono text-muted-foreground/40">
          {sessionAdded.length} track{sessionAdded.length !== 1 ? 's' : ''} added to your graph
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-[100dvh] pb-20">
      <div className="flex-1 flex flex-col p-6 pt-8 max-w-md mx-auto w-full">

        {/* Header */}
        <div className="mb-7 text-center">
          <div className="flex items-center justify-center gap-2 mb-1.5">
            <ListPlus className="w-3.5 h-3.5 text-primary/50" />
            <span className="text-[10px] font-mono text-primary/50 uppercase tracking-widest">Rank tracks</span>
          </div>
          <p className="text-muted-foreground/50 text-sm">
            Search, add, and star tracks you know. Hit done when you're finished.
          </p>
        </div>

        {/* Search input */}
        <div className="relative mb-4">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground w-5 h-5" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for a track…"
            autoFocus
            className="pl-12 h-14 rounded-full bg-secondary/20 border-primary/20 focus-visible:border-primary text-lg"
          />
        </div>

        {/* Session tray — shown when tracks have been added and no active search */}
        {sessionAdded.length > 0 && !debouncedQuery && (
          <div className="mb-5 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <p className="text-[10px] font-mono text-muted-foreground/40 uppercase tracking-widest mb-2">
              Added this session · {sessionAdded.length}
            </p>
            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              {sessionAdded.map((r) => {
                const key = resultKey(r);
                const star = sessionStars[key] ?? 3;
                return (
                  <div
                    key={key}
                    className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-primary/5 border border-primary/15"
                  >
                    <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                      <Check className="w-3 h-3 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate leading-tight">{r.title}</p>
                      <p className="text-xs text-muted-foreground/60 truncate">{r.artist}</p>
                    </div>
                    {r.mbid ? (
                      <div className="flex items-center gap-0.5 shrink-0">
                        {[1, 2, 3].map((s) => (
                          <button
                            key={s}
                            onClick={() => {
                              setSessionStars((prev) => ({ ...prev, [key]: s }));
                              saveStar(userId, r, s);
                            }}
                            className="p-0.5 transition-transform hover:scale-110"
                            title={`${s}/3`}
                          >
                            <Star
                              className={cn(
                                'w-4 h-4 transition-colors',
                                s <= star ? 'fill-amber-400 text-amber-400' : 'fill-transparent text-muted-foreground/30',
                              )}
                            />
                          </button>
                        ))}
                      </div>
                    ) : r.year ? (
                      <span className="text-[10px] font-mono text-muted-foreground/40 shrink-0">{r.year}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Search results */}
        <div className="flex-1 space-y-1.5 overflow-y-auto">
          {isError && (
            <p className="text-center p-4 text-sm text-destructive">Search timed out — please try again.</p>
          )}
          {addError && (
            <p className="text-center p-3 text-sm text-destructive/80 animate-in fade-in">{addError}</p>
          )}
          {!isError && isSearching && allResults.length === 0 && (
            <div className="text-center p-4">
              <Loader2 className="w-5 h-5 animate-spin mx-auto text-primary" />
            </div>
          )}

          {hasResults && allResults.map((r) => {
            const key      = resultKey(r);
            const added    = addedKeys.has(key);
            const flashing = justAdded === key;
            return (
              <div
                key={key}
                className={cn(
                  'rounded-xl border transition-all',
                  added
                    ? 'bg-primary/8 border-primary/20 opacity-60'
                    : 'bg-secondary/20 border-border/30',
                )}
              >
                {/* Main tap target — adds the track */}
                <button
                  onClick={() => handleAdd(r)}
                  disabled={added || addSeed.isPending}
                  className={cn(
                    'w-full text-left p-4 flex items-center gap-4 group rounded-xl',
                    !added && 'hover:bg-secondary/30 active:bg-secondary/50',
                  )}
                >
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <p className="font-semibold text-base text-foreground truncate leading-tight">{r.title}</p>
                    <p className="text-sm font-medium text-primary/90 truncate">{r.artist}</p>
                    {r.release && <p className="text-xs text-muted-foreground truncate">{r.release}</p>}
                    {!r.verified && (
                      <p className="text-[10px] font-mono text-amber-400/70 uppercase tracking-widest">unverified</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {r.year && (
                      <span className="text-xs font-mono text-muted-foreground bg-secondary/60 px-2 py-0.5 rounded-full border border-border/50">
                        {r.year}
                      </span>
                    )}
                    <div className={cn(
                      'w-7 h-7 rounded-full flex items-center justify-center transition-all duration-300',
                      flashing ? 'bg-primary scale-110' :
                      added    ? 'bg-primary/20' :
                                 'bg-primary/15 group-hover:bg-primary/30',
                    )}>
                      <Check className={cn(
                        'w-3.5 h-3.5 transition-opacity',
                        added ? 'text-primary opacity-100' : 'opacity-0',
                      )} />
                    </div>
                  </div>
                </button>
                {/* Preview pill — only for verified tracks with a real MBID */}
                {r.verified && r.mbid && (
                  <div className="px-4 pb-3 -mt-1">
                    <TrackPreviewPill title={r.title} artist={r.artist} />
                  </div>
                )}
              </div>
            );
          })}

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

        {/* Finish / Done */}
        <div className="pt-6 mt-auto space-y-2">
          <Button
            onClick={handleFinish}
            disabled={finishing}
            className={cn(
              'w-full h-14 rounded-full text-base transition-all duration-300',
              sessionAdded.length > 0
                ? 'bg-primary text-primary-foreground shadow-[0_0_24px_hsla(180,80%,40%,0.3)] hover:shadow-[0_0_32px_hsla(180,80%,40%,0.45)]'
                : 'bg-secondary/40 text-muted-foreground',
            )}
          >
            {finishing ? (
              <><Loader2 className="w-4 h-4 animate-spin mr-2 inline" />Rebuilding portrait…</>
            ) : sessionAdded.length > 0 ? (
              `Done — refresh portrait (${sessionAdded.length} added) →`
            ) : (
              'Done'
            )}
          </Button>
          {sessionAdded.length === 0 && (
            <p className="text-center text-[11px] text-muted-foreground/35 font-mono">
              search and add at least one track to refresh your portrait
            </p>
          )}
        </div>

      </div>
    </div>
  );
}
