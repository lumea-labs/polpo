export type BrainContractErrorCode =
  | "invalid_access_decision"
  | "invalid_chunk"
  | "invalid_citation"
  | "invalid_ingestion_job"
  | "invalid_metadata"
  | "invalid_retrieval_result"
  | "invalid_scope"
  | "invalid_source"
  | "invalid_transition"
  | "invalid_version";

export class BrainContractError extends TypeError {
  readonly code: BrainContractErrorCode;
  readonly path?: string;

  constructor(
    message: string,
    code: BrainContractErrorCode,
    path?: string,
  ) {
    super(message);
    this.name = "BrainContractError";
    this.code = code;
    this.path = path;
  }
}
