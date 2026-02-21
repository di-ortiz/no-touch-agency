import PQueue from 'p-queue';

/**
 * API-specific rate limiters to respect platform limits.
 * Each limiter controls concurrency and interval between requests.
 */
const limiters = {
  anthropic: new PQueue({ concurrency: 5, interval: 1000, intervalCap: 5 }),
  meta: new PQueue({ concurrency: 3, interval: 1000, intervalCap: 3 }),
  googleAds: new PQueue({ concurrency: 3, interval: 1000, intervalCap: 3 }),
  tiktok: new PQueue({ concurrency: 2, interval: 1000, intervalCap: 2 }),
  twitter: new PQueue({ concurrency: 2, interval: 1000, intervalCap: 2 }),
  clickup: new PQueue({ concurrency: 5, interval: 1000, intervalCap: 5 }),
  hubspot: new PQueue({ concurrency: 5, interval: 1000, intervalCap: 5 }),
  whatsapp: new PQueue({ concurrency: 1, interval: 1000, intervalCap: 1 }),
  telegram: new PQueue({ concurrency: 1, interval: 1000, intervalCap: 1 }),
  google: new PQueue({ concurrency: 5, interval: 1000, intervalCap: 5 }),
  dataforseo: new PQueue({ concurrency: 3, interval: 1000, intervalCap: 3 }),
  pagespeed: new PQueue({ concurrency: 2, interval: 2000, intervalCap: 2 }),
  openai: new PQueue({ concurrency: 3, interval: 1000, intervalCap: 3 }),
  firecrawl: new PQueue({ concurrency: 3, interval: 1000, intervalCap: 3 }),
  gemini: new PQueue({ concurrency: 3, interval: 1000, intervalCap: 3 }),
  fal: new PQueue({ concurrency: 6, interval: 1000, intervalCap: 6 }),
};

/**
 * Execute a function through the appropriate rate limiter.
 * @param {string} platform - Platform key from limiters
 * @param {Function} fn - Async function to execute
 */
export function rateLimited(platform, fn) {
  const limiter = limiters[platform];
  if (!limiter) {
    throw new Error(`Unknown platform for rate limiting: ${platform}`);
  }
  return limiter.add(fn);
}

export default limiters;
