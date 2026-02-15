/**
 * Unit tests for the rate limiter utility.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { rateLimited } = await import('../../src/utils/rate-limiter.js');

describe('Rate Limiter', () => {
  it('executes a function through the limiter', async () => {
    const result = await rateLimited('meta', async () => 'done');
    assert.equal(result, 'done');
  });

  it('supports all expected platform keys', async () => {
    const platforms = ['anthropic', 'meta', 'googleAds', 'tiktok', 'twitter', 'clickup', 'hubspot', 'whatsapp', 'google'];
    for (const platform of platforms) {
      const result = await rateLimited(platform, async () => platform);
      assert.equal(result, platform);
    }
  });

  it('throws for an unknown platform', async () => {
    assert.throws(
      () => rateLimited('unknown-platform', async () => {}),
      { message: /Unknown platform/ }
    );
  });

  it('passes through function return values', async () => {
    const obj = { key: 'value', nested: { a: 1 } };
    const result = await rateLimited('anthropic', async () => obj);
    assert.deepEqual(result, obj);
  });

  it('passes through function errors', async () => {
    await assert.rejects(
      () => rateLimited('meta', async () => { throw new Error('API error'); }),
      { message: 'API error' }
    );
  });
});
