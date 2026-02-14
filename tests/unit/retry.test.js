/**
 * Unit tests for the retry utility.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { retry, sleep, isRetryableHttpError } = await import('../../src/utils/retry.js');

describe('Retry Utility', () => {
  // ------------------------------------------------------------------
  // retry
  // ------------------------------------------------------------------
  describe('retry', () => {
    it('returns on first successful attempt', async () => {
      let attempts = 0;
      const result = await retry(async () => {
        attempts++;
        return 'success';
      }, { retries: 3, baseDelay: 1 });

      assert.equal(result, 'success');
      assert.equal(attempts, 1);
    });

    it('retries on failure and succeeds', async () => {
      let attempts = 0;
      const result = await retry(async () => {
        attempts++;
        if (attempts < 3) throw new Error('fail');
        return 'recovered';
      }, { retries: 3, baseDelay: 1 });

      assert.equal(result, 'recovered');
      assert.equal(attempts, 3);
    });

    it('throws after exhausting all retries', async () => {
      let attempts = 0;
      await assert.rejects(
        () => retry(async () => {
          attempts++;
          throw new Error('persistent failure');
        }, { retries: 2, baseDelay: 1 }),
        { message: 'persistent failure' }
      );
      assert.equal(attempts, 3); // initial + 2 retries
    });

    it('respects the shouldRetry predicate', async () => {
      let attempts = 0;
      await assert.rejects(
        () => retry(async () => {
          attempts++;
          throw new Error('non-retryable');
        }, {
          retries: 3,
          baseDelay: 1,
          shouldRetry: () => false,
        }),
        { message: 'non-retryable' }
      );
      assert.equal(attempts, 1, 'Should not retry when shouldRetry returns false');
    });

    it('passes attempt number to the function', async () => {
      const attempts = [];
      await retry(async (attempt) => {
        attempts.push(attempt);
        if (attempt < 2) throw new Error('fail');
        return 'done';
      }, { retries: 3, baseDelay: 1 });

      assert.deepEqual(attempts, [0, 1, 2]);
    });
  });

  // ------------------------------------------------------------------
  // sleep
  // ------------------------------------------------------------------
  describe('sleep', () => {
    it('resolves after the specified duration', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 40, `Expected at least 40ms but got ${elapsed}ms`);
    });
  });

  // ------------------------------------------------------------------
  // isRetryableHttpError
  // ------------------------------------------------------------------
  describe('isRetryableHttpError', () => {
    it('returns true for network errors (no response)', () => {
      assert.equal(isRetryableHttpError(new Error('ECONNRESET')), true);
    });

    it('returns true for 429 (rate limit)', () => {
      assert.equal(isRetryableHttpError({ response: { status: 429 } }), true);
    });

    it('returns true for 500+ (server errors)', () => {
      assert.equal(isRetryableHttpError({ response: { status: 500 } }), true);
      assert.equal(isRetryableHttpError({ response: { status: 502 } }), true);
      assert.equal(isRetryableHttpError({ response: { status: 503 } }), true);
    });

    it('returns false for 400 (client error)', () => {
      assert.equal(isRetryableHttpError({ response: { status: 400 } }), false);
    });

    it('returns false for 401 (unauthorized)', () => {
      assert.equal(isRetryableHttpError({ response: { status: 401 } }), false);
    });

    it('returns false for 403 (forbidden)', () => {
      assert.equal(isRetryableHttpError({ response: { status: 403 } }), false);
    });

    it('returns false for 404 (not found)', () => {
      assert.equal(isRetryableHttpError({ response: { status: 404 } }), false);
    });
  });
});
