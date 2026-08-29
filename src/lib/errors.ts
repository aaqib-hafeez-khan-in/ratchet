/**
 * Every client-visible failure is an ApiError. The `code` is a stable,
 * machine-readable string that agents can branch on; `message` is safe to show.
 * Internal detail never crosses this boundary.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const errors = {
  unauthorized: (msg = 'Missing or invalid API key.') =>
    new ApiError(401, 'unauthorized', msg),
  forbidden: (msg = 'This key is not permitted to perform that action.', detail?: Record<string, unknown>) =>
    new ApiError(403, 'forbidden', msg, detail),
  notFound: (msg = 'Resource not found.') =>
    new ApiError(404, 'not_found', msg),
  conflict: (code: string, msg: string, detail?: Record<string, unknown>) =>
    new ApiError(409, code, msg, detail),
  invalid: (msg: string, detail?: Record<string, unknown>) =>
    new ApiError(400, 'invalid_request', msg, detail),
  payloadTooLarge: (msg: string) =>
    new ApiError(413, 'payload_too_large', msg),
  rateLimited: (msg = 'Rate limit exceeded.') =>
    new ApiError(429, 'rate_limited', msg),
  insufficientCredit: (detail?: Record<string, unknown>) =>
    new ApiError(402, 'insufficient_credit',
      'Workspace credit balance is too low to reserve this effect.', detail),
  internal: (msg = 'Internal error.') =>
    new ApiError(500, 'internal_error', msg),
} as const;
