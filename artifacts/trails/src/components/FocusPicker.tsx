import { useState, useEffect, useRef } from 'react';
import {
  useSearchMusic,
  getSearchMusicQueryKey,
  type SearchResult,
  type Focus,
} from '@workspace/api-client-react';
import { Loader2, Search, X } from 'lucide-react';

/**
 * Lets a diver start from a specific selection instead of their portrait.
 * Genre / subgenre are free-text; artist / album / track are searched via
 * MusicBrainz (the existing /search endpoint). Picking one emits a Focus.
 */

type EntityKind = 'artist' | 'album' | 'track';
const ENTITY_KINDS: EntityKind[] = ['artist', 'album', 'track'];
const KIND_TABS = ['genre', ...ENTITY_KINDS] as const;
type Tab = (typeof KIND_TABS)[number];

export function FocusPicker({
  userId,
  onPick,
  disabled,
}: {
  userId: number;
  onPick: (focus: Focus) => void;
  disabled?: boolean;
}) {
  const [tab, setTab] = useState<Tab>('genre');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const isEntity = tab !== 'genre';

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data: results, isFetching } = useSearchMusic(
    { userId, q: debounced, type: isEntity ? (tab as EntityKind) : 'track', page: 1 },
    {
      query: {
        enabled: isEntity && debounced.length > 2,
        queryKey: getSearchMusicQueryKey({ userId, q: debounced, type: isEntity ? (tab as EntityKind) : 'track', page: 1 }),
        retry: false,
      },
    },
  );

  const pickEntity = (r: SearchResult) => {
    if (disabled) return;
    onPick({
      kind: tab as EntityKind,
      label: r.title,
      artist: tab === 'artist' ? null : r.artist,
      mbid: r.mbid || null,
    });
  };

  const pickGenre = () => {
    const label = query.trim();
    if (!label || disabled) return;
    onPick({ kind: 'genre', label, artist: null, mbid: null });
  };

  return (
    <div className="space-y-4">
      {/* Type tabs */}
      <div className="flex gap-1.5">
        {KIND_TABS.map((k) => (
          <button
            key={k}
            onClick={() => {
              setTab(k);
              setQuery('');
              setDebounced('');
              inputRef.current?.focus();
            }}
            className={`px-3 py-1.5 rounded-full text-xs font-mono uppercase tracking-wider transition-colors ${
              tab === k
                ? 'bg-primary/20 text-primary border border-primary/40'
                : 'text-muted-foreground/70 border border-border/50 hover:text-muted-foreground'
            }`}
          >
            {k}
          </button>
        ))}
      </div>

      {/* Search / free-text input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!isEntity) pickGenre();
        }}
        className="relative"
      >
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            isEntity ? `Search for a ${tab}…` : 'Name a genre or subgenre, then press Enter'
          }
          className="w-full pl-9 pr-9 py-2.5 rounded-xl bg-secondary/30 border border-border/50 text-sm text-primary-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setDebounced('');
              inputRef.current?.focus();
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </form>

      {/* Genre helper */}
      {!isEntity && query.trim().length > 0 && (
        <button
          onClick={pickGenre}
          disabled={disabled}
          className="w-full text-left p-3 rounded-xl bg-secondary/40 border border-primary/20 hover:border-primary/50 transition-colors text-sm text-primary-foreground disabled:opacity-50"
        >
          Explore from <span className="text-primary font-medium">{query.trim()}</span>
        </button>
      )}

      {/* Entity search results */}
      {isEntity && (
        <div className="space-y-1.5">
          {isFetching && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground/60 py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching…
            </div>
          )}
          {!isFetching && debounced.length > 2 && results && results.length === 0 && (
            <p className="text-xs text-muted-foreground/50 py-2">No {tab}s found for “{debounced}”.</p>
          )}
          {results?.slice(0, 6).map((r) => (
            <button
              key={`${r.mbid || r.title}-${r.artist}`}
              onClick={() => pickEntity(r)}
              disabled={disabled}
              className="w-full text-left p-3 rounded-xl bg-secondary/40 border border-border/50 hover:border-primary/50 transition-colors disabled:opacity-50"
            >
              <div className="text-sm text-primary-foreground truncate">{r.title}</div>
              {tab !== 'artist' && (
                <div className="text-xs text-muted-foreground/60 truncate">
                  {r.artist}
                  {r.year ? ` · ${r.year}` : ''}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
