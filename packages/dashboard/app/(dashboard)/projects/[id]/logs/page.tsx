import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import getQueryClient from "../../../../../lib/get-query-client";
import { dataApi } from "../../../../../lib/api";
import LogsView from "./view";

export default async function LogsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const queryClient = getQueryClient();

  await queryClient.prefetchQuery({
    queryKey: ["log-sessions", id],
    queryFn: () =>
      dataApi<{ ok: boolean; data: unknown[] }>(id, "/v1/logs").then(
        (r) => r.data ?? []
      ),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <LogsView />
    </HydrationBoundary>
  );
}
