import logger from './logger.js';

/**
 * Retry a function with exponential backoff.
 * @param {Function} fn - Async function to retry
 * @param {object} opts
 * @param {number} opts.retries - Max retries (default 3)
 * @param {number} opts.baseDelay - Base delay in ms (default 1000)
 * @param {string} opts.label - Label for logging
 * @param {Function} opts.shouldRetry - Predicate to decide if error is retryable
 */
export async function retry(fn, opts = {}) {
  const {
    retries = 3,
    baseDelay = 1000,
    label = 'operation',
    shouldRetry = () => true,
  } = opts;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetry(error)) {
        break;
      }
      // Use longer delay for rate limits (429) since they're per-minute
      const isRateLimit = error.status === 429 || error.message?.includes('rate_limit');
      const effectiveBase = isRateLimit ? Math.max(baseDelay, 15000) : baseDelay;
      const delay = effectiveBase * Math.pow(2, attempt);
      logger.warn(`${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms`, {
        error: error.message,
        isRateLimit,
      });
      await sleep(delay);
    }
  }
  throw lastError;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an HTTP error is retryable (network errors, 429, 5xx).
 */
export function isRetryableHttpError(error) {
  const status = error.status || error.response?.status;
  if (status) return status === 429 || status >= 500;
  return !error.response; // network error (no response at all)
}
