import logger from './utils/logger.js';
import { startServer } from './commands/whatsapp-server.js';
import { initializeSchedule } from './services/scheduler.js';
import { runMorningBriefing } from './workflows/morning-briefing.js';
import { runDailyMonitor } from './workflows/daily-monitor.js';
import { runTaskMonitor, generateDailyStandup } from './workflows/clickup-monitor.js';
import { sendAlert } from './api/whatsapp.js';
import config from './config.js';
import fs from 'fs';

const log = logger.child({ workflow: 'main' });

async function main() {
  log.info('PPC Agency Automation starting', { env: config.NODE_ENV });

  // Ensure data directory exists
  if (!fs.existsSync('data')) fs.mkdirSync('data', { recursive: true });
  if (!fs.existsSync('logs')) fs.mkdirSync('logs', { recursive: true });

  // 1. Start WhatsApp webhook server
  startServer();

  // 2. Initialize scheduled workflows
  initializeSchedule({
    morningBriefing: runMorningBriefing,
    dailyMonitor: runDailyMonitor,
    budgetPacing: async () => {
      // Reuse daily monitor with budget focus
      await runDailyMonitor();
    },
    creativeFatigue: async () => {
      log.info('Creative fatigue check - Phase 4 feature');
    },
    weeklyReport: async () => {
      log.info('Weekly report generation - Phase 5 feature');
    },
    monthlyReview: async () => {
      log.info('Monthly review - Phase 5 feature');
    },
    competitorMonitor: async () => {
      log.info('Competitor monitoring - Phase 3 feature');
    },
    crossDepartment: async () => {
      log.info('Cross-department detection - Phase 6 feature');
    },
    landingPageAnalysis: async () => {
      log.info('Landing page analysis - Phase 6 feature');
    },
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

// Graceful shutdown
process.on('SIGTERM', () => {
  log.info('Received SIGTERM, shutting down');
  process.exit(0);
});

process.on('SIGINT', () => {
  log.info('Received SIGINT, shutting down');
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  log.error('Unhandled rejection', { error: error?.message, stack: error?.stack });
});

main().catch(error => {
  log.error('Fatal error', { error: error.message, stack: error.stack });
  process.exit(1);
});
