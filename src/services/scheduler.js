import cron from 'node-cron';
import logger from '../utils/logger.js';

const log = logger.child({ workflow: 'scheduler' });

const jobs = new Map();

/**
 * Register a scheduled job.
 * @param {string} name - Job name
 * @param {string} schedule - Cron expression
 * @param {Function} handler - Async function to execute
 * @param {object} opts - Options
 */
export function registerJob(name, schedule, handler, opts = {}) {
  if (jobs.has(name)) {
    log.warn(`Job "${name}" already registered, replacing`);
    jobs.get(name).task.stop();
  }

  const task = cron.schedule(schedule, async () => {
    log.info(`Running scheduled job: ${name}`);
    try {
      await handler();
      log.info(`Job "${name}" completed`);
    } catch (error) {
      log.error(`Job "${name}" failed`, { error: error.message, stack: error.stack });
    }
  }, {
    timezone: opts.timezone || 'America/New_York',
    scheduled: true,
  });

  jobs.set(name, { task, schedule, handler, opts });
  log.info(`Registered job: ${name} (${schedule})`);
}

/**
 * Get all registered jobs.
 */
export function getJobs() {
  const result = [];
  for (const [name, { schedule, opts }] of jobs) {
    result.push({ name, schedule, timezone: opts.timezone || 'America/New_York' });
  }
  return result;
}

/**
 * Run a job immediately (bypass schedule).
 */
export async function runJob(name) {
  const job = jobs.get(name);
  if (!job) throw new Error(`Job "${name}" not found`);
  log.info(`Manually triggering job: ${name}`);
  return job.handler();
}

/**
 * Stop all jobs.
 */
export function stopAll() {
  for (const [name, { task }] of jobs) {
    task.stop();
    log.info(`Stopped job: ${name}`);
  }
}

/**
 * Initialize all standard scheduled jobs.
 */
export function initializeSchedule(workflows) {
  const {
    morningBriefing,
    dailyMonitor,
    budgetPacing,
    weeklyReport,
    monthlyReview,
    competitorMonitor,
    creativeFatigue,
    landingPageAnalysis,
    crossDepartment,
    clientCheckIn,
    clientMorningBriefing,
    morningCostAlert,
    eveningCostAlert,
    weeklySEOCheck,
    monthlyContentAnalysis,
    teamDailyDigest,
  } = workflows;

  // Workflow 1: Morning Intelligence Briefing - 8 AM
  if (morningBriefing) registerJob('morning-briefing', '0 8 * * *', morningBriefing);

  // Workflow 6: Daily Performance Monitoring - 10 AM, 3 PM, 8 PM
  if (dailyMonitor) {
    registerJob('daily-monitor-10am', '0 10 * * *', dailyMonitor);
    registerJob('daily-monitor-3pm', '0 15 * * *', dailyMonitor);
    registerJob('daily-monitor-8pm', '0 20 * * *', dailyMonitor);
  }

  // Workflow 13: Budget Pacing - 2 PM daily
  if (budgetPacing) registerJob('budget-pacing', '0 14 * * *', budgetPacing);

  // Workflow 14: Creative Fatigue Detection - daily at 11 AM
  if (creativeFatigue) registerJob('creative-fatigue', '0 11 * * *', creativeFatigue);

  // Workflow 8: Weekly Client Report - Friday 4 PM
  if (weeklyReport) registerJob('weekly-report', '0 16 * * 5', weeklyReport);

  // Workflow 9: Monthly Strategic Review - last Friday of month at 2 PM
  if (monthlyReview) registerJob('monthly-review', '0 14 * * 5', monthlyReview);

  // Workflow 11: Competitor Monitoring - Wednesday 9 AM
  if (competitorMonitor) registerJob('competitor-monitor', '0 9 * * 3', competitorMonitor);

  // Workflow 12: Cross-Department - daily at 6 PM
  if (crossDepartment) registerJob('cross-department', '0 18 * * *', crossDepartment);

  // Workflow 15: Landing Page Analysis - Monday 10 AM
  if (landingPageAnalysis) registerJob('landing-page-analysis', '0 10 * * 1', landingPageAnalysis);

  // Client morning briefing - 8:30 AM daily (after owner briefing at 8 AM)
  if (clientMorningBriefing) registerJob('client-morning-briefing', '30 8 * * *', clientMorningBriefing);

  // Client check-in - 9 AM daily (proactive follow-ups)
  if (clientCheckIn) registerJob('client-check-in', '0 9 * * *', clientCheckIn);

  // Owner Cost Alerts - morning recap at 8 AM, end-of-day report at 9 PM (owner-only, never sent to clients)
  if (morningCostAlert) registerJob('morning-cost-alert', '0 8 * * *', morningCostAlert);
  if (eveningCostAlert) registerJob('evening-cost-alert', '0 21 * * *', eveningCostAlert);

  // SEO Monitoring - weekly check Monday 9 AM, monthly content analysis 1st Monday at 10 AM
  if (weeklySEOCheck) registerJob('weekly-seo-check', '0 9 * * 1', weeklySEOCheck);
  if (monthlyContentAnalysis) registerJob('monthly-content-analysis', '0 10 1-7 * 1', monthlyContentAnalysis);

  // Team Task Tracker - daily digest at 7:30 AM (before other briefings)
  if (teamDailyDigest) registerJob('team-daily-digest', '30 7 * * *', teamDailyDigest);

  log.info(`Initialized ${jobs.size} scheduled jobs`);
}

export default { registerJob, getJobs, runJob, stopAll, initializeSchedule };
