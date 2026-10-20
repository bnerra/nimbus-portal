import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element in index.html');

// One QueryClient for the whole app: it owns the cache of server data.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retry a failed request once (the default is 3, which makes an
      // "API is down" message take several seconds to appear).
      retry: 1,
    },
  },
});

// StrictMode runs extra checks in development (including running effects
// twice) to surface bugs like missing cleanup. It does nothing in production.
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      {/* Floating panel (bottom corner) showing every query and its cache
          state. Only rendered in development builds. */}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  </StrictMode>,
);
