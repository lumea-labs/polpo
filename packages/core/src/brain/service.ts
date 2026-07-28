import type {
  BrainActorContext,
  BrainRetrievalResult,
  BrainScope,
  BrainSource,
  BrainSourceListQuery,
  BrainSourceListResult,
  BrainSourceRef,
  BrainSourceVersion,
  BrainTrustLevel,
} from "./types.js";
import type { ReadBrainSourceResult } from "./reading.js";

export type BrainSourceContentInput =
  | {
      readonly kind: "paste";
      readonly text: string;
      readonly contentType?: string;
    }
  | {
      readonly kind: "file";
      readonly path: string;
    }
  | {
      readonly kind: "url";
      readonly url: string;
    }
  | {
      readonly kind: "connection";
      readonly connectionId: string;
      readonly locator?: string;
    };

export interface BrainServiceContext {
  readonly actor: BrainActorContext;
  readonly readScopes: readonly BrainScope[];
  readonly writeScopes: readonly BrainScope[];
  readonly defaultWriteScope?: BrainScope;
}

export interface BrainCreateSourceRequest {
  readonly scope: BrainScope;
  readonly id?: string;
  readonly label: string;
  readonly trust: BrainTrustLevel;
  readonly metadata?: Record<string, unknown>;
  readonly content: BrainSourceContentInput;
}

export interface BrainUpdateSourceRequest {
  readonly label?: string;
  readonly trust?: BrainTrustLevel;
  readonly metadata?: Record<string, unknown>;
}

export interface BrainReindexSourceRequest {
  readonly content: BrainSourceContentInput;
}

export interface BrainSearchRequest {
  readonly query: string;
  readonly scopes?: readonly BrainScope[];
  readonly limit?: number;
  readonly tokenBudget?: number;
}

export interface BrainReadSourceRequest {
  readonly ref: BrainSourceRef;
  readonly version?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly tokenBudget?: number;
}

export interface BrainReadService {
  search(
    context: BrainServiceContext,
    request: BrainSearchRequest,
  ): Promise<readonly BrainRetrievalResult[]>;
  readSource(
    context: BrainServiceContext,
    request: BrainReadSourceRequest,
  ): Promise<ReadBrainSourceResult>;
}

export interface BrainManagementService extends BrainReadService {
  listSources(
    context: BrainServiceContext,
    query?: Omit<BrainSourceListQuery, "scopes"> & {
      readonly scopes?: readonly BrainScope[];
    },
  ): Promise<BrainSourceListResult>;
  createSource(
    context: BrainServiceContext,
    request: BrainCreateSourceRequest,
  ): Promise<BrainSource>;
  getSource(
    context: BrainServiceContext,
    ref: BrainSourceRef,
  ): Promise<BrainSource | null>;
  updateSource(
    context: BrainServiceContext,
    ref: BrainSourceRef,
    request: BrainUpdateSourceRequest,
  ): Promise<BrainSource>;
  deleteSource(
    context: BrainServiceContext,
    ref: BrainSourceRef,
  ): Promise<void>;
  reindexSource(
    context: BrainServiceContext,
    ref: BrainSourceRef,
    request: BrainReindexSourceRequest,
  ): Promise<BrainSource>;
  listVersions(
    context: BrainServiceContext,
    ref: BrainSourceRef,
  ): Promise<readonly BrainSourceVersion[]>;
}
