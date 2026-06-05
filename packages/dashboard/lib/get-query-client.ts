import { QueryClient } from "@tanstack/react-query";
import { cache } from "react";

/**
 * Request-scoped QueryClient singleton for Server Components.
 * React's cache() ensures one QueryClient per server request,
 * preventing cross-request data leakage.
 *
 * Usage: call getQueryClient() in Server Components to prefetch queries,
 * then wrap children in <HydrationBoundary state={dehydrate(queryClient)}>.
 */
const getQueryClient = cache(
  () =>
    new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          refetchOnWindowFocus: true,
          retry: 1,
        },
      },
    })
);

export default getQueryClient;
