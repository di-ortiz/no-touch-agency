import logger from '../utils/logger.js';
import { getCostSummary, isDailyBudgetExceeded } from '../services/cost-tracker.js';
import { sendAlert } from '../api/whatsapp.js';
import config from '../config.js';

const log = logger.child({ workflow: 'daily-cost-alert' });

/**
 * Daily Cost Alert — sends a WhatsApp summary of today's AI/API spend
 * to the agency owner every evening.  Includes:
 *   • Total $ spent today, this week, and this month
 *   • Breakdown by platform (Anthropic, OpenAI, WhatsApp, etc.)
 *   • Breakdown by workflow (morning-briefing, daily-monitor, etc.)
 *   • Top-spending clients
 *   • Budget utilisation % and warnings
 */
export async function runDailyCostAlert() {
  log.info('Generating daily cost alert');

  const today = getCostSummary('today');
  const week = getCostSummary('week');
  const month = getCostSummary('month');

  const budgetCents = config.MONTHLY_AI_BUDGET_CENTS || 100_000;
  const budgetDollars = (budgetCents / 100).toFixed(0);
  const monthPct = ((month.totalCents / budgetCents) * 100).toFixed(1);
  const dailyThresholdExceeded = isDailyBudgetExceeded();

  // --- Build message ---
  const lines = [
    `*Daily AI Cost Report*`,
    ``,
    `*Today:*  $${today.totalDollars}`,
    `*Last 7 days:*  $${week.totalDollars}`,
    `*This month:*  $${month.totalDollars}  (${monthPct}% of $${budgetDollars} budget)`,
  ];

  // Warning banner
  if (dailyThresholdExceeded) {
    lines.splice(1, 0, `*Daily spend threshold exceeded!*`);
  }
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

  const level = dailyThresholdExceeded ? 'warning' : 'info';
  await sendAlert(level, 'Daily AI Cost Report', lines.join('\n'));

  log.info('Daily cost alert sent', {
    todayDollars: today.totalDollars,
    monthDollars: month.totalDollars,
    budgetPct: monthPct,
  });

  return { today, week, month, dailyThresholdExceeded };
}

// CLI entry point
if (process.argv[1]?.endsWith('daily-cost-alert.js')) {
  runDailyCostAlert()
    .then(({ today, month }) => {
      console.log(`Daily: $${today.totalDollars} | Month: $${month.totalDollars}`);
      process.exit(0);
    })
    .catch(err => { console.error(err); process.exit(1); });
}

export default runDailyCostAlert;
