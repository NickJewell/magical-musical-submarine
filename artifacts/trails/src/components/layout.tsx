import { Link, useLocation } from 'wouter';
import { useUser } from '@clerk/react';
import { Home, BookOpen, Activity, ScrollText } from 'lucide-react';

const NAV_ITEMS = [
  { href: '/',          icon: Home,       label: 'Home'     },
  { href: '/timeline',  icon: ScrollText, label: 'Timeline' },
  { href: '/portrait',  icon: BookOpen,   label: 'Portrait' },
  { href: '/metrics',   icon: Activity,   label: 'Metrics'  },
];

// Pages that should show with no chrome at all
const NO_CHROME = ['/sign-in', '/sign-up'];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { isSignedIn, isLoaded } = useUser();

  const bare = !isLoaded || NO_CHROME.some((p) => location.startsWith(p)) || (!isSignedIn && location === '/');

  if (bare) {
    return (
      <main className="min-h-[100dvh] flex flex-col bg-background relative overflow-hidden">
        {children}
        <div className="bg-noise" />
      </main>
    );
  }

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background relative overflow-hidden">
      <div className="bg-noise" />
      <main className="flex-1 overflow-y-auto pb-20 z-10">
        {children}
      </main>

      {isSignedIn && (
        <nav className="fixed bottom-0 left-0 right-0 h-16 bg-background/90 backdrop-blur-md border-t border-border/60 z-20 flex items-center justify-around px-6">
          {NAV_ITEMS.map(({ href, icon: Icon, label }) => {
            const active = href === '/' ? location === '/' : location.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex flex-col items-center gap-0.5 px-4 py-1.5 rounded-xl transition-colors ${
                  active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className={`text-[10px] font-mono uppercase tracking-widest ${active ? 'text-primary' : ''}`}>
                  {label}
                </span>
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
