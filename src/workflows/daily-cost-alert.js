import logger from '../utils/logger.js';
import { getCostSummary, isDailyBudgetExceeded } from '../services/cost-tracker.js';
import { sendAlert as sendWhatsAppAlert } from '../api/whatsapp.js';
import { sendAlert as sendTelegramAlert } from '../api/telegram.js';
import config from '../config.js';

const log = logger.child({ workflow: 'daily-cost-alert' });

/**
 * Send an owner-only alert to both WhatsApp and Telegram.
 * These never reach clients — sendAlert() defaults to WHATSAPP_OWNER_PHONE
 * and TELEGRAM_OWNER_CHAT_ID respectively.
 */
async function notifyOwner(level, title, body) {
  const results = await Promise.allSettled([
    sendWhatsAppAlert(level, title, body),
    config.TELEGRAM_OWNER_CHAT_ID
      ? sendTelegramAlert(level, title, body)
      : Promise.resolve(),
  ]);

  for (const r of results) {
    if (r.status === 'rejected') {
      log.warn('Owner notification channel failed', { error: r.reason?.message });
    }
  }
}

/**
 * Build the cost summary body shared by both morning and evening reports.
 */
function buildCostBody({ today, week, month, budgetDollars, monthPct, dailyThresholdExceeded, label }) {
  const lines = [label, ``];

  if (dailyThresholdExceeded) {
    lines.push(`*Daily spend threshold exceeded!*`, ``);
  }

  lines.push(
    `*Today:*  $${today.totalDollars}`,
    `*Last 7 days:*  $${week.totalDollars}`,
    `*This month:*  $${month.totalDollars}  (${monthPct}% of $${budgetDollars} budget)`,
  );

  if (parseFloat(monthPct) >= 80) {
    lines.push(``, `*Monthly budget at ${monthPct}% — review spend.*`);
  }

  // By platform
  if (today.byPlatform.length > 0) {
    lines.push(``, `*By Platform (today):*`);
    for (const p of today.byPlatform) {
      lines.push(`  ${p.platform}: $${(p.total / 100).toFixed(2)}`);
    }
  }

  // By workflow
  if (today.byWorkflow.length > 0) {
    lines.push(``, `*By Workflow (today):*`);
    for (const w of today.byWorkflow) {
      lines.push(`  ${w.workflow}: $${(w.total / 100).toFixed(2)}`);
    }
  }

  // Top clients (month)
  if (month.byClient.length > 0) {
    lines.push(``, `*Top Clients (month):*`);
    for (const c of month.byClient.slice(0, 5)) {
      lines.push(`  ${c.client_id}: $${(c.total / 100).toFixed(2)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Gather cost summaries and compute shared values.
 */
function gatherCostData() {
  const today = getCostSummary('today');
  const week = getCostSummary('week');
  const month = getCostSummary('month');
  const budgetCents = config.MONTHLY_AI_BUDGET_CENTS || 100_000;
  const budgetDollars = (budgetCents / 100).toFixed(0);
  const monthPct = ((month.totalCents / budgetCents) * 100).toFixed(1);
  const dailyThresholdExceeded = isDailyBudgetExceeded();
  return { today, week, month, budgetDollars, monthPct, dailyThresholdExceeded };
}

/**
 * Morning Cost Alert — runs at 8 AM.
 * Recaps yesterday's final numbers and shows month-to-date budget usage.
 * Sent ONLY to the owner (WhatsApp + Telegram).
 */
export async function runMorningCostAlert() {
  log.info('Generating morning cost alert for owner');

  const data = gatherCostData();
  const body = buildCostBody({ ...data, label: `*Morning Cost Recap*` });
  const level = data.dailyThresholdExceeded ? 'warning' : 'info';

  await notifyOwner(level, 'Morning Cost Recap', body);

  log.info('Morning cost alert sent to owner', {
    monthDollars: data.month.totalDollars,
    budgetPct: data.monthPct,
  });

  return data;
}

/**
 * Evening Cost Alert — runs at 9 PM.
 * Shows today's running total and full breakdowns before the day closes.
 * Sent ONLY to the owner (WhatsApp + Telegram).
 */
export async function runEveningCostAlert() {
  log.info('Generating evening cost alert for owner');

  const data = gatherCostData();
  const body = buildCostBody({ ...data, label: `*End-of-Day Cost Report*` });
  const level = data.dailyThresholdExceeded ? 'warning' : 'info';

  await notifyOwner(level, 'End-of-Day Cost Report', body);

  log.info('Evening cost alert sent to owner', {
    todayDollars: data.today.totalDollars,
    monthDollars: data.month.totalDollars,
    budgetPct: data.monthPct,
  });

  return data;
}

// CLI entry point
if (process.argv[1]?.endsWith('daily-cost-alert.js')) {
  const mode = process.argv[2] || 'evening';
  const fn = mode === 'morning' ? runMorningCostAlert : runEveningCostAlert;
  fn()
    .then((data) => {
      console.log(`${mode}: Today $${data.today.totalDollars} | Month $${data.month.totalDollars}`);
      process.exit(0);
    })
    .catch(err => { console.error(err); process.exit(1); });
}

export default { runMorningCostAlert, runEveningCostAlert };
