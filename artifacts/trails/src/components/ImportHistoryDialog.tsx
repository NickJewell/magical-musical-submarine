import { useState } from 'react';
import { useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, CloudDownload, Check, Scale } from 'lucide-react';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

const PERIODS = [
  { value: 'overall', label: 'All time' },
  { value: '12month', label: 'Last 12 months' },
  { value: '6month', label: 'Last 6 months' },
  { value: '3month', label: 'Last 3 months' },
] as const;

const AMOUNTS = [50, 100, 200] as const;

interface Preview {
  username: string;
  totalTracks: number;
  sample: Array<{ title: string; artist: string; playcount: number }>;
}

interface ImportOutcome { fetched: number; imported: number; skipped: number }

type Phase = 'form' | 'checking' | 'ready' | 'importing' | 'done';

/**
 * Import a Last.fm listening history into the taste graph. Last.fm profiles
 * are public, so this needs only a username — no OAuth. Flow: check the
 * username (preview) → import → hand off to Compare to start ranking them.
 */
export function ImportHistoryDialog({ userId, onClose }: { userId: number; onClose: () => void }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const [username, setUsername] = useState(() => localStorage.getItem('lastfm-username') ?? '');
  const [period, setPeriod] = useState<string>('overall');
  const [amount, setAmount] = useState<number>(100);
  const [phase, setPhase] = useState<Phase>('form');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = phase === 'checking' || phase === 'importing';

  const check = async () => {
    const name = username.trim();
    if (!name || busy) return;
    setPhase('checking');
    setError(null);
    try {
      const params = new URLSearchParams({ username: name, period });
      const r = await fetch(`${basePath}/api/import/lastfm/preview?${params}`);
      const d = await r.json();
      if (!r.ok) {
        setError(d.error ?? 'Lookup failed');
        setPhase('form');
        return;
      }
      localStorage.setItem('lastfm-username', name);
      setPreview(d as Preview);
      setPhase('ready');
    } catch {
      setError("Couldn't reach the server — try again");
      setPhase('form');
    }
  };

  const runImport = async () => {
    if (busy) return;
    setPhase('importing');
    setError(null);
    try {
      const r = await fetch(`${basePath}/api/import/lastfm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, username: username.trim(), period, limit: amount }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error ?? 'Import failed');
        setPhase('ready');
        return;
      }
      setOutcome(d as ImportOutcome);
      setPhase('done');
      queryClient.invalidateQueries({ queryKey: ['rankings', userId] });
    } catch {
      setError("Couldn't reach the server — try again");
      setPhase('ready');
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-sm mx-auto rounded-2xl bg-background border-border/50 space-y-4">
        <DialogHeader>
          <DialogTitle className="font-serif text-lg text-foreground leading-snug flex items-center gap-2">
            <CloudDownload className="w-4 h-4 text-primary" /> Import listening history
          </DialogTitle>
        </DialogHeader>

        {phase !== 'done' && (
          <>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Pull your most-played tracks from Last.fm into your rankings as
              "known" tracks — they'll be excluded from discovery and queued up
              in Compare so you can rank them fast. Profiles are public: just a
              username, no sign-in.
            </p>

            {/* Username */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-widest">
                Last.fm username
              </label>
              <input
                value={username}
                onChange={(e) => { setUsername(e.target.value); setPhase('form'); setPreview(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') check(); }}
                placeholder="e.g. rj"
                disabled={busy}
                className="w-full h-10 px-3 rounded-xl bg-secondary/30 border border-border/40 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 disabled:opacity-50"
              />
            </div>

            {/* Period */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-widest">
                Period
              </label>
              <div className="flex gap-1.5 flex-wrap">
                {PERIODS.map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => { setPeriod(value); setPhase('form'); setPreview(null); }}
                    disabled={busy}
                    className={`text-xs font-mono px-3 py-1.5 rounded-full border transition-colors disabled:opacity-50 ${
                      period === value
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border/40 text-muted-foreground hover:border-primary/50 hover:text-foreground'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Amount */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-widest">
                How many tracks
              </label>
              <div className="flex gap-1.5">
                {AMOUNTS.map((n) => (
                  <button
                    key={n}
                    onClick={() => setAmount(n)}
                    disabled={busy}
                    className={`text-xs font-mono px-3 py-1.5 rounded-full border transition-colors disabled:opacity-50 ${
                      amount === n
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border/40 text-muted-foreground hover:border-primary/50 hover:text-foreground'
                    }`}
                  >
                    Top {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Preview confirmation */}
            {phase === 'ready' && preview && (
              <div className="rounded-xl border border-primary/15 bg-primary/[0.04] px-3 py-2.5 space-y-1 animate-in fade-in duration-200">
                <p className="text-xs text-foreground/90">
                  Found <span className="font-medium">{preview.username}</span>
                  {preview.totalTracks > 0 && (
                    <> — {preview.totalTracks.toLocaleString()} tracks in this period</>
                  )}
                </p>
                {preview.sample.length > 0 && (
                  <p className="text-[11px] text-muted-foreground truncate">
                    Most played: {preview.sample.slice(0, 3).map((t) => `${t.title} (${t.artist})`).join(' · ')}
                  </p>
                )}
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            {phase === 'ready' ? (
              <Button onClick={runImport} className="w-full justify-center">
                <CloudDownload className="w-4 h-4" /> Import top {amount}
              </Button>
            ) : (
              <Button onClick={check} disabled={!username.trim() || busy} className="w-full justify-center">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {phase === 'checking' ? 'Looking up…' : phase === 'importing' ? 'Importing…' : 'Check username'}
              </Button>
            )}
          </>
        )}

        {phase === 'done' && outcome && (
          <div className="space-y-4 animate-in fade-in duration-200">
            <div className="rounded-xl border border-primary/15 bg-primary/[0.04] px-3 py-3 space-y-1">
              <p className="flex items-center gap-1.5 text-sm text-foreground">
                <Check className="w-4 h-4 text-primary" />
                {outcome.imported} track{outcome.imported === 1 ? '' : 's'} imported
              </p>
              {outcome.skipped > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {outcome.skipped} already in your taste graph — skipped.
                </p>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              They're in your rankings now, unstarred. Head to Compare to start
              settling them — or star them directly from the table.
            </p>
            <div className="flex flex-col gap-2">
              <Button onClick={() => { onClose(); setLocation('/compare'); }} className="w-full justify-center">
                <Scale className="w-4 h-4" /> Settle them in Compare
              </Button>
              <Button variant="ghost" onClick={onClose} className="w-full justify-center">
                Done
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
