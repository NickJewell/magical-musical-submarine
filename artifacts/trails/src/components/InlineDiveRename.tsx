import { useState, useRef, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Pencil, Check, X, Loader2 } from 'lucide-react';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

async function renameDive(diveId: number, userId: number, name: string): Promise<{ name: string }> {
  const r = await fetch(`${basePath}/api/dive/${diveId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, name }),
  });
  if (!r.ok) throw new Error('Rename failed');
  return r.json();
}

interface Props {
  diveId: number;
  userId: number;
  name: string;
  /** Called with the new name after a successful save. */
  onRenamed: (name: string) => void;
  /** Visual variant: 'heading' for large text, 'label' for small mono caps */
  variant?: 'heading' | 'label';
}

export function InlineDiveRename({ diveId, userId, name, onRenamed, variant = 'heading' }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync if parent name changes (e.g. after query refetch)
  useEffect(() => { if (!editing) setDraft(name); }, [name, editing]);

  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const rename = useMutation({
    mutationFn: (newName: string) => renameDive(diveId, userId, newName),
    onSuccess: (data) => {
      onRenamed(data.name);
      setEditing(false);
    },
  });

  function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) { setEditing(false); setDraft(name); return; }
    rename.mutate(trimmed);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter')  { e.preventDefault(); handleSave(); }
    if (e.key === 'Escape') { setEditing(false); setDraft(name); }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2 w-full">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={80}
          className={`
            flex-1 min-w-0 bg-transparent border-b border-primary/50 outline-none
            text-foreground placeholder:text-muted-foreground/40
            ${variant === 'heading' ? 'text-lg font-medium py-0.5' : 'text-xs font-mono uppercase tracking-widest py-0.5'}
          `}
        />
        <button
          onClick={handleSave}
          disabled={rename.isPending}
          className="shrink-0 text-primary hover:text-primary/70 transition-colors disabled:opacity-40"
          aria-label="Save name"
        >
          {rename.isPending
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <Check className="w-4 h-4" />}
        </button>
        <button
          onClick={() => { setEditing(false); setDraft(name); }}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Cancel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 group">
      <span
        className={
          variant === 'heading'
            ? 'text-lg font-medium text-foreground'
            : 'text-xs font-mono text-primary uppercase tracking-widest'
        }
      >
        {name}
      </span>
      <button
        onClick={() => setEditing(true)}
        className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground/50 hover:text-primary transition-all"
        aria-label="Rename dive"
      >
        <Pencil className="w-3.5 h-3.5" />
      </button>
      {rename.isError && (
        <span className="text-[10px] text-destructive font-mono">Failed to save</span>
      )}
    </div>
  );
}
