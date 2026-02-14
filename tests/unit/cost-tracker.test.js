/**
 * Unit tests for the cost tracker service.
 * Uses a temporary SQLite database for isolation.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.NODE_ENV = 'test';

const dbPath = path.join(os.tmpdir(), `cost-tracker-test-${Date.now()}.db`);
process.env.COST_DB_PATH = dbPath;

const { recordCost, getCostSummary, isDailyBudgetExceeded, auditLog, getAuditLog } =
  await import('../../src/services/cost-tracker.js');

describe('Cost Tracker', () => {
  // ------------------------------------------------------------------
  // recordCost
  // ------------------------------------------------------------------
  describe('recordCost', () => {
    it('records a cost with explicit override', () => {
      const cost = recordCost({
        platform: 'anthropic',
        model: 'claude-sonnet-4-5-20250514',
        workflow: 'test-workflow',
        clientId: 'client-001',
        costCentsOverride: 5.0,
      });
      assert.equal(cost, 5.0);
    });

    it('calculates cost from token counts for known models', () => {
      const cost = recordCost({
        platform: 'anthropic',
        model: 'claude-sonnet-4-5-20250514',
        workflow: 'test-workflow',
        inputTokens: 1000,
        outputTokens: 500,
      });
      // 1000/1000 * 0.3 + 500/1000 * 1.5 = 0.3 + 0.75 = 1.05
      assert.ok(Math.abs(cost - 1.05) < 0.01, `Expected ~1.05 but got ${cost}`);
    });

    it('calculates per-image cost for DALL-E', () => {
      const cost = recordCost({
        platform: 'openai',
        model: 'dall-e-3',
        workflow: 'creative-gen',
      });
      assert.equal(cost, 4.0);
    });

    it('returns 0 for unknown model without override', () => {
      const cost = recordCost({
        platform: 'unknown',
        model: 'unknown-model',
        workflow: 'test',
      });
      assert.equal(cost, 0);
    });

    it('records with metadata', () => {
      const cost = recordCost({
        platform: 'meta',
        workflow: 'api',
        costCentsOverride: 0,
        metadata: { endpoint: '/insights', campaignId: '123' },
      });
      assert.equal(cost, 0);
    });
  });

  // ------------------------------------------------------------------
  // getCostSummary
  // ------------------------------------------------------------------
  describe('getCostSummary', () => {
    it('returns a summary with totalCents and breakdowns', () => {
      const summary = getCostSummary('today');
      assert.ok('totalCents' in summary);
      assert.ok('totalDollars' in summary);
      assert.ok('byPlatform' in summary);
      assert.ok('byClient' in summary);
      assert.ok('byWorkflow' in summary);
      assert.ok('budgetUsedPct' in summary);
    });

    it('includes costs recorded today', () => {
      const summary = getCostSummary('today');
      assert.ok(summary.totalCents > 0, 'Should have costs from previous test recordings');
    });

    it('supports different periods (week, month, all)', () => {
      const week = getCostSummary('week');
      const month = getCostSummary('month');
      assert.ok(week.totalCents >= 0);
      assert.ok(month.totalCents >= 0);
    });

    it('groups costs by platform', () => {
      const summary = getCostSummary('today');
      const platforms = summary.byPlatform.map(p => p.platform);
      assert.ok(platforms.includes('anthropic'), 'Should have anthropic costs');
    });
  });

  // ------------------------------------------------------------------
  // isDailyBudgetExceeded
  // ------------------------------------------------------------------
  describe('isDailyBudgetExceeded', () => {
    it('returns false when costs are below threshold', () => {
      // Default DAILY_COST_ALERT_THRESHOLD_CENTS is 5000 ($50)
      // Our test costs are well below that
      const exceeded = isDailyBudgetExceeded();
      assert.equal(exceeded, false);
    });
  });

  // ------------------------------------------------------------------
  // auditLog and getAuditLog
  // ------------------------------------------------------------------
  describe('auditLog', () => {
    it('records an audit log entry', () => {
      auditLog({
        action: 'pause_campaign',
        workflow: 'daily-monitor',
        clientId: 'client-001',
        platform: 'meta',
        details: { campaignId: 'camp_123', reason: 'Low ROAS' },
        approvedBy: 'system',
        result: 'success',
      });

      const logs = getAuditLog(10);
      assert.ok(logs.length >= 1, 'Should have at least one audit entry');
      const latest = logs[0];
      assert.equal(latest.action, 'pause_campaign');
      assert.equal(latest.client_id, 'client-001');
      assert.equal(latest.platform, 'meta');
    });

    it('filters audit log by client ID', () => {
      auditLog({
        action: 'change_budget',
        clientId: 'client-002',
        platform: 'google',
      });

      const logs = getAuditLog(10, 'client-002');
      assert.ok(logs.length >= 1);
      assert.ok(logs.every(l => l.client_id === 'client-002'));
    });

    it('respects the limit parameter', () => {
      // Add several entries
      for (let i = 0; i < 5; i++) {
        auditLog({ action: `test_action_${i}`, clientId: 'client-limit' });
      }

      const logs = getAuditLog(3, 'client-limit');
      assert.equal(logs.length, 3);
    });
  });

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------
  after(() => {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });
});
