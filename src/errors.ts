/** Error thrown for non-2xx API responses — mirrors `#/components/schemas/Error` + `#/components/responses/*`. */
export class MichelangeloApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.name = "MichelangeloApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
  }

  isUnauthorized(): boolean {
    return this.status === 401;
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
