export class BrainStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrainStoreError";
  }
}

export class BrainStoreValidationError extends BrainStoreError {
  constructor(message: string) {
    super(message);
    this.name = "BrainStoreValidationError";
  }
}

export class BrainStoreConflictError extends BrainStoreError {
  constructor(message: string) {
    super(message);
    this.name = "BrainStoreConflictError";
  }
}

export class BrainStoreAuthorizationError extends BrainStoreError {
  constructor(message = "Brain access denied") {
    super(message);
    this.name = "BrainStoreAuthorizationError";
  }
}

export class BrainIngestionError extends BrainStoreError {
  readonly code:
    | "access_denied"
    | "source_not_found"
    | "version_not_found"
    | "parser_not_found"
    | "empty_content"
    | "ingestion_failed";

  constructor(
    message: string,
    code: BrainIngestionError["code"] = "ingestion_failed",
    options?: ErrorOptions,
  ) {
    super(message);
    this.name = "BrainIngestionError";
    this.code = code;
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        configurable: true,
      });
    }
  }
}
