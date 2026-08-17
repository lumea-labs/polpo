export class ChannelManagementError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    status = 400,
    retryable = false,
    details?: unknown,
  ) {
    super(message);
    this.name = "ChannelManagementError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

export function channelSetupError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof ChannelManagementError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "CHANNEL_SETUP_FAILED",
    message: "Channel setup failed",
    retryable: false,
  };
}
