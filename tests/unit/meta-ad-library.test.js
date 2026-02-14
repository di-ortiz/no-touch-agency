/**
 * Unit tests for the Meta Ad Library API module.
 * Tests parsing and formatting functions (no HTTP calls).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { parseAdLibraryResults, formatAdsForWhatsApp } =
  await import('../../src/api/meta-ad-library.js');

describe('Meta Ad Library', () => {
  // ------------------------------------------------------------------
  // parseAdLibraryResults
  // ------------------------------------------------------------------
  describe('parseAdLibraryResults', () => {
    it('returns empty array for null/empty data', () => {
      assert.deepEqual(parseAdLibraryResults(null), []);
      assert.deepEqual(parseAdLibraryResults({}), []);
      assert.deepEqual(parseAdLibraryResults({ data: [] }), []);
    });

    it('parses a single ad with all fields', () => {
      const raw = {
        data: [{
          id: '123',
          page_name: 'Nike',
          page_id: 'page_456',
          ad_creation_time: '2025-01-15T10:00:00',
          ad_delivery_start_time: '2025-01-16T00:00:00',
          ad_delivery_stop_time: null,
          ad_creative_link_titles: ['Just Do It Sale'],
          ad_creative_bodies: ['Get 30% off all running shoes this weekend only.'],
          ad_creative_link_descriptions: ['Shop the collection'],
          ad_creative_link_captions: ['nike.com'],
          publisher_platforms: ['facebook', 'instagram'],
          ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=123',
          estimated_audience_size: { lower_bound: 100000, upper_bound: 500000 },
          impressions: { lower_bound: 1000, upper_bound: 5000 },
          spend: { lower_bound: 100, upper_bound: 500 },
          currency: 'USD',
        }],
      };

      const result = parseAdLibraryResults(raw);
      assert.equal(result.length, 1);

      const ad = result[0];
      assert.equal(ad.id, '123');
      assert.equal(ad.pageName, 'Nike');
      assert.equal(ad.pageId, 'page_456');
      assert.equal(ad.headline, 'Just Do It Sale');
      assert.equal(ad.body, 'Get 30% off all running shoes this weekend only.');
      assert.equal(ad.description, 'Shop the collection');
      assert.equal(ad.caption, 'nike.com');
      assert.ok(ad.isActive);
      assert.deepEqual(ad.platforms, ['facebook', 'instagram']);
      assert.ok(ad.snapshotUrl);
    });

    it('handles ads with missing optional fields', () => {
      const raw = {
        data: [{
          id: '789',
          page_name: 'Unknown Brand',
          page_id: 'page_000',
        }],
      };

      const result = parseAdLibraryResults(raw);
      assert.equal(result.length, 1);
      assert.equal(result[0].headline, '');
      assert.equal(result[0].body, '');
      assert.deepEqual(result[0].platforms, []);
    });

    it('marks inactive ads correctly', () => {
      const raw = {
        data: [{
          id: '101',
          page_name: 'Test',
          page_id: 'p1',
          ad_delivery_stop_time: '2025-01-20T00:00:00',
        }],
      };

      const result = parseAdLibraryResults(raw);
      assert.equal(result[0].isActive, false);
    });

    it('parses multiple ads', () => {
      const raw = {
        data: [
          { id: '1', page_name: 'A', page_id: 'pa' },
          { id: '2', page_name: 'B', page_id: 'pb' },
          { id: '3', page_name: 'C', page_id: 'pc' },
        ],
      };

      const result = parseAdLibraryResults(raw);
      assert.equal(result.length, 3);
    });

    it('stores all headline and body variations', () => {
      const raw = {
        data: [{
          id: '200',
          page_name: 'MultiAd',
          page_id: 'pm',
          ad_creative_link_titles: ['Title 1', 'Title 2', 'Title 3'],
          ad_creative_bodies: ['Body 1', 'Body 2'],
        }],
      };

      const result = parseAdLibraryResults(raw);
      assert.equal(result[0].headline, 'Title 1');
      assert.deepEqual(result[0].allHeadlines, ['Title 1', 'Title 2', 'Title 3']);
      assert.deepEqual(result[0].allBodies, ['Body 1', 'Body 2']);
    });
  });

  // ------------------------------------------------------------------
  // formatAdsForWhatsApp
  // ------------------------------------------------------------------
  describe('formatAdsForWhatsApp', () => {
    it('returns a "no ads found" message for empty results', () => {
      const msg = formatAdsForWhatsApp([], 'Nike');
      assert.ok(msg.includes('No active ads found'));
      assert.ok(msg.includes('Nike'));
    });

    it('formats a single ad for WhatsApp', () => {
      const ads = [{
        id: '1',
        pageName: 'Nike',
        headline: 'Just Do It',
        body: 'Shop now for amazing deals.',
        description: '',
        platforms: ['facebook'],
        startDate: '2025-01-15T10:00:00',
        snapshotUrl: 'https://facebook.com/ads/123',
      }];

      const msg = formatAdsForWhatsApp(ads, 'Nike');
      assert.ok(msg.includes('Competitor Ads: Nike'));
      assert.ok(msg.includes('Just Do It'));
      assert.ok(msg.includes('Shop now'));
      assert.ok(msg.includes('facebook'));
      assert.ok(msg.includes('2025-01-15'));
    });

    it('truncates long body copy', () => {
      const longBody = 'A'.repeat(300);
      const ads = [{
        id: '1',
        pageName: 'Test',
        headline: 'Test',
        body: longBody,
        description: '',
        platforms: [],
        startDate: null,
        snapshotUrl: null,
      }];

      const msg = formatAdsForWhatsApp(ads, 'Test');
      assert.ok(msg.includes('...'));
      assert.ok(msg.length < longBody.length + 500);
    });

    it('shows ad count in header', () => {
      const ads = [
        { id: '1', pageName: 'X', headline: 'H1', body: '', description: '', platforms: [], startDate: null, snapshotUrl: null },
        { id: '2', pageName: 'X', headline: 'H2', body: '', description: '', platforms: [], startDate: null, snapshotUrl: null },
      ];

      const msg = formatAdsForWhatsApp(ads, 'TestCo');
      assert.ok(msg.includes('2 active ad(s)'));
    });
  });
});
