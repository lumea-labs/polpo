"use client";

import type { SessionsHostAdapter } from "../sessions/host.js";
import type { RunRow } from "../sessions/trace-normalize.js";
import { TraceTable } from "../sessions/trace-table.js";

export function SessionsView({
  projectId,
  host,
  initial = [],
}: {
  projectId: string;
  host: SessionsHostAdapter;
  initial?: RunRow[];
}) {
  const { PageBody } = host.components;

  return (
    <PageBody>
      <TraceTable projectId={projectId} initial={initial} host={host} />
    </PageBody>
  );
}

export default SessionsView;
