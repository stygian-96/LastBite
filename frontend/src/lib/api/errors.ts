// Backend error shape: { error: { code, message, ...details } }.
export type ErrorDetails = {
  existingOrderId?: string;
  collectedAt?: string;
  fixes?: { code: string; message: string }[];
  /** over_limit: the vendor's limit per order. */
  maxPerOrder?: number;
  /** not_enough_left: the most this order can have. */
  remaining?: number;
};

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public details: ErrorDetails = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorCode(err: unknown): string | null {
  return err instanceof ApiError ? err.code : null;
}

export function errorStatus(err: unknown): number | null {
  return err instanceof ApiError ? err.status : null;
}

export function errorDetails(err: unknown): ErrorDetails {
  return err instanceof ApiError ? err.details : {};
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong. Try again.";
}
