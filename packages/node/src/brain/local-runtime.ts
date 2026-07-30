import { basename, join, resolve } from "node:path";
import {
  brainScopeKey,
  normalizeBrainScope,
  type BrainAccessPolicy,
  type BrainActorContext,
  type BrainManagementService,
  type BrainScope,
  type BrainServiceContext,
} from "@polpo-ai/core/brain";
import { FileBrainStore } from "./file-store.js";
import { LocalBrainService } from "./local-service.js";
import { NodeBrainContentLoader } from "./content-loader.js";

export interface LocalBrainRuntime {
  readonly scope: BrainScope;
  readonly service: BrainManagementService;
  context(input?: LocalBrainContextInput): BrainServiceContext;
}

export interface LocalBrainContextInput {
  readonly actor?: BrainActorContext["actor"];
  readonly actorId?: string;
  readonly agentName?: string;
  readonly externalUserId?: string;
  readonly channelId?: string;
  readonly sessionId?: string;
}

export interface CreateLocalBrainRuntimeOptions {
  readonly workDir: string;
  readonly polpoDir: string;
  readonly scopeId?: string;
}

export function createLocalBrainRuntime(
  options: CreateLocalBrainRuntimeOptions,
): LocalBrainRuntime {
  const workDir = resolve(options.workDir);
  const scope = normalizeBrainScope({
    kind: "project",
    subjectId: options.scopeId?.trim() || basename(workDir) || "local-project",
  });
  const store = new FileBrainStore(join(options.polpoDir, "brain.json"));
  const policy: BrainAccessPolicy = {
    authorize: ({ source, actor }) => ({
      allowed:
        source.scope.kind === "project"
        && actor.projectId === source.scope.subjectId
        && brainScopeKey(source.scope) === brainScopeKey(scope),
      reason: "local-project-scope",
      matchedScope: scope,
    }),
  };
  const service = new LocalBrainService({
    sourceStore: store,
    versionStore: store,
    chunkStore: store,
    accessPolicy: policy,
    contentLoader: new NodeBrainContentLoader({
      allowedFileRoots: [workDir],
    }),
  });

  return Object.freeze({
    scope,
    service,
    context(input: LocalBrainContextInput = {}) {
      const actor: BrainActorContext = Object.freeze({
        actor: input.actor ?? (input.agentName ? "agent" : "user"),
        actorId: input.actorId ?? input.agentName ?? "local-user",
        projectId: scope.subjectId,
        ...(input.agentName ? { agentName: input.agentName } : {}),
        ...(input.externalUserId
          ? { externalUserId: input.externalUserId }
          : {}),
        ...(input.channelId ? { channelId: input.channelId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
      return Object.freeze({
        actor,
        readScopes: Object.freeze([scope]),
        writeScopes: Object.freeze([scope]),
        defaultWriteScope: scope,
      });
    },
  });
}
