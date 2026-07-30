export type MemoryContractErrorCode =
  | "invalid_item"
  | "invalid_scope"
  | "invalid_provenance"
  | "invalid_transition";

export class MemoryContractError extends TypeError {
  readonly code: MemoryContractErrorCode;
  readonly path?: string;

  constructor(
    message: string,
    code: MemoryContractErrorCode = "invalid_item",
    path?: string,
  ) {
    super(message);
    this.name = "MemoryContractError";
    this.code = code;
    this.path = path;
  }
}
