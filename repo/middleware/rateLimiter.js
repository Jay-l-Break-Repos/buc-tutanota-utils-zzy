/**
 * middleware/rateLimiter.js
 *
 * A lightweight, in-memory sliding-window rate limiter middleware.
 *
 * Design
 * ──────
 * For each unique key (default: client IP address) we maintain a list of
 * request timestamps within the current window.  On every request we:
 *   1. Drop timestamps that have fallen outside the window.
 *   2. Count the remaining timestamps.
 *   3. If the count is already at the limit → respond 429.
 *   4. Otherwise record the current timestamp and call next().
 *
 * This "sliding window log" approach is more accurate than a fixed-window
 * counter because it never allows a burst of 2× the limit at a window
 * boundary.
 *
 * Usage
 * ──────
 *   const { createRateLimiter } = require("./middleware/rateLimiter");
 *
 *   // Allow at most 10 requests per 60 000 ms (1 minute)
 *   const sendLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
 *
 *   router.post("/send", sendLimiter, handler);
 *
 * Response headers added on every request
 * ──────────────────────────────────────────
 *   X-RateLimit-Limit     — maximum requests allowed in the window
 *   X-RateLimit-Remaining — requests remaining in the current window
 *   X-RateLimit-Reset     — Unix epoch (seconds) when the oldest request
 *                           in the window expires and a slot opens up
 *
 * On 429 an additional header is set:
 *   Retry-After           — seconds until the oldest slot expires
 */

"use strict";

/**
 * Create a rate-limiter middleware.
 *
 * @param {Object}   [options]
 * @param {number}   [options.limit=10]       Max requests per window
 * @param {number}   [options.windowMs=60000] Window length in milliseconds
 * @param {Function} [options.keyFn]          Function(req) → string key
 *                                            Defaults to req.ip
 * @returns {Function} Express middleware (req, res, next)
 */
function createRateLimiter({
  limit = 10,
  windowMs = 60_000,
  keyFn = (req) => req.ip || "global",
} = {}) {
  /**
   * Map<key, number[]>
   * Each value is a sorted array of request timestamps (Date.now() values).
   */
  const store = new Map();

  /**
   * Periodically prune keys whose windows have fully expired so the store
   * does not grow unboundedly in long-running processes.
   */
  const pruneInterval = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of store.entries()) {
      // Remove all timestamps older than the window
      const fresh = timestamps.filter((t) => t > cutoff);
      if (fresh.length === 0) {
        store.delete(key);
      } else {
        store.set(key, fresh);
      }
    }
  }, windowMs);

  // Allow the Node.js process to exit even if this interval is still active.
  if (pruneInterval.unref) pruneInterval.unref();

  /**
   * The actual Express middleware function.
   */
  return function rateLimiterMiddleware(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    const cutoff = now - windowMs;

    // Retrieve (or initialise) the timestamp log for this key
    const timestamps = (store.get(key) || []).filter((t) => t > cutoff);

    const remaining = Math.max(0, limit - timestamps.length);

    // Compute when the oldest request in the window will expire
    const oldestTs = timestamps.length > 0 ? timestamps[0] : now;
    const resetEpochSeconds = Math.ceil((oldestTs + windowMs) / 1000);

    // Set informational headers on every response
    res.set("X-RateLimit-Limit", String(limit));
    res.set("X-RateLimit-Remaining", String(remaining));
    res.set("X-RateLimit-Reset", String(resetEpochSeconds));

    if (timestamps.length >= limit) {
      // Rate limit exceeded — compute Retry-After in whole seconds
      const retryAfterMs = oldestTs + windowMs - now;
      const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

      res.set("Retry-After", String(retryAfterSeconds));

      return res.status(429).json({
        error:
          "Too many requests. You have exceeded the limit of " +
          limit +
          " emails per minute. " +
          "Please wait " +
          retryAfterSeconds +
          " second(s) before trying again.",
        retryAfterSeconds,
      });
    }

    // Record this request and persist the updated log
    timestamps.push(now);
    store.set(key, timestamps);

    return next();
  };
}

module.exports = { createRateLimiter };
