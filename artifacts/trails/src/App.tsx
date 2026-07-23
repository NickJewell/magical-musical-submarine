import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Layout } from '@/components/layout';

import HomePage from '@/pages/home';
import OnboardPage from '@/pages/onboard';
import PortraitPage from '@/pages/portrait';
import DivePage from '@/pages/dive';
import QueuePage from '@/pages/queue';
import MetricsPage from '@/pages/metrics';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/onboard" component={OnboardPage} />
        <Route path="/portrait" component={PortraitPage} />
        <Route path="/dive/:id" component={DivePage} />
        <Route path="/dive/:id/queue" component={QueuePage} />
        <Route path="/metrics" component={MetricsPage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
