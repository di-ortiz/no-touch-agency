/**
 * Unit tests for the safety system.
 * Tests budget approval, bid approval, auto-pause logic, and action validation.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

// Set test environment and configure a temp DB for cost-tracker (imported by safety.js)
process.env.NODE_ENV = 'test';
process.env.COST_DB_PATH = path.join(os.tmpdir(), `safety-test-costs-${Date.now()}.db`);

const { getBudgetChangeApproval, getBidChangeApproval, shouldAutoPause, validateAction, ApprovalLevel } =
  await import('../../src/services/safety.js');

describe('Safety System', () => {
  // ------------------------------------------------------------------
  // getBudgetChangeApproval
  // ------------------------------------------------------------------
  describe('getBudgetChangeApproval', () => {
    it('returns AUTO for small changes within the $50 limit', () => {
      // 2000 cents = $20, well under the 5000-cent ($50) auto-approve limit
      const result = getBudgetChangeApproval(2000, 100000);
      assert.equal(result, ApprovalLevel.AUTO);
    });

    it('returns REQUIRES_APPROVAL for changes exceeding $50', () => {
      // 6000 cents = $60, above the 5000-cent limit but <= 20% of 100000
      const result = getBudgetChangeApproval(6000, 100000);
      assert.equal(result, ApprovalLevel.REQUIRES_APPROVAL);
    });

    it('returns ALWAYS_REQUIRES_APPROVAL for changes >20% of total client budget', () => {
      // 25000 cents out of a 100000 cent total = 25%, exceeds the 20% threshold
      const result = getBudgetChangeApproval(25000, 100000);
      assert.equal(result, ApprovalLevel.ALWAYS_REQUIRES_APPROVAL);
    });

    it('returns AUTO for a change exactly at the limit', () => {
      // Exactly 5000 cents = $50, the limit check is >, so equal should be AUTO
      const result = getBudgetChangeApproval(5000, 100000);
      assert.equal(result, ApprovalLevel.AUTO);
    });

    it('handles zero total budget gracefully (skips 20% check)', () => {
      // With totalClientBudgetCents = 0, the 20% check is skipped
      const result = getBudgetChangeApproval(6000, 0);
      assert.equal(result, ApprovalLevel.REQUIRES_APPROVAL);
    });
  });

  // ------------------------------------------------------------------
  // getBidChangeApproval
  // ------------------------------------------------------------------
  describe('getBidChangeApproval', () => {
    it('returns AUTO for bid changes within the 20% threshold', () => {
      const result = getBidChangeApproval(15);
      assert.equal(result, ApprovalLevel.AUTO);
    });

    it('returns AUTO for bid changes exactly at the threshold', () => {
      const result = getBidChangeApproval(20);
      assert.equal(result, ApprovalLevel.AUTO);
    });

    it('returns REQUIRES_APPROVAL for bid changes beyond the threshold', () => {
      const result = getBidChangeApproval(25);
      assert.equal(result, ApprovalLevel.REQUIRES_APPROVAL);
    });

    it('handles negative bid changes (decreases)', () => {
      // -15% is within threshold (abs value check)
      assert.equal(getBidChangeApproval(-15), ApprovalLevel.AUTO);
      // -25% exceeds threshold
      assert.equal(getBidChangeApproval(-25), ApprovalLevel.REQUIRES_APPROVAL);
    });
  });

  // ------------------------------------------------------------------
  // shouldAutoPause
  // ------------------------------------------------------------------
  describe('shouldAutoPause', () => {
    it('auto-pauses campaigns with low ROAS (below 0.2x target for 3+ days)', () => {
      const campaign = {
        roas: 0.3,        // Well below 0.2 * 5.0 = 1.0
        roasTarget: 5.0,
        cpa: 500,
        cpaTarget: 1000,
        spend: 10000,
        conversions: 5,
        daysRunning: 5,
      };
      const result = shouldAutoPause(campaign);
      assert.equal(result.pause, true);
      assert.ok(result.reason.includes('ROAS'));
    });

    it('does not auto-pause low ROAS campaigns running fewer than 3 days', () => {
      const campaign = {
        roas: 0.3,
        roasTarget: 5.0,
        cpa: 500,
        cpaTarget: 1000,
        spend: 10000,
        conversions: 5,
        daysRunning: 2,
      };
      const result = shouldAutoPause(campaign);
      assert.equal(result.pause, false);
    });

    it('auto-pauses campaigns with CPA exceeding 3x target', () => {
      const campaign = {
        roas: 3.0,
        roasTarget: 2.0,
        cpa: 4000,          // 4000 > 3 * 1000 = 3000
        cpaTarget: 1000,
        spend: 10000,
        conversions: 5,
        daysRunning: 5,
      };
      const result = shouldAutoPause(campaign);
      assert.equal(result.pause, true);
      assert.ok(result.reason.includes('CPA'));
    });

    it('does not auto-pause when CPA is within acceptable range', () => {
      const campaign = {
        roas: 3.0,
        roasTarget: 2.0,
        cpa: 2500,          // 2500 < 3 * 1000 = 3000
        cpaTarget: 1000,
        spend: 10000,
        conversions: 5,
        daysRunning: 5,
      };
      const result = shouldAutoPause(campaign);
      assert.equal(result.pause, false);
    });

    it('auto-pauses campaigns with zero conversions and significant spend', () => {
      const campaign = {
        roas: 0,
        roasTarget: 0,      // No ROAS target (avoids ROAS check)
        cpa: 0,
        cpaTarget: 0,       // No CPA target (avoids CPA check)
        spend: 60000,       // $600, above the 50000-cent ($500) threshold
        conversions: 0,
        daysRunning: 5,
      };
      const result = shouldAutoPause(campaign);
      assert.equal(result.pause, true);
      assert.ok(result.reason.includes('zero conversions'));
    });

    it('does not auto-pause zero-conversion campaigns with low spend', () => {
      const campaign = {
        roas: 0,
        roasTarget: 0,
        cpa: 0,
        cpaTarget: 0,
        spend: 20000,       // $200, below the $500 threshold
        conversions: 0,
        daysRunning: 5,
      };
      const result = shouldAutoPause(campaign);
      assert.equal(result.pause, false);
    });
  });

  // ------------------------------------------------------------------
  // validateAction
  // ------------------------------------------------------------------
  describe('validateAction', () => {
    it('blocks dangerous actions like delete_campaign', () => {
      const result = validateAction({ type: 'delete_campaign' });
      assert.equal(result.allowed, false);
      assert.equal(result.level, 'blocked');
      assert.ok(result.reason.includes('permanently blocked'));
    });

    it('blocks other dangerous action types', () => {
      for (const type of ['remove_payment', 'change_access', 'modify_contract']) {
        const result = validateAction({ type });
        assert.equal(result.allowed, false, `Expected ${type} to be blocked`);
        assert.equal(result.level, 'blocked');
      }
    });

    it('allows pause_campaign actions', () => {
      const result = validateAction({ type: 'pause_campaign' });
      assert.equal(result.allowed, true);
      assert.equal(result.level, ApprovalLevel.AUTO);
      assert.ok(result.reason.includes('safe'));
    });

    it('allows pause_adset and pause_ad actions', () => {
      assert.equal(validateAction({ type: 'pause_adset' }).allowed, true);
      assert.equal(validateAction({ type: 'pause_ad' }).allowed, true);
    });

    it('requires approval for campaign launches', () => {
      const result = validateAction({ type: 'launch_campaign' });
      assert.equal(result.allowed, false);
      assert.equal(result.level, ApprovalLevel.ALWAYS_REQUIRES_APPROVAL);
    });

    it('auto-approves small budget changes', () => {
      const result = validateAction({
        type: 'change_budget',
        amountCents: 2000,
        totalClientBudgetCents: 100000,
      });
      assert.equal(result.allowed, true);
      assert.equal(result.level, ApprovalLevel.AUTO);
    });

    it('requires approval for large budget changes', () => {
      const result = validateAction({
        type: 'change_budget',
        amountCents: 8000,
        totalClientBudgetCents: 100000,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.level, ApprovalLevel.REQUIRES_APPROVAL);
    });

    it('auto-approves small bid changes', () => {
      const result = validateAction({ type: 'change_bid', changePercent: 10 });
      assert.equal(result.allowed, true);
      assert.equal(result.level, ApprovalLevel.AUTO);
    });

    it('requires approval for large bid changes', () => {
      const result = validateAction({ type: 'change_bid', changePercent: 30 });
      assert.equal(result.allowed, false);
      assert.equal(result.level, ApprovalLevel.REQUIRES_APPROVAL);
    });

    it('requires approval for unknown action types', () => {
      const result = validateAction({ type: 'some_unknown_action' });
      assert.equal(result.allowed, false);
      assert.equal(result.level, ApprovalLevel.REQUIRES_APPROVAL);
      assert.ok(result.reason.includes('Unknown'));
    });
  });
});
