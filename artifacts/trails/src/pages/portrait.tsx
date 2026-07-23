import { useState, useEffect } from 'react';
import { useGetPortrait, useUpdatePortrait, useGeneratePortrait, getGetPortraitQueryKey } from '@workspace/api-client-react';
import { getUserId } from '@/lib/auth';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, RefreshCw, Check } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function PortraitPage() {
  const userId = getUserId();
  const { data: portrait, isLoading } = useGetPortrait({ userId: userId! }, { query: { enabled: !!userId, queryKey: getGetPortraitQueryKey({ userId: userId! }) } });
  const [text, setText] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const updatePortrait = useUpdatePortrait();
  const generatePortrait = useGeneratePortrait();

  useEffect(() => {
    if (portrait && !isEditing) {
      setText(portrait.text);
    }
  }, [portrait, isEditing]);

  if (!userId) return null;

  if (isLoading || !portrait) {
    return <div className="flex-1 flex items-center justify-center min-h-[100dvh]"><Loader2 className="w-8 h-8 text-primary animate-spin" /></div>;
  }

  const handleSave = () => {
    if (text === portrait.text) {
      setIsEditing(false);
      return;
    }
    updatePortrait.mutate(
      { data: { userId, text } },
      { 
        onSuccess: (newPortrait) => {
          queryClient.setQueryData(getGetPortraitQueryKey({ userId }), newPortrait);
          setIsEditing(false);
          toast({ title: 'Portrait updated', description: 'Your manual adjustments have been recorded.' });
        }
      }
    );
  };

  const handleRegenerate = () => {
    generatePortrait.mutate(
      { data: { userId } },
      {
        onSuccess: (newPortrait) => {
          queryClient.setQueryData(getGetPortraitQueryKey({ userId }), newPortrait);
          setText(newPortrait.text);
          setIsEditing(false);
          toast({ title: 'Portrait regenerated', description: 'A new interpretation has been formed.' });
        }
      }
    );
  };

  return (
    <div className="p-6 pt-12 max-w-md mx-auto min-h-screen flex flex-col animate-in fade-in duration-700">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-xl font-serif text-primary-foreground">Your Portrait</h1>
        <div className="text-right">
          <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest">v{portrait.version}</p>
          <p className="text-[10px] text-muted-foreground/50 uppercase">{portrait.source}</p>
        </div>
      </div>

      <div className="flex-1 relative mb-6">
        <Textarea 
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (!isEditing) setIsEditing(true);
          }}
          className="h-full min-h-[50dvh] bg-secondary/10 border-primary/20 rounded-2xl p-6 font-serif text-lg leading-relaxed text-primary-foreground/90 resize-none focus-visible:ring-primary/50"
        />
      </div>

      <div className="space-y-4 pb-20">
        {isEditing && (
          <Button 
            onClick={handleSave}
            disabled={updatePortrait.isPending}
            className="w-full h-12 rounded-xl bg-primary text-primary-foreground"
          >
            {updatePortrait.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Check className="w-4 h-4 mr-2" /> Save edits</>}
          </Button>
        )}
        
        <Button 
          onClick={handleRegenerate}
          disabled={generatePortrait.isPending || updatePortrait.isPending}
          variant="outline"
          className="w-full h-12 rounded-xl border-border hover:bg-secondary/50 text-muted-foreground"
        >
          {generatePortrait.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <><RefreshCw className="w-4 h-4 mr-2" /> Regenerate from latest seeds</>}
        </Button>
      </div>
    </div>
  );
}
