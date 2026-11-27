import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StaffAuthProvider } from '@dark/ui';
import '@dark/ui/styles.css';
import { App } from './App.js';

const qc = new QueryClient({ defaultOptions: { queries: { refetchInterval: 30_000, retry: 1 } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <StaffAuthProvider app="courier" roles={['courier']}>
        <App />
      </StaffAuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
