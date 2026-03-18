import logger from './utils/logger.js';
import { startServer } from './commands/whatsapp-server.js';
import { initializeSchedule } from './services/scheduler.js';
import { runMorningBriefing } from './workflows/morning-briefing.js';
import { runDailyMonitor } from './workflows/daily-monitor.js';
import { runTaskMonitor, generateDailyStandup } from './workflows/clickup-monitor.js';
import { runBudgetPacing } from './workflows/budget-pacing.js';
import { runCreativeFatigueCheck } from './workflows/creative-fatigue.js';
import { runWeeklyReports } from './workflows/weekly-report.js';
import { runMonthlyReview } from './workflows/monthly-review.js';
import { runCompetitorMonitor } from './workflows/competitor-monitor.js';
import { runCrossDepartmentDetection } from './workflows/cross-department.js';
import { runLandingPageAnalysis } from './workflows/landing-page-analysis.js';
import { runTestManager } from './workflows/ab-test-manager.js';
import { runClientCheckIn } from './workflows/client-check-in.js';
import { runClientMorningBriefing } from './workflows/client-morning-briefing.js';
import { runMorningCostAlert, runEveningCostAlert } from './workflows/daily-cost-alert.js';
import { runWeeklySEOCheck, runMonthlyContentAnalysis } from './workflows/seo-monitor.js';
import { runDayBeforeConfirmation, runStaleConfirmationCleanup, runContentPublisher } from './workflows/content-confirmation.js';
import { sendAlert } from './api/whatsapp.js';
import { closeDb as closeKnowledgeDb } from './services/knowledge-base.js';
import { closeDb as closeCostDb } from './services/cost-tracker.js';
import config from './config.js';
import fs from 'fs';

const log = logger.child({ workflow: 'main' });

async function main() {
  log.info('PPC Agency Automation starting', { env: config.NODE_ENV });

  // Ensure data directory exists
  if (!fs.existsSync('data')) fs.mkdirSync('data', { recursive: true });
  if (!fs.existsSync('logs')) fs.mkdirSync('logs', { recursive: true });
  if (!fs.existsSync('config')) fs.mkdirSync('config', { recursive: true });

  // Write Google service account JSON from env var if the file doesn't exist
  // (Railway and other cloud platforms can't have gitignored files, so we store the JSON as an env var)
  const saPath = config.GOOGLE_APPLICATION_CREDENTIALS || 'config/google-service-account.json';
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !fs.existsSync(saPath)) {
    try {
      // Validate it's valid JSON before writing
      JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      fs.writeFileSync(saPath, process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      log.info('Wrote Google service account JSON from env var', { path: saPath });
    } catch (e) {
      log.error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON', { error: e.message });
    }
  }

  // 1. Start WhatsApp webhook server
  startServer();

  // 2. Initialize all scheduled workflows
  initializeSchedule({
    morningBriefing: runMorningBriefing,
    dailyMonitor: runDailyMonitor,
    budgetPacing: runBudgetPacing,
    creativeFatigue: runCreativeFatigueCheck,
    weeklyReport: runWeeklyReports,
    monthlyReview: runMonthlyReview,
    competitorMonitor: runCompetitorMonitor,
    crossDepartment: runCrossDepartmentDetection,
    landingPageAnalysis: runLandingPageAnalysis,
    clientCheckIn: runClientCheckIn,
    clientMorningBriefing: runClientMorningBriefing,
    morningCostAlert: runMorningCostAlert,
    eveningCostAlert: runEveningCostAlert,
    weeklySEOCheck: runWeeklySEOCheck,
    monthlyContentAnalysis: runMonthlyContentAnalysis,
    dayBeforeConfirmation: runDayBeforeConfirmation,
    staleConfirmationCleanup: runStaleConfirmationCleanup,
    contentPublisher: runContentPublisher,
  });

  // 3. Run ClickUp monitor at startup and schedule it
  try {
    await runTaskMonitor();
  } catch (e) {
    log.warn('Initial task monitor run failed (expected if ClickUp not configured)', { error: e.message });
  }

  // 4. Notify that system is online
  try {
    await sendAlert('success', 'System Online', 'PPC Agency Automation is running.\nType *help* for available commands.');
  } catch (e) {
    log.warn('Failed to send startup notification (expected if WhatsApp not configured)', { error: e.message });
  }

  log.info('PPC Agency Automation fully initialized');
}

// Graceful shutdown — close database connections before exit
function shutdown(signal) {
  log.info(`Received ${signal}, shutting down`);
  try { closeKnowledgeDb(); } catch (e) { log.warn('Error closing knowledge DB', { error: e.message }); }
  try { closeCostDb(); } catch (e) { log.warn('Error closing cost DB', { error: e.message }); }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (error) => {
  log.error('Unhandled rejection', { error: error?.message, stack: error?.stack });
});

main().catch(error => {
  log.error('Fatal error', { error: error.message, stack: error.stack });
  process.exit(1);
});
