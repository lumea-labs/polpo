import { createContext, createElement, useContext } from "react";
import type {
  AnchorHTMLAttributes,
  ComponentType,
  ReactNode,
} from "react";
import type { SessionsHostAdapter } from "../sessions/host.js";
import type { ModelSelection } from "@polpo-ai/sdk";

export type PlaygroundAgent = {
  name: string;
  model?: ModelSelection;
  assignedLoops?: string[];
  role?: string;
};

export type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  children: ReactNode;
};

export type PlaygroundTraceResource = {
  messages: unknown[];
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => unknown;
};

export interface PlaygroundHostAdapter {
  sessions: SessionsHostAdapter;
  showAvatars: boolean;
  logoSrc: string;
  data: {
    dataPlaneBaseUrl(projectId: string): string;
    useTrace(args: {
      projectId: string;
      sessionId: string | undefined;
      active: boolean;
    }): PlaygroundTraceResource;
  };
  navigation: {
    searchEntries(): Iterable<[string, string]>;
    replace(path: string, options?: { scroll?: boolean }): void;
  };
  routes: {
    projects(): string;
    agents(projectId: string): string;
    agent(projectId: string, agentName: string): string;
  };
  components: {
    Link: ComponentType<LinkProps>;
    Image: ComponentType<{
      src: string;
      alt: string;
      width: number;
      height: number;
      priority?: boolean;
      className?: string;
    }>;
    ProviderIcon: ComponentType<{
      provider: string;
      size: number;
      type: "mono";
      className?: string;
    }>;
    ChatAgentSelector: ComponentType<{
      agents: Array<{ name: string; role?: string }>;
      selected: string | undefined;
      onSelect: (name: string) => void;
      variant: "command";
      fallbackLabel: string;
      renderAvatar?: () => ReactNode;
      className?: string;
    }>;
    ChatLanding: ComponentType<{
      greeting: string;
      subtitle: string;
      inputPlaceholder: string;
      header: ReactNode;
    }>;
    PolpoChat: ComponentType<{
      baseUrl: string;
      agent: string | undefined;
      loop: string | undefined;
      onSession: (sessionId: string | undefined) => void;
      landing: ReactNode;
      composerControls: ReactNode;
      gutter: "none";
    }>;
    Select: ComponentType<{
      value: string;
      onValueChange: (value: string) => void;
      children: ReactNode;
    }>;
    SelectTrigger: ComponentType<{ className?: string; children: ReactNode }>;
    SelectContent: ComponentType<{ children: ReactNode }>;
    SelectItem: ComponentType<{ value: string; children: ReactNode }>;
    FilesBrowser: ComponentType<{ projectId: string; embedded?: boolean }>;
    RefreshButton: ComponentType<{ onClick: () => unknown; busy?: boolean }>;
  };
}

const PlaygroundHostContext = createContext<PlaygroundHostAdapter | null>(null);

export function PlaygroundHostProvider({
  host,
  children,
}: {
  host: PlaygroundHostAdapter;
  children: ReactNode;
}) {
  return createElement(PlaygroundHostContext.Provider, { value: host }, children);
}

export function usePlaygroundHost(): PlaygroundHostAdapter {
  const host = useContext(PlaygroundHostContext);
  if (!host) throw new Error("Playground v2 requires a PlaygroundHostAdapter");
  return host;
}
