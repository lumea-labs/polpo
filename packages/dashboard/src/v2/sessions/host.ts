import type {
  AnchorHTMLAttributes,
  ComponentType,
  ReactNode,
} from "react";
import { createContext, createElement, useContext } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { RunRow } from "./trace-normalize.js";

export type ColumnMeta = {
  align?: "left" | "right" | "center";
  width?: number;
  cellClassName?: string;
  hideOnMobile?: boolean;
};

export type DataTableProps<T> = {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  getRowId?: (row: T) => string;
  rowHref?: (row: T) => string;
  rowOnClick?: (row: T) => void;
  isRowExpanded?: (row: T) => boolean;
  renderExpandedRow?: (row: T) => ReactNode;
  initialSorting?: Array<{ id: string; desc: boolean }>;
  searchPlaceholder?: string;
  searchFn?: (row: T, query: string) => boolean;
  filters?: ReactNode;
  rightSlot?: ReactNode;
  pageSize?: number;
  empty?: ReactNode;
  emptyFiltered?: ReactNode;
};

export type DataTableComponent = <T>(props: DataTableProps<T>) => ReactNode;

export type MultiSelectFilterComponent = <T extends string>(props: {
  allLabel: string;
  options: Array<{ value: T; label: string }>;
  selected: T[];
  onToggle: (value: T) => void;
  onClear: () => void;
}) => ReactNode;

export type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  children: ReactNode;
};

export type AsyncResource<T> = {
  data: T | undefined;
  error?: Error | null;
  isLoading: boolean;
  isFetching?: boolean;
  refetch: () => unknown;
};

export type LoopRun = {
  id: string;
  loopName?: string;
  agentName?: string;
  status?: string;
  startedAt?: string;
  error?: string;
  trace?: unknown[];
};

export type ChatRun = {
  session?: { title?: string; agent?: string };
  messages?: unknown[];
};

export type Task = {
  id: string;
  title?: string;
  status?: string;
  assignTo?: string;
  loop?: string;
  createdAt?: string;
  result?: {
    output?: unknown;
    content?: unknown;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    duration?: number;
  };
};

export type TaskRun = {
  id?: string;
  status?: string;
  engine?: string;
  delivery?: string;
  executionMode?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  result?: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    duration?: number;
  };
};

export type TaskActivity = {
  task?: Task | null;
  run?: TaskRun | null;
  entries?: unknown[];
};

export interface SessionsDataAdapter {
  useRuns(args: {
    projectId: string;
    initial: RunRow[];
  }): AsyncResource<RunRow[]>;
  useLoopRun(projectId: string, runId: string): AsyncResource<LoopRun | null>;
  useChatRun(projectId: string, sessionId: string): AsyncResource<ChatRun>;
  useTaskRun(projectId: string, taskId: string): AsyncResource<TaskActivity>;
}

export interface SessionsHostAdapter {
  data: SessionsDataAdapter;
  routes: {
    sessions(projectId: string): string;
    run(projectId: string, runId: string): string;
    loop(projectId: string, loopName: string): string;
  };
  notFound(): ReactNode;
  components: {
    Link: ComponentType<LinkProps>;
    PageBody: ComponentType<{ children: ReactNode }>;
    PageHeader: ComponentType<{ title: ReactNode; description?: ReactNode }>;
    DataTable: DataTableComponent;
    RefreshButton: ComponentType<{ onClick: () => unknown; busy?: boolean }>;
    RouteRefreshButton: ComponentType<{ onClick?: () => unknown }>;
    MultiSelectFilter: MultiSelectFilterComponent;
    Markdown: ComponentType<{ content: string }>;
    CodeBlock: ComponentType<{
      code: string;
      lang: string;
      bare?: boolean;
      wrap?: boolean;
      showCopy?: boolean;
      maxHeightClass?: string;
      className?: string;
    }>;
    CopyButton: ComponentType<{ text: string; label: string }>;
    RunDetailLoading?: ComponentType<{ kind: string; id: string }>;
  };
}

const SessionsHostContext = createContext<SessionsHostAdapter | null>(null);

export function SessionsHostProvider({
  host,
  children,
}: {
  host: SessionsHostAdapter;
  children: ReactNode;
}) {
  return createElement(SessionsHostContext.Provider, { value: host }, children);
}

export function useSessionsHost(): SessionsHostAdapter {
  const host = useContext(SessionsHostContext);
  if (!host) throw new Error("Sessions v2 requires a SessionsHostAdapter");
  return host;
}
