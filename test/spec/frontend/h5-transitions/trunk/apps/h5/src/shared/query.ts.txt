import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { AccountChangedError } from './api/app-api.ts';

export { useQueryClient } from '@tanstack/react-query';

/** Account generation per client, bumped by clearAccountData. */
const generations = new WeakMap<QueryClient, { current: number }>();

/**
 * Every query function is bound to the account generation in which its options were set (the
 * render of the page that owns the query). Once the account changes, a query function from an
 * earlier generation never runs again: a page taken down by the switch may still hold its
 * observer and call refetch() later (e.g. a refresh queued behind a cancelled next-page fetch),
 * and that call must not ask native for a token or send anything. Pages rendered after the
 * switch, and imperative callers, get options of the current generation and fetch as usual.
 */
function bindToGeneration(client: QueryClient, generation: { current: number }): void {
  const defaults = client.defaultQueryOptions.bind(client);
  client.defaultQueryOptions = ((options: Parameters<typeof defaults>[0]) => {
    if (options._defaulted === true) return defaults(options);
    const defaulted = defaults(options);
    const queryFn = defaulted.queryFn;
    if (typeof queryFn !== 'function') return defaulted;
    const bound = generation.current;
    return {
      ...defaulted,
      queryFn: (context: Parameters<typeof queryFn>[0]) =>
        generation.current === bound ? queryFn(context) : Promise.reject(new AccountChangedError()),
    };
  }) as typeof client.defaultQueryOptions;
}

/** One client per mounted shell; nothing is shared between entries or pages loaded twice. */
export function createQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      // No blind retries: the API client owns the single token replay, pages act on ApiError.action.
      mutations: { retry: false },
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
  const generation = { current: 0 };
  generations.set(client, generation);
  bindToGeneration(client, generation);
  return client;
}

export function createQueryProvider(children: ReactNode, client: QueryClient): ReactElement {
  return createElement(QueryClientProvider, { client }, children);
}

/**
 * Account switch or logout: retire the current query generation (query functions bound to it no
 * longer run), cancel every query (a response that arrives later is dropped by its cancelled
 * fetch), then clear all queries and mutations, active or not.
 */
export function clearAccountData(client: QueryClient): void {
  const generation = generations.get(client);
  if (generation !== undefined) generation.current += 1;
  void client.cancelQueries();
  client.clear();
}
