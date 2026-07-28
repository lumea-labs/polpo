import type {
  BrainAccessDecision,
  BrainAccessRequest,
  BrainEmbeddingRequest,
  BrainEmbeddingResult,
  BrainParserInput,
  BrainParserResult,
  BrainRerankRequest,
  BrainRetrievalResult,
  BrainTrustDecision,
  BrainTrustRequest,
} from "./types.js";

export interface BrainAccessPolicy {
  authorize(
    request: BrainAccessRequest,
  ): BrainAccessDecision | Promise<BrainAccessDecision>;
}

export interface BrainTrustPolicy {
  classify(
    request: BrainTrustRequest,
  ): BrainTrustDecision | Promise<BrainTrustDecision>;
}

export interface BrainParser {
  supports(contentType: string | undefined): boolean;
  parse(input: BrainParserInput): Promise<BrainParserResult>;
}

export interface BrainEmbeddingProvider {
  embed(request: BrainEmbeddingRequest): Promise<BrainEmbeddingResult>;
}

export interface BrainReranker {
  rerank(request: BrainRerankRequest): Promise<readonly BrainRetrievalResult[]>;
}
