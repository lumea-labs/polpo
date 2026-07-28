import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import {
  BrainIngestionError,
  BrainStoreAuthorizationError,
  BrainStoreValidationError,
  PlainTextBrainParser,
  brainScopeKey,
  createBrainSource,
  createBrainSourceVersion,
  ingestBrainSource,
  normalizeBrainAccessDecision,
  normalizeBrainSource,
  normalizeBrainScope,
  readBrainSource,
  retrieveBrain,
  type BrainAccessPolicy,
  type BrainChunkStore,
  type BrainManagementService,
  type BrainParser,
  type BrainReadSourceRequest,
  type BrainReindexSourceRequest,
  type BrainSearchRequest,
  type BrainServiceContext,
  type BrainSource,
  type BrainSourceContentInput,
  type BrainSourceListQuery,
  type BrainSourceListResult,
  type BrainSourceRef,
  type BrainSourceStore,
  type BrainSourceVersion,
  type BrainUpdateSourceRequest,
  type BrainVersionStore,
  type BrainCreateSourceRequest,
} from "@polpo-ai/core/brain";
import {
  NodeBrainContentLoader,
  type BrainContentInput,
  type BrainLoadedContent,
} from "./content-loader.js";
import { HtmlBrainParser } from "./html-parser.js";

export interface LocalBrainContentLoader {
  load(input: BrainContentInput): Promise<BrainLoadedContent>;
}

export interface LocalBrainServiceOptions {
  readonly sourceStore: BrainSourceStore;
  readonly versionStore: BrainVersionStore;
  readonly chunkStore: BrainChunkStore;
  readonly accessPolicy: BrainAccessPolicy;
  readonly contentLoader?: LocalBrainContentLoader;
  readonly parsers?: readonly BrainParser[];
  readonly now?: () => Date | string;
  readonly createVersionId?: () => string;
}

function sameScope(left: unknown, right: unknown): boolean {
  return brainScopeKey(normalizeBrainScope(left))
    === brainScopeKey(normalizeBrainScope(right));
}

function assertScope(
  requested: unknown,
  allowed: readonly unknown[],
  message: string,
): void {
  const scope = normalizeBrainScope(requested);
  if (!allowed.some((candidate) => sameScope(scope, candidate))) {
    throw new BrainStoreAuthorizationError(message);
  }
}

function timestamp(now: (() => Date | string) | undefined): string {
  const value = now?.() ?? new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new BrainStoreValidationError("Invalid Brain service timestamp");
  }
  return date.toISOString();
}

function sourceType(
  content: BrainSourceContentInput,
): Extract<BrainSource["type"], "paste" | "url" | "file" | "connection"> {
  return content.kind;
}

function localContent(
  content: BrainSourceContentInput,
): BrainContentInput {
  if (content.kind === "connection") {
    throw new BrainStoreValidationError(
      "Connection-backed Brain sources require a host ingestion adapter",
    );
  }
  return content;
}

function loadedMetadata(
  input: Record<string, unknown> | undefined,
  loaded: BrainLoadedContent,
): Record<string, unknown> {
  return {
    ...(input ?? {}),
    ...(loaded.citationUri ? { uri: loaded.citationUri } : {}),
    ...(loaded.fileName ? { fileName: loaded.fileName } : {}),
  };
}

export class LocalBrainService implements BrainManagementService {
  private readonly sourceStore: BrainSourceStore;
  private readonly versionStore: BrainVersionStore;
  private readonly chunkStore: BrainChunkStore;
  private readonly accessPolicy: BrainAccessPolicy;
  private readonly contentLoader: LocalBrainContentLoader;
  private readonly parsers: readonly BrainParser[];
  private readonly now?: () => Date | string;
  private readonly createVersionId: () => string;

  constructor(options: LocalBrainServiceOptions) {
    this.sourceStore = options.sourceStore;
    this.versionStore = options.versionStore;
    this.chunkStore = options.chunkStore;
    this.accessPolicy = options.accessPolicy;
    this.contentLoader = options.contentLoader ?? new NodeBrainContentLoader();
    this.parsers = options.parsers
      ?? [new HtmlBrainParser(), new PlainTextBrainParser()];
    this.now = options.now;
    this.createVersionId = options.createVersionId
      ?? (() => `v-${nanoid(16)}`);
  }

  private async authorize(
    action: "read" | "search" | "ingest" | "manage",
    source: BrainSource,
    context: BrainServiceContext,
  ): Promise<void> {
    try {
      const decision = normalizeBrainAccessDecision(
        await this.accessPolicy.authorize({
          action,
          source,
          actor: context.actor,
        }),
      );
      if (decision.allowed) return;
    } catch {
      // Policy failures are authorization failures.
    }
    throw new BrainStoreAuthorizationError("Brain access denied");
  }

  private assertReadScope(
    context: BrainServiceContext,
    ref: BrainSourceRef,
  ): void {
    assertScope(ref.scope, context.readScopes, "Brain read scope is not granted");
  }

  private assertWriteScope(
    context: BrainServiceContext,
    ref: BrainSourceRef,
  ): void {
    assertScope(ref.scope, context.writeScopes, "Brain write scope is not granted");
  }

  async listSources(
    context: BrainServiceContext,
    query: Omit<BrainSourceListQuery, "scopes"> & {
      readonly scopes?: readonly BrainSourceRef["scope"][];
    } = {},
  ): Promise<BrainSourceListResult> {
    const scopes = query.scopes ?? context.readScopes;
    if (scopes.length === 0) {
      throw new BrainStoreAuthorizationError("No Brain read scope is granted");
    }
    for (const scope of scopes) {
      assertScope(scope, context.readScopes, "Brain read scope is not granted");
    }
    const page = await this.sourceStore.listSources({
      ...query,
      scopes,
    });
    const visible: BrainSource[] = [];
    for (const source of page.sources) {
      try {
        await this.authorize("read", source, context);
        visible.push(source);
      } catch (error) {
        if (!(error instanceof BrainStoreAuthorizationError)) throw error;
      }
    }
    return Object.freeze({
      sources: Object.freeze(visible),
      ...(page.cursor ? { cursor: page.cursor } : {}),
    });
  }

  async createSource(
    context: BrainServiceContext,
    request: BrainCreateSourceRequest,
  ): Promise<BrainSource> {
    const scope = normalizeBrainScope(request.scope);
    this.assertWriteScope(context, { scope, sourceId: request.id ?? "pending" });
    const loaded = await this.contentLoader.load(localContent(request.content));
    const source = createBrainSource({
      ...(request.id ? { id: request.id } : {}),
      scope,
      type: sourceType(request.content),
      label: request.label,
      trust: request.trust,
      metadata: loadedMetadata(request.metadata, loaded),
    }, { now: this.now });
    await this.authorize("manage", source, context);

    const versionId = this.createVersionId();
    const bodyBytes = loaded.body.kind === "bytes"
      ? loaded.body.bytes
      : new TextEncoder().encode(loaded.body.text);
    const version = createBrainSourceVersion({
      sourceId: source.id,
      version: versionId,
      contentType: loaded.contentType,
      byteSize: loaded.byteSize,
      contentHash: createHash("sha256").update(bodyBytes).digest("hex"),
    }, { now: this.now });

    await this.sourceStore.createSource(source);
    try {
      await this.versionStore.createVersion(scope, version);
    } catch (error) {
      await this.sourceStore.deleteSource({
        scope,
        sourceId: source.id,
      }).catch(() => undefined);
      throw error;
    }
    return ingestBrainSource({
      ref: { scope, sourceId: source.id },
      version: versionId,
      body: loaded.body,
      contentType: loaded.contentType,
      actor: context.actor,
    }, {
      sourceStore: this.sourceStore,
      versionStore: this.versionStore,
      chunkStore: this.chunkStore,
      accessPolicy: this.accessPolicy,
      parsers: this.parsers,
      now: this.now,
    });
  }

  async getSource(
    context: BrainServiceContext,
    ref: BrainSourceRef,
  ): Promise<BrainSource | null> {
    this.assertReadScope(context, ref);
    const source = await this.sourceStore.getSource(ref);
    if (!source || source.status === "deleted") return null;
    await this.authorize("read", source, context);
    return source;
  }

  async updateSource(
    context: BrainServiceContext,
    ref: BrainSourceRef,
    request: BrainUpdateSourceRequest,
  ): Promise<BrainSource> {
    this.assertWriteScope(context, ref);
    const current = await this.sourceStore.getSource(ref);
    if (!current || current.status === "deleted") {
      throw new BrainIngestionError(
        "Brain source was not found",
        "source_not_found",
      );
    }
    await this.authorize("manage", current, context);
    const updated = normalizeBrainSource({
      ...current,
      ...(request.label === undefined ? {} : { label: request.label }),
      ...(request.trust === undefined ? {} : { trust: request.trust }),
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      updatedAt: timestamp(this.now),
    });
    return this.sourceStore.updateSource(updated, {
      expectedUpdatedAt: current.updatedAt,
    });
  }

  async deleteSource(
    context: BrainServiceContext,
    ref: BrainSourceRef,
  ): Promise<void> {
    this.assertWriteScope(context, ref);
    const source = await this.sourceStore.getSource(ref);
    if (!source || source.status === "deleted") return;
    await this.authorize("manage", source, context);
    await this.sourceStore.deleteSource(ref);
  }

  async reindexSource(
    context: BrainServiceContext,
    ref: BrainSourceRef,
    request: BrainReindexSourceRequest,
  ): Promise<BrainSource> {
    this.assertWriteScope(context, ref);
    const source = await this.sourceStore.getSource(ref);
    if (!source || source.status === "deleted") {
      throw new BrainIngestionError(
        "Brain source was not found",
        "source_not_found",
      );
    }
    await this.authorize("manage", source, context);
    const loaded = await this.contentLoader.load(localContent(request.content));
    const versionId = this.createVersionId();
    const bodyBytes = loaded.body.kind === "bytes"
      ? loaded.body.bytes
      : new TextEncoder().encode(loaded.body.text);
    await this.versionStore.createVersion(ref.scope, createBrainSourceVersion({
      sourceId: source.id,
      version: versionId,
      contentType: loaded.contentType,
      byteSize: loaded.byteSize,
      contentHash: createHash("sha256").update(bodyBytes).digest("hex"),
    }, { now: this.now }));
    return ingestBrainSource({
      ref,
      version: versionId,
      body: loaded.body,
      contentType: loaded.contentType,
      actor: context.actor,
    }, {
      sourceStore: this.sourceStore,
      versionStore: this.versionStore,
      chunkStore: this.chunkStore,
      accessPolicy: this.accessPolicy,
      parsers: this.parsers,
      now: this.now,
    });
  }

  async listVersions(
    context: BrainServiceContext,
    ref: BrainSourceRef,
  ): Promise<readonly BrainSourceVersion[]> {
    const source = await this.getSource(context, ref);
    if (!source) return [];
    return this.versionStore.listVersions(ref);
  }

  async search(
    context: BrainServiceContext,
    request: BrainSearchRequest,
  ) {
    const scopes = request.scopes ?? context.readScopes;
    if (scopes.length === 0) {
      throw new BrainStoreAuthorizationError("No Brain read scope is granted");
    }
    for (const scope of scopes) {
      assertScope(scope, context.readScopes, "Brain read scope is not granted");
    }
    return retrieveBrain({
      query: request.query,
      scopes,
      actor: context.actor,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.tokenBudget === undefined
        ? {}
        : { tokenBudget: request.tokenBudget }),
    }, {
      sourceStore: this.sourceStore,
      chunkStore: this.chunkStore,
      accessPolicy: this.accessPolicy,
    });
  }

  async readSource(
    context: BrainServiceContext,
    request: BrainReadSourceRequest,
  ) {
    this.assertReadScope(context, request.ref);
    return readBrainSource({
      ...request,
      actor: context.actor,
    }, {
      sourceStore: this.sourceStore,
      versionStore: this.versionStore,
      chunkStore: this.chunkStore,
      accessPolicy: this.accessPolicy,
    });
  }
}
