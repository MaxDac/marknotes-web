export interface SyncFailure {
  kind: "transient" | "authentication" | "permanent";
  retryAt?: number;
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly failure: SyncFailure,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ReconnectRequired extends SyncError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, { kind: "authentication" }, options);
  }
}

export function syncFailure(error: unknown): SyncFailure {
  return error instanceof SyncError ? error.failure : { kind: "permanent" };
}
