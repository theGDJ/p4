import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/600.css';
import '@fontsource/source-serif-4/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/noto-sans-devanagari/400.css';
import '@fontsource/noto-sans-devanagari/600.css';
import '@fontsource/noto-sans-devanagari/700.css';
import '@/index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '@/App';
import { SessionProvider } from '@/lib/auth';
import '@/i18n';

/**
 * Entry point.
 *
 * Fonts are self-hosted via @fontsource because §11 forbids third-party font CDNs —
 * a request to fonts.googleapis.com would leak user IPs and is also blocked in this
 * environment.
 *
 * Query defaults are deliberately conservative: nothing is refetched on window
 * focus, and retries are disabled for 4xx responses so an authorization failure is
 * never hammered three times (§8).
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const status = (error as { status?: number })?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
    mutations: { retry: false },
  },
});

const container = document.getElementById('root');
if (!container) {
  // Fail loudly rather than rendering nothing (R8).
  throw new Error('Root container #root not found — the HTML shell is missing.');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <App />
        </SessionProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);
