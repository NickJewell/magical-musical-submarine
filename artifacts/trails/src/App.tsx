import { useEffect, useRef } from 'react';
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { Layout } from '@/components/layout';
import { queryClient } from '@/lib/queryClient';

import HomePage from '@/pages/home';
import OnboardPage from '@/pages/onboard';
import PortraitPage from '@/pages/portrait';
import DivePage from '@/pages/dive';
import QueuePage from '@/pages/queue';
import MetricsPage from '@/pages/metrics';
import TimelinePage from '@/pages/timeline';
import SignInPage from '@/pages/sign-in';
import SignUpPage from '@/pages/sign-up';
import NotFound from '@/pages/not-found';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

// REQUIRED — resolves key from hostname so dev and prod use the correct key automatically.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// REQUIRED — empty in dev (Clerk hits FAPI directly), auto-set in prod. Do NOT gate on NODE_ENV.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

// Deep-ocean branded appearance matching the Trails dark theme
const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
    socialButtonsPlacement: 'top' as const,
    socialButtonsVariant: 'blockButton' as const,
  },
  variables: {
    colorPrimary: 'hsl(180 80% 40%)',
    colorForeground: 'hsl(210 20% 85%)',
    colorMutedForeground: 'hsl(215 20% 55%)',
    colorDanger: 'hsl(0 60% 50%)',
    colorBackground: 'hsl(220 40% 6%)',
    colorInput: 'hsl(215 30% 12%)',
    colorInputForeground: 'hsl(210 20% 85%)',
    colorNeutral: 'hsl(215 30% 20%)',
    fontFamily: "'Space Mono', 'Outfit', sans-serif",
    borderRadius: '0.75rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'rounded-2xl w-[440px] max-w-full overflow-hidden border border-[hsl(215,30%,15%)] shadow-[0_0_40px_hsla(180,80%,40%,0.08)]',
    card: '!shadow-none !border-0 !bg-[hsl(220,40%,6%)] !rounded-none',
    footer: '!shadow-none !border-0 !bg-[hsl(220,40%,6%)] !rounded-none',
    headerTitle: 'text-[hsl(210,20%,90%)] font-serif',
    headerSubtitle: 'text-[hsl(215,20%,55%)]',
    socialButtonsBlockButtonText: 'text-[hsl(210,20%,85%)]',
    socialButtonsBlockButton: 'border-[hsl(215,30%,18%)] bg-[hsl(220,40%,9%)] hover:bg-[hsl(220,40%,12%)] transition-colors',
    formFieldLabel: 'text-[hsl(215,20%,65%)]',
    formFieldInput: 'bg-[hsl(215,30%,10%)] border-[hsl(215,30%,18%)] text-[hsl(210,20%,85%)]',
    formButtonPrimary: 'bg-[hsl(180,80%,35%)] hover:bg-[hsl(180,80%,40%)] text-[hsl(220,50%,8%)] font-medium transition-colors',
    footerActionText: 'text-[hsl(215,20%,55%)]',
    footerActionLink: 'text-[hsl(180,80%,50%)] hover:text-[hsl(180,80%,60%)]',
    footerAction: 'border-t border-[hsl(215,30%,12%)]',
    dividerText: 'text-[hsl(215,20%,45%)]',
    dividerLine: 'bg-[hsl(215,30%,15%)]',
    identityPreviewEditButton: 'text-[hsl(180,80%,50%)]',
    formFieldSuccessText: 'text-[hsl(180,80%,50%)]',
    alertText: 'text-[hsl(210,20%,85%)]',
    alert: 'border-[hsl(215,30%,18%)] bg-[hsl(220,40%,8%)]',
    logoBox: 'mb-2',
    logoImage: 'h-12 w-auto',
    otpCodeFieldInput: 'bg-[hsl(215,30%,10%)] border-[hsl(215,30%,18%)] text-[hsl(210,20%,85%)]',
    formFieldRow: 'gap-3',
    main: 'gap-5',
  },
};

// Invalidates React Query cache when the signed-in user changes.
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={HomePage} />
        {/* REQUIRED — /*? is the only wouter syntax that matches Clerk's OAuth sub-paths */}
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/onboard" component={OnboardPage} />
        <Route path="/portrait" component={PortraitPage} />
        <Route path="/dive/:id" component={DivePage} />
        <Route path="/dive/:id/queue" component={QueuePage} />
        <Route path="/metrics" component={MetricsPage} />
        <Route path="/timeline" component={TimelinePage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: 'Welcome back',
            subtitle: 'Sign in to your musical submarine',
          },
        },
        signUp: {
          start: {
            title: 'Begin your descent',
            subtitle: 'Create your account to start exploring',
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <Router />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
