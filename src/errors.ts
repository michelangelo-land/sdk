/** Error thrown for non-2xx API responses — mirrors `#/components/schemas/Error` + `#/components/responses/*`. */
export class MichelangeloApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  /** Seconds from the `Retry-After` header, when the server sent one (429). */
  readonly retryAfter?: number;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryAfter?: number;
  }) {
    super(opts.message);
    this.name = "MichelangeloApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
    this.retryAfter = opts.retryAfter;
  }

  isUnauthorized(): boolean {
    return this.status === 401;
  }

  isRateLimited(): boolean {
    return this.status === 429;
  }

  isInsufficientCredits(): boolean {
    return this.status === 402;
  }
}

/** Error thrown for OAuth / session failures (no `code` from the API shape). */
export class MichelangeloAuthError extends Error {
  readonly causeCode?: string;

  constructor(message: string, causeCode?: string) {
    super(message);
    this.name = "MichelangeloAuthError";
    this.causeCode = causeCode;
  }
}
