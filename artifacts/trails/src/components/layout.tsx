import { Link, useLocation } from 'wouter';
import { getUserId } from '@/lib/auth';
import { Home, Compass, Activity, User as UserIcon } from 'lucide-react';

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const userId = getUserId();

  if (!userId && location === '/') {
    // If not logged in and on home page, no chrome
    return <main className="min-h-[100dvh] flex flex-col bg-background relative overflow-hidden">{children}<div className="bg-noise" /></main>;
  }

  // If onboard path, minimal chrome
  if (location === '/onboard') {
    return <main className="min-h-[100dvh] flex flex-col bg-background relative overflow-hidden">{children}<div className="bg-noise" /></main>;
  }

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background relative overflow-hidden">
      <div className="bg-noise" />
      <main className="flex-1 overflow-y-auto pb-20 z-10">
        {children}
      </main>
      
      {/* Bottom Nav */}
      {userId && (
        <nav className="fixed bottom-0 left-0 right-0 h-16 bg-background/80 backdrop-blur-md border-t border-border z-20 flex items-center justify-around px-6">
          <Link href="/" className={`p-3 rounded-full transition-colors ${location === '/' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            <Home className="w-6 h-6" />
          </Link>
          <Link href="/portrait" className={`p-3 rounded-full transition-colors ${location === '/portrait' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            <UserIcon className="w-6 h-6" />
          </Link>
          <Link href="/metrics" className={`p-3 rounded-full transition-colors ${location === '/metrics' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            <Activity className="w-6 h-6" />
          </Link>
        </nav>
      )}
    </div>
  );
}
