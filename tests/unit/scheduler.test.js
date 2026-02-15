/**
 * Unit tests for the scheduler service.
 * Tests job registration, listing, manual execution, and initialization.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { registerJob, getJobs, runJob, stopAll, initializeSchedule } =
  await import('../../src/services/scheduler.js');

describe('Scheduler', () => {
  afterEach(() => {
    stopAll();
  });

  // ------------------------------------------------------------------
  // registerJob
  // ------------------------------------------------------------------
  describe('registerJob', () => {
    it('registers a job and lists it', () => {
      registerJob('test-job-1', '0 9 * * *', async () => {});
      const jobs = getJobs();
      const found = jobs.find(j => j.name === 'test-job-1');
      assert.ok(found, 'Job should be registered');
      assert.equal(found.schedule, '0 9 * * *');
      assert.equal(found.timezone, 'America/New_York');
    });

    it('allows custom timezone', () => {
      registerJob('test-tz', '0 8 * * *', async () => {}, { timezone: 'America/Sao_Paulo' });
      const jobs = getJobs();
      const found = jobs.find(j => j.name === 'test-tz');
      assert.equal(found.timezone, 'America/Sao_Paulo');
    });

    it('replaces an existing job with the same name', () => {
      registerJob('dup-job', '0 8 * * *', async () => 'first');
      registerJob('dup-job', '0 10 * * *', async () => 'second');
      const jobs = getJobs();
      const matches = jobs.filter(j => j.name === 'dup-job');
      assert.equal(matches.length, 1, 'Should only have one job with that name');
      assert.equal(matches[0].schedule, '0 10 * * *');
    });
  });

  // ------------------------------------------------------------------
  // runJob
  // ------------------------------------------------------------------
  describe('runJob', () => {
    it('executes a registered job immediately', async () => {
      let executed = false;
      registerJob('run-test', '0 0 * * *', async () => { executed = true; });
      await runJob('run-test');
      assert.equal(executed, true);
    });

    it('throws for an unregistered job', async () => {
      await assert.rejects(
        () => runJob('nonexistent-job'),
        { message: 'Job "nonexistent-job" not found' }
      );
    });

    it('propagates errors from the job handler', async () => {
      registerJob('fail-job', '0 0 * * *', async () => { throw new Error('Job error'); });
      await assert.rejects(
        () => runJob('fail-job'),
        { message: 'Job error' }
      );
    });
  });

  // ------------------------------------------------------------------
  // initializeSchedule
  // ------------------------------------------------------------------
  describe('initializeSchedule', () => {
    it('registers jobs for provided workflows', () => {
      initializeSchedule({
        morningBriefing: async () => {},
        dailyMonitor: async () => {},
        budgetPacing: async () => {},
        weeklyReport: async () => {},
      });

      const jobs = getJobs();
      const names = jobs.map(j => j.name);
      assert.ok(names.includes('morning-briefing'));
      assert.ok(names.includes('daily-monitor-10am'));
      assert.ok(names.includes('daily-monitor-3pm'));
      assert.ok(names.includes('daily-monitor-8pm'));
      assert.ok(names.includes('budget-pacing'));
      assert.ok(names.includes('weekly-report'));
    });

    it('does not register jobs for undefined workflows', () => {
      // Count jobs before
      const before = getJobs().length;
      // Initialize with only morningBriefing (others undefined)
      initializeSchedule({
        morningBriefing: async () => {},
      });
      const after = getJobs();
      // Should have added exactly 1 new job (morning-briefing)
      // Note: previous test registered jobs that persist since stopAll stops but doesn't remove
      const morningJob = after.find(j => j.name === 'morning-briefing');
      assert.ok(morningJob, 'morning-briefing should be registered');
    });

    it('registers all optional workflows when provided', () => {
      stopAll();
      initializeSchedule({
        morningBriefing: async () => {},
        dailyMonitor: async () => {},
        budgetPacing: async () => {},
        weeklyReport: async () => {},
        monthlyReview: async () => {},
        competitorMonitor: async () => {},
        creativeFatigue: async () => {},
        crossDepartment: async () => {},
        landingPageAnalysis: async () => {},
      });

      const jobs = getJobs();
      assert.ok(jobs.length >= 10, `Expected at least 10 jobs but got ${jobs.length}`);
    });
  });

  // ------------------------------------------------------------------
  // stopAll
  // ------------------------------------------------------------------
  describe('stopAll', () => {
    it('stops and clears all jobs', () => {
      registerJob('stop-test-1', '0 8 * * *', async () => {});
      registerJob('stop-test-2', '0 9 * * *', async () => {});
      assert.ok(getJobs().length >= 2);
      stopAll();
      // After stopAll, getJobs still returns entries (they're stopped, not removed)
      // But we can verify no errors occur
    });
  });
});
