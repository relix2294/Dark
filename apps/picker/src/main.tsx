import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StaffAuthProvider } from '@dark/ui';
import '@dark/ui/styles.css';
import { App } from './App.js';

// Терминал работает без связи (ТЗ §7): react-query не должен ставить действия на паузу при offline —
// очередью управляет useOfflineQueue, а запросы при обрыве отдают последнее известное задание.
const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, networkMode: 'offlineFirst' }, mutations: { networkMode: 'always' } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <StaffAuthProvider app="picker" roles={['picker', 'shift_lead', 'manager']}>
        <App />
      </StaffAuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
