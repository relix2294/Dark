import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StaffAuthProvider } from '@dark/ui';
import '@dark/ui/styles.css';
import { App } from './App.js';

// без связи мутации не ставятся на паузу: нажатие уходит в собственную очередь с временем нажатия (ТЗ §11)
const qc = new QueryClient({ defaultOptions: { queries: { refetchInterval: 30_000, retry: 1, networkMode: 'offlineFirst' }, mutations: { networkMode: 'always' } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <StaffAuthProvider app="kds" heartbeat="kds" roles={['cook', 'shift_lead', 'manager']}>
        <App />
      </StaffAuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
