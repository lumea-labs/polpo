export class MemoryAuthorizationError extends Error {
  constructor(message = "Memory scope is not authorized") {
    super(message);
    this.name = "MemoryAuthorizationError";
  }
}

export class MemoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryConflictError";
  }
}

export class MemoryPolicyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryPolicyError";
  }
}
