export type BrainContentLoadErrorCode =
  | "empty_content"
  | "content_too_large"
  | "file_outside_root"
  | "unsupported_file"
  | "unsupported_mime"
  | "unsafe_url"
  | "too_many_redirects"
  | "fetch_failed";

export class BrainContentLoadError extends Error {
  readonly code: BrainContentLoadErrorCode;

  constructor(
    message: string,
    code: BrainContentLoadErrorCode,
    options?: ErrorOptions,
  ) {
    super(message);
    this.name = "BrainContentLoadError";
    this.code = code;
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        configurable: true,
      });
    }
  }
}

export class FileBrainStoreCorruptionError extends Error {
  constructor(message = "Durable Brain state is corrupted", options?: ErrorOptions) {
    super(message);
    this.name = "FileBrainStoreCorruptionError";
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        configurable: true,
      });
    }
  }
}
