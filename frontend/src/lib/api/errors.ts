// Backend error shape: { error: { code, message } }.
export type ErrorCode =
  | "sold_out"
  | "hold_expired"
  | "already_ordered"
  | "unauthorized"
  | "invalid_otp"
  | "rate_limited"
  | "not_found"
  | "network"
  | (string & {});

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status = 0,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorCode(err: unknown): ErrorCode | null {
  return err instanceof ApiError ? err.code : null;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong. Try again.";
}
