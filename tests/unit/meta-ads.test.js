/**
 * Unit tests for the Meta Ads API module.
 * Tests extractConversions helper and getAdAccounts routing logic.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { extractConversions } = await import('../../src/api/meta-ads.js');

describe('Meta Ads API', () => {
  // ------------------------------------------------------------------
  // extractConversions
  // ------------------------------------------------------------------
  describe('extractConversions', () => {
    it('returns null for empty insights', () => {
      assert.equal(extractConversions(null), null);
      assert.equal(extractConversions({}), null);
      assert.equal(extractConversions({ data: [] }), null);
    });

    it('extracts basic metrics from insights data', () => {
      const insights = {
        data: [{
          spend: '1500.50',
          impressions: '250000',
          clicks: '5000',
          ctr: '2.0',
          cpc: '0.30',
          reach: '180000',
          frequency: '1.39',
          actions: [],
          cost_per_action_type: [],
        }],
      };

      const result = extractConversions(insights);
      assert.equal(result.spend, 1500.50);
      assert.equal(result.impressions, 250000);
      assert.equal(result.clicks, 5000);
      assert.equal(result.ctr, 2.0);
      assert.equal(result.cpc, 0.30);
      assert.equal(result.reach, 180000);
      assert.equal(result.frequency, 1.39);
    });

    it('extracts purchase conversions and CPA', () => {
      const insights = {
        data: [{
          spend: '1000',
          impressions: '50000',
          clicks: '1000',
          ctr: '2.0',
          cpc: '1.0',
          reach: '40000',
          frequency: '1.25',
          actions: [
            { action_type: 'purchase', value: '42' },
            { action_type: 'link_click', value: '1000' },
          ],
          cost_per_action_type: [
            { action_type: 'purchase', value: '23.81' },
          ],
        }],
      };

      const result = extractConversions(insights);
      assert.equal(result.conversions, 42);
      assert.equal(result.cpa, 23.81);
    });

    it('falls back to lead conversions when no purchases', () => {
      const insights = {
        data: [{
          spend: '500',
          impressions: '20000',
          clicks: '400',
          ctr: '2.0',
          cpc: '1.25',
          reach: '15000',
          frequency: '1.33',
          actions: [
            { action_type: 'lead', value: '20' },
          ],
          cost_per_action_type: [
            { action_type: 'lead', value: '25.00' },
          ],
        }],
      };

      const result = extractConversions(insights);
      assert.equal(result.conversions, 20);
      assert.equal(result.cpa, 25.00);
    });

    it('calculates ROAS from conversion_values and spend', () => {
      const insights = {
        data: [{
          spend: '1000',
          impressions: '50000',
          clicks: '1000',
          ctr: '2.0',
          cpc: '1.0',
          reach: '40000',
          frequency: '1.25',
          actions: [],
          cost_per_action_type: [],
          conversion_values: '3500',
        }],
      };

      const result = extractConversions(insights);
      assert.equal(result.roas, 3.5);
    });

    it('returns zero ROAS when no conversion_values', () => {
      const insights = {
        data: [{
          spend: '1000',
          impressions: '50000',
          clicks: '1000',
          ctr: '2.0',
          cpc: '1.0',
          reach: '40000',
          frequency: '1.25',
          actions: [],
          cost_per_action_type: [],
        }],
      };

      const result = extractConversions(insights);
      assert.equal(result.roas, 0);
    });

    it('handles missing optional fields with zero defaults', () => {
      const insights = {
        data: [{}],
      };

      const result = extractConversions(insights);
      assert.equal(result.spend, 0);
      assert.equal(result.impressions, 0);
      assert.equal(result.clicks, 0);
      assert.equal(result.conversions, 0);
      assert.equal(result.cpa, 0);
      assert.equal(result.roas, 0);
    });
  });
});
