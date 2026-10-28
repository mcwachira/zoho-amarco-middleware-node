import type { RequestHandler } from "express";

export interface RateLimitOptions {
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly now?: () => number;
  readonly keyForRequest?: (request: Parameters<RequestHandler>[0]) => string;
  readonly maxTrackedKeys?: number;
}

interface WindowState {
  count: number;
  resetAt: number;
}

/**
 * Process-local fixed-window limiter for this single-instance local service.
 * Deployments with multiple API processes must use a shared rate-limit store
 * at the trusted reverse proxy.
 */
export function createRateLimitMiddleware({
  windowMs,
  maxRequests,
  now = Date.now,
  keyForRequest = (request) => request.ip || request.socket.remoteAddress || "unknown",
  maxTrackedKeys = 10_000,
}: RateLimitOptions): RequestHandler {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new Error("Rate-limit window must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) {
    throw new Error("Rate-limit maximum must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxTrackedKeys) || maxTrackedKeys <= 0) {
    throw new Error("Rate-limit key capacity must be a positive integer.");
  }

  const windows = new Map<string, WindowState>();

  return (request, response, next) => {
    const timestamp = now();
    const key = keyForRequest(request);
    let state = windows.get(key);

    if (!state || state.resetAt <= timestamp) {
      if (state) windows.delete(key);
      if (windows.size >= maxTrackedKeys) {
        for (const [trackedKey, trackedState] of windows) {
          if (trackedState.resetAt <= timestamp) windows.delete(trackedKey);
        }
      }
      if (windows.size >= maxTrackedKeys) {
        response.status(503).json({
          error: {
            code: "RATE_LIMIT_CAPACITY_REACHED",
            message: "Request protection is temporarily unavailable.",
          },
        });
        return;
      }
      state = { count: 0, resetAt: timestamp + windowMs };
      windows.set(key, state);
    }

    state.count += 1;
    const remaining = Math.max(0, maxRequests - state.count);
    response.setHeader("RateLimit-Limit", String(maxRequests));
    response.setHeader("RateLimit-Remaining", String(remaining));
    response.setHeader("RateLimit-Reset", String(Math.ceil(state.resetAt / 1000)));

    if (state.count > maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((state.resetAt - timestamp) / 1000));
      response.setHeader("Retry-After", String(retryAfterSeconds));
      response.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests. Retry after the indicated delay.",
        },
      });
      return;
    }

    next();
  };
}
