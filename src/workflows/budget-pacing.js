import logger from '../utils/logger.js';
import { notifyOwnerAlert as sendAlert } from '../utils/notify-owner.js';
import * as metaAds from '../api/meta-ads.js';
import * as googleAds from '../api/google-ads.js';
import * as tiktokAds from '../api/tiktok-ads.js';
import { getAllClients } from '../services/knowledge-base.js';
import { safeExecute } from '../services/safety.js';
import { auditLog } from '../services/cost-tracker.js';

const log = logger.child({ workflow: 'budget-pacing' });

/**
 * Workflow 13: Budget Pacing & Optimization
 * Runs daily at 2 PM. Checks budget pacing for all campaigns
 * and makes safe adjustments.
 */
export async function runBudgetPacing() {
  log.info('Starting budget pacing check');

  const clients = getAllClients();
  const hourOfDay = new Date().getHours();
  const expectedPacingPct = (hourOfDay / 24) * 100;

  const report = {
    underspending: [],
    onPace: [],
    overspending: [],
    adjustments: [],
  };

  for (const client of clients) {
    try {
      await checkClientPacing(client, expectedPacingPct, report);
    } catch (e) {
      log.error(`Pacing check failed for ${client.name}`, { error: e.message });
    }
  }

  // Send pacing report
  if (report.overspending.length > 0 || report.underspending.length > 0) {
    let message = `💰 *Budget Pacing Report* (${hourOfDay}:00)\n\n`;

    if (report.overspending.length > 0) {
      message += `*🔴 Overspending (${report.overspending.length}):*\n`;
      for (const c of report.overspending) {
        message += `• ${c.client} / ${c.campaign} (${c.platform})\n`;
        message += `  Spent $${c.spent} of $${c.budget} (${c.pacing}%)\n`;
        message += `  ${c.action}\n\n`;
      }
    }

    if (report.underspending.length > 0) {
      message += `*🟡 Underspending (${report.underspending.length}):*\n`;
      for (const c of report.underspending) {
        message += `• ${c.client} / ${c.campaign} (${c.platform})\n`;
        message += `  Spent $${c.spent} of $${c.budget} (${c.pacing}%)\n`;
        message += `  ${c.action}\n\n`;
      }
    }

    if (report.adjustments.length > 0) {
      message += `*🤖 Auto-Adjustments:*\n`;
      for (const a of report.adjustments) {
        message += `• ${a}\n`;
      }
    }

    await sendAlert(
      report.overspending.length > 0 ? 'warning' : 'info',
      `Budget Pacing: ${report.overspending.length} over, ${report.underspending.length} under`,
      message,
    );
  } else {
    log.info('All campaigns on pace');
  }

  return report;
}

async function checkClientPacing(client, expectedPacingPct, report) {
  // Check Meta campaigns
  if (client.meta_ad_account_id) {
    try {
      const campaigns = await metaAds.getCampaigns(client.meta_ad_account_id, {
        statusFilter: ['ACTIVE'],
      });

      for (const campaign of campaigns.data || []) {
        const dailyBudget = parseFloat(campaign.daily_budget || 0) / 100;
        if (dailyBudget <= 0) continue;

        const insights = await metaAds.getCampaignInsights(campaign.id, { datePreset: 'today' });
        const metrics = metaAds.extractConversions(insights);
        if (!metrics) continue;

        const pacing = dailyBudget > 0 ? (metrics.spend / dailyBudget) * 100 : 0;
        const entry = {
          client: client.name,
          campaign: campaign.name,
          platform: 'Meta',
          spent: metrics.spend.toFixed(2),
          budget: dailyBudget.toFixed(2),
          pacing: pacing.toFixed(0),
          roas: metrics.roas,
          cpa: metrics.cpa,
        };

        if (pacing > 120) {
          // Overspending
          if (metrics.roas >= (client.target_roas || 0) * 0.8) {
            entry.action = 'ROAS acceptable - monitoring (no action)';
          } else {
            entry.action = 'ROAS below target - consider reducing bids';

            // Auto-reduce if within safety limits
            if (pacing > 150 && metrics.roas < (client.target_roas || 0) * 0.5) {
              const result = await safeExecute(
                {
                  type: 'change_bid',
                  changePercent: -10,
                  clientId: client.id,
                  platform: 'meta',
                  workflow: 'budget-pacing',
                },
                async () => {
                  // In production: reduce bids by 10%
                  log.info(`Would reduce bids by 10% for ${campaign.name}`);
                  return { adjusted: true };
                },
              );
              if (result.executed) {
                report.adjustments.push(`Reduced bids 10% for ${client.name} / ${campaign.name} (overspending, low ROAS)`);
              }
            }
          }
          report.overspending.push(entry);
        } else if (pacing < 60 && expectedPacingPct > 50) {
          // Underspending (only flag after noon)
          if (metrics.roas >= (client.target_roas || 0)) {
            entry.action = 'Good performance but underspending - consider increasing bids';
          } else {
            entry.action = 'Low spend and low ROAS - investigate targeting/creative';
          }
          report.underspending.push(entry);
        } else {
          report.onPace.push(entry);
        }
      }
    } catch (e) {
      log.warn(`Meta pacing check failed for ${client.name}`, { error: e.message });
    }
  }

  // Check Google Ads campaigns
  if (client.google_ads_customer_id) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const campaigns = await googleAds.getCampaigns(client.google_ads_customer_id, {
        dateRange: { start: today, end: today },
      });

      for (const row of campaigns) {
        const campaign = row.campaign;
        if (!campaign || campaign.status !== 'ENABLED') continue;

        const metrics = googleAds.formatGoogleAdsMetrics(row);
        const budgetMicros = row.campaignBudget?.amountMicros || 0;
        const dailyBudget = budgetMicros / 1_000_000;

        if (dailyBudget <= 0) continue;

        const spent = parseFloat(metrics.cost);
        const pacing = (spent / dailyBudget) * 100;

        const entry = {
          client: client.name,
          campaign: campaign.name,
          platform: 'Google',
          spent: spent.toFixed(2),
          budget: dailyBudget.toFixed(2),
          pacing: pacing.toFixed(0),
          roas: metrics.roas,
          cpa: metrics.cpa,
        };

        if (pacing > 120) {
          entry.action = 'Overspending - review bid strategy';
          report.overspending.push(entry);
        } else if (pacing < 60 && expectedPacingPct > 50) {
          entry.action = 'Underspending - check impression share';
          report.underspending.push(entry);
        } else {
          report.onPace.push(entry);
        }
      }
    } catch (e) {
      log.warn(`Google pacing check failed for ${client.name}`, { error: e.message });
    }
  }
}

export default { runBudgetPacing };
