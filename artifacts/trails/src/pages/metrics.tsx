import { useGetMetrics, getGetMetricsQueryKey } from '@workspace/api-client-react';
import { useLocalUser } from '@/lib/useLocalUser';
import { Loader2, TrendingUp, BarChart3, Activity } from 'lucide-react';

export default function MetricsPage() {
  const { localUserId: userId, isLoading: userLoading } = useLocalUser();

  if (userLoading) return (
    <div className="flex-1 flex items-center justify-center min-h-[100dvh]">
      <Loader2 className="w-8 h-8 text-primary animate-spin" />
    </div>
  );
  if (!userId) return null;

  return <MetricsContent userId={userId} />;
}

function MetricsContent({ userId }: { userId: number }) {
  const { data: metrics, isLoading } = useGetMetrics(
    { userId },
    { query: { enabled: true, queryKey: getGetMetricsQueryKey({ userId }) } }
  );

  if (isLoading || !metrics) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[100dvh]">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  const { overallDiscoveryRate, totalRatedRecs, byArm, byDive } = metrics;

  const formatPct = (val: number | null) => val !== null ? `${(val * 100).toFixed(1)}%` : '—';
  const formatScore = (val: number | null) => val !== null ? val.toFixed(2) : '—';

  return (
    <div className="p-6 pt-12 max-w-md mx-auto space-y-12 pb-24 animate-in fade-in duration-700">
      <div className="space-y-2">
        <h1 className="text-xl font-serif text-primary-foreground flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" />
          Sonar Logs
        </h1>
        <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest">
          {totalRatedRecs} total signals recorded
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="p-6 rounded-3xl bg-primary text-primary-foreground flex flex-col justify-center relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-24 h-24 bg-white/10 rounded-full blur-2xl -translate-y-1/2 translate-x-1/2" />
          <h2 className="text-[10px] font-mono uppercase tracking-widest opacity-80 mb-2">Discovery Rate</h2>
          <p className="text-4xl font-serif font-medium tracking-tight">
            {formatPct(overallDiscoveryRate)}
          </p>
        </div>
        
        <div className="p-6 rounded-3xl bg-secondary/30 border border-border flex flex-col justify-center">
           <h2 className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2">Goal</h2>
           <p className="text-sm font-serif text-primary-foreground/90 leading-tight">
             LLM-new scores matching LLM-known
           </p>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest flex items-center gap-2">
          <BarChart3 className="w-3 h-3" /> Arm Performance
        </h3>
        
        <div className="space-y-3">
          {byArm.map(arm => (
            <div key={arm.arm} className="p-5 rounded-2xl bg-secondary/20 border border-border/50 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm uppercase text-primary-foreground">{arm.arm.replace('_', ' ')}</span>
                <span className="text-xs text-muted-foreground">n={arm.count}</span>
              </div>
              <div className="grid grid-cols-2 gap-4 pt-3 border-t border-border/50">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase mb-1">Avg Score</p>
                  <p className="font-serif text-lg text-primary-foreground">{formatScore(arm.avgScore)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase mb-1">New to you</p>
                  <p className="font-serif text-lg text-primary-foreground">{formatPct(arm.discoveryRate)}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {byDive.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest flex items-center gap-2">
            <TrendingUp className="w-3 h-3" /> Dive Path Ratings
          </h3>
          
          <div className="space-y-2">
            {byDive.map(dive => (
              <div key={dive.diveId} className="flex items-center justify-between p-4 rounded-xl bg-secondary/10 hover:bg-secondary/20 transition-colors border border-transparent hover:border-border/50">
                <div>
                  <p className="font-medium text-primary-foreground text-sm">{dive.diveName}</p>
                  <p className="text-xs text-muted-foreground">{dive.stepCount} steps</p>
                </div>
                <div className="text-right">
                  <p className="font-serif text-primary text-lg">{formatScore(dive.avgPathScore)}</p>
                  <p className="text-[10px] text-muted-foreground uppercase">Avg rating</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
