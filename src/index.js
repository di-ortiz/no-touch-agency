import logger from './utils/logger.js';
import { startServer } from './commands/whatsapp-server.js';
import { initializeSchedule, registerJob } from './services/scheduler.js';
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
import { sendAlert } from './api/whatsapp.js';
import { sendAlert as sendTelegramAlert } from './api/telegram.js';
import { exchangeForLongLived, debugToken } from './utils/meta-token.js';
import config from './config.js';
import fs from 'fs';
import axios from 'axios';

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
  });

  // 3. Run ClickUp monitor at startup and schedule it
  try {
    await runTaskMonitor();
  } catch (e) {
    log.warn('Initial task monitor run failed (expected if ClickUp not configured)', { error: e.message });
  }

  // 4. Validate API tokens on startup — catch bad tokens before user sends a message
  const startupIssues = [];

  // 4a. Auto-extend WhatsApp token (short-lived → long-lived) then validate
  if (config.META_APP_ID && config.META_APP_SECRET) {
    try {
      const tokenInfo = await debugToken(config.WHATSAPP_ACCESS_TOKEN);
      if (tokenInfo && tokenInfo.is_valid) {
        const expiresAt = tokenInfo.expires_at ? tokenInfo.expires_at * 1000 : 0;
        const now = Date.now();

        if (expiresAt > 0) {
          const hoursLeft = Math.round((expiresAt - now) / 3600000);
          log.info('WhatsApp token has expiry — attempting exchange for long-lived token', {
            expiresIn: hoursLeft + 'h',
          });

          try {
            const refreshed = await exchangeForLongLived(config.WHATSAPP_ACCESS_TOKEN);
            config.WHATSAPP_ACCESS_TOKEN = refreshed.access_token;
            const newExpiry = refreshed.expires_in
              ? Math.round(refreshed.expires_in / 86400) + 'd'
              : 'unknown';
            log.info('WhatsApp token exchanged for long-lived token', { expiresIn: newExpiry });
          } catch (exchangeErr) {
            log.warn('WhatsApp token exchange failed (may already be long-lived or System User token)', {
              error: exchangeErr.response?.data?.error?.message || exchangeErr.message,
            });
          }
        } else {
          log.info('WhatsApp token has no expiry (System User token — ideal)');
        }
      }
    } catch (e) {
      log.debug('Token debug check skipped, proceeding with validation', { error: e.message });
    }
  } else {
    log.info('META_APP_ID/META_APP_SECRET not configured — cannot auto-extend WhatsApp token. Consider adding them to prevent token expiry.');
  }

  // Validate WhatsApp token by hitting Meta API
  try {
    const metaRes = await axios.get(
      `https://graph.facebook.com/v22.0/${config.WHATSAPP_PHONE_NUMBER_ID}`,
      { headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` }, timeout: 10000 }
    );
    log.info('WhatsApp token VALID', {
      phoneNumber: metaRes.data?.display_phone_number || 'OK',
      qualityRating: metaRes.data?.quality_rating,
    });
  } catch (e) {
    const detail = e.response?.data?.error?.message || e.message;
    log.error('WhatsApp token INVALID — Sofia will NOT be able to respond!', {
      status: e.response?.status,
      error: detail,
      phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
    });
    startupIssues.push(`WhatsApp token invalid: ${detail}`);
  }

  // 4b. Validate Anthropic API key with a minimal call
  try {
    const { askClaude } = await import('./api/anthropic.js');
    await askClaude({ systemPrompt: 'Reply OK', userMessage: 'ping', maxTokens: 5, workflow: 'startup-check' });
    log.info('Anthropic API key VALID');
  } catch (e) {
    log.error('Anthropic API key INVALID — Sofia cannot think!', { error: e.message });
    startupIssues.push(`Anthropic API error: ${e.message?.substring(0, 100)}`);
  }

  // 4c. Send startup notification (WhatsApp, fallback Telegram)
  const statusMsg = startupIssues.length > 0
    ? `System Online — BUT ${startupIssues.length} issue(s):\n${startupIssues.map(i => `• ${i}`).join('\n')}`
    : 'PPC Agency Automation is running.\nType *help* for available commands.';

  try {
    await sendAlert(startupIssues.length > 0 ? 'warning' : 'success', 'System Online', statusMsg);
  } catch (e) {
    log.error('CANNOT send startup notification via WhatsApp', { error: e.message });
    // Fallback: try Telegram
    if (config.TELEGRAM_OWNER_CHAT_ID) {
      try {
        await sendTelegramAlert(startupIssues.length > 0 ? 'error' : 'success', 'System Online', statusMsg);
        log.info('Sent startup notification via Telegram (WhatsApp failed)');
      } catch (tgErr) {
        log.error('CANNOT send startup notification via Telegram either', { error: tgErr.message });
      }
    }
  }

  // 5. Schedule WhatsApp token health check every 6 hours
  if (config.META_APP_ID && config.META_APP_SECRET) {
    registerJob('whatsapp-token-check', '0 */6 * * *', async () => {
      try {
        const tokenInfo = await debugToken(config.WHATSAPP_ACCESS_TOKEN);
        if (!tokenInfo || !tokenInfo.is_valid) {
          log.error('WhatsApp token has become INVALID — Sofia cannot respond!');
          if (config.TELEGRAM_OWNER_CHAT_ID) {
            await sendTelegramAlert('critical', 'WhatsApp Token Expired',
              'The WhatsApp access token is invalid. Sofia cannot send messages.\n\nGenerate a new token or create a System User token in Meta Business Suite.');
          }
          return;
        }

        const expiresAt = tokenInfo.expires_at ? tokenInfo.expires_at * 1000 : 0;
        if (expiresAt > 0) {
          const hoursLeft = Math.round((expiresAt - Date.now()) / 3600000);

          // Try to refresh if expiring within 7 days
          if (hoursLeft < 168) {
            try {
              const refreshed = await exchangeForLongLived(config.WHATSAPP_ACCESS_TOKEN);
              config.WHATSAPP_ACCESS_TOKEN = refreshed.access_token;
              log.info('WhatsApp token auto-refreshed', {
                expiresIn: refreshed.expires_in ? Math.round(refreshed.expires_in / 86400) + 'd' : 'unknown',
              });
            } catch {
              // Alert if expiring within 24h and refresh failed
              if (hoursLeft < 24 && config.TELEGRAM_OWNER_CHAT_ID) {
                await sendTelegramAlert('warning', 'WhatsApp Token Expiring Soon',
                  `Token expires in ~${hoursLeft}h. Auto-refresh failed.\n\nReplace the token in Railway or create a System User token for a permanent solution.`);
              }
            }
          }
        }
      } catch (e) {
        log.warn('WhatsApp token health check failed', { error: e.message });
      }
    });
  }

  log.info('PPC Agency Automation fully initialized', {
    issues: startupIssues.length,
    whatsappOk: !startupIssues.some(i => i.includes('WhatsApp')),
    anthropicOk: !startupIssues.some(i => i.includes('Anthropic')),
  });
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
