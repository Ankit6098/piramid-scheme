'use client';

import { useState, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';

import { makeQueryClient } from '@/lib/query-client';

/** One QueryClient per browser tab (and per server render). Defaults: see `makeQueryClient()`. */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
