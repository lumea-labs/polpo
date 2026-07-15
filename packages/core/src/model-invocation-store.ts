import type {
  ModelInvocationRecord,
  ModelInvocationStatus,
  ModelOperation,
  ModelRuntimeMode,
} from "./model-runtime.js";

export interface ModelInvocationListFilter {
  projectId?: string;
  orgId?: string;
  runId?: string;
  sessionId?: string;
  agentName?: string;
  mode?: ModelRuntimeMode;
  operation?: ModelOperation;
  status?: ModelInvocationStatus;
  limit?: number;
}

export interface ModelInvocationStore {
  append(record: ModelInvocationRecord): Promise<ModelInvocationRecord>;
  get(id: string): Promise<ModelInvocationRecord | undefined>;
  list(filter?: ModelInvocationListFilter): Promise<ModelInvocationRecord[]>;
  close(): Promise<void> | void;
}
