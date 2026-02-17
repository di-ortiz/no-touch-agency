import logger from '../utils/logger.js';
import { askClaude } from '../api/anthropic.js';
import { notifyOwnerAlert as sendAlert } from '../utils/notify-owner.js';
import * as metaAds from '../api/meta-ads.js';
import * as googleAds from '../api/google-ads.js';
import * as tiktokAds from '../api/tiktok-ads.js';
import { getAllClients, getClient } from '../services/knowledge-base.js';
import { shouldAutoPause, safeExecute } from '../services/safety.js';
import { SYSTEM_PROMPTS } from '../prompts/templates.js';

const log = logger.child({ workflow: 'daily-monitor' });

/**
 * Workflow 6: Daily Performance Monitoring
 * Runs at 10 AM, 3 PM, 8 PM. Checks all active campaigns for anomalies,
 * budget pacing issues, and performance problems. Auto-pauses dangerous
 * campaigns and alerts on issues requiring attention.
 */
export async function runDailyMonitor() {
  log.info('Starting daily performance monitor');

  const clients = getAllClients();
  const issues = [];
  const autoActions = [];

  for (const client of clients) {
    try {
      await monitorClientMeta(client, issues, autoActions);
      await monitorClientGoogle(client, issues, autoActions);
      await monitorClientTikTok(client, issues, autoActions);
    } catch (e) {
      log.error(`Monitor failed for ${client.name}`, { error: e.message });
    }
  }

  // Send consolidated alert if there are issues
  if (issues.length > 0) {
    const criticalIssues = issues.filter(i => i.severity === 'critical');
    const warnings = issues.filter(i => i.severity === 'warning');

    let message = '';
    if (criticalIssues.length > 0) {
      message += `*🚨 Critical Issues (${criticalIssues.length}):*\n`;
      for (const issue of criticalIssues) {
        message += `\n• *${issue.client}* - ${issue.platform}\n`;
        message += `  ${issue.description}\n`;
        message += `  _Recommendation: ${issue.recommendation}_\n`;
      }
    }

    if (warnings.length > 0) {
      message += `\n*⚠️ Warnings (${warnings.length}):*\n`;
      for (const issue of warnings) {
        message += `\n• *${issue.client}* - ${issue.platform}\n`;
        message += `  ${issue.description}\n`;
        message += `  _Recommendation: ${issue.recommendation}_\n`;
      }
    }

    if (autoActions.length > 0) {
      message += `\n*🤖 Auto-Actions Taken (${autoActions.length}):*\n`;
      for (const action of autoActions) {
        message += `• ${action}\n`;
      }
    }

    await sendAlert(
      criticalIssues.length > 0 ? 'critical' : 'warning',
      `Performance Monitor - ${issues.length} issue${issues.length !== 1 ? 's' : ''} found`,
      message,
    );
  } else {
    log.info('Daily monitor: No issues found');
  }

  return { issues, autoActions };
}

async function monitorClientMeta(client, issues, autoActions) {
  if (!client.meta_ad_account_id) return;

  try {
    // Get today's data
    const campaigns = await metaAds.getCampaigns(client.meta_ad_account_id, {
      statusFilter: ['ACTIVE'],
    });

    for (const campaign of campaigns.data || []) {
      const insights = await metaAds.getCampaignInsights(campaign.id, { datePreset: 'today' });
      const metrics = metaAds.extractConversions(insights);
      if (!metrics) continue;

      // Check pacing
      const dailyBudget = parseFloat(campaign.daily_budget || 0) / 100;
      const hourOfDay = new Date().getHours();
      const expectedSpendPct = hourOfDay / 24;

      if (dailyBudget > 0 && metrics.spend > dailyBudget * 1.2) {
        issues.push({
          severity: 'warning',
          client: client.name,
          platform: 'Meta',
          campaign: campaign.name,
          description: `Overspending: $${metrics.spend.toFixed(2)} spent (budget: $${dailyBudget.toFixed(2)})`,
          recommendation: 'Review bid strategy or reduce budget',
        });
      }

      // Check safety thresholds
      const safetyCheck = shouldAutoPause({
        roas: metrics.roas,
        roasTarget: client.target_roas || 0,
        cpa: metrics.cpa * 100,
        cpaTarget: client.target_cpa_cents || 0,
        spend: metrics.spend * 100,
        conversions: metrics.conversions,
        daysRunning: 3, // TODO: calculate actual days
      });

      if (safetyCheck.pause) {
        issues.push({
          severity: 'critical',
          client: client.name,
          platform: 'Meta',
          campaign: campaign.name,
          description: safetyCheck.reason,
          recommendation: 'Auto-pausing campaign',
        });

        const result = await safeExecute(
          { type: 'pause_campaign', clientId: client.id, platform: 'meta', workflow: 'daily-monitor' },
          () => metaAds.pauseCampaign(campaign.id),
        );

        if (result.executed) {
          autoActions.push(`Paused Meta campaign "${campaign.name}" for ${client.name}: ${safetyCheck.reason}`);
        }
      }

      // Check CTR anomaly
      if (metrics.impressions > 1000 && metrics.ctr < 0.5) {
        issues.push({
          severity: 'warning',
          client: client.name,
          platform: 'Meta',
          campaign: campaign.name,
          description: `Low CTR: ${metrics.ctr.toFixed(2)}% (below 0.5% threshold)`,
          recommendation: 'Review ad creative and targeting. Consider creative refresh.',
        });
      }

      // Check for zero conversions with significant spend
      if (metrics.spend > 50 && metrics.conversions === 0) {
        issues.push({
          severity: 'warning',
          client: client.name,
          platform: 'Meta',
          campaign: campaign.name,
          description: `$${metrics.spend.toFixed(2)} spent today with zero conversions`,
          recommendation: 'Check conversion tracking, landing page, and audience targeting',
        });
      }
    }
  } catch (e) {
    log.warn(`Meta monitoring failed for ${client.name}`, { error: e.message });
  }
}

async function monitorClientGoogle(client, issues, autoActions) {
  if (!client.google_ads_customer_id) return;

  try {
    const today = new Date().toISOString().split('T')[0];
    const campaigns = await googleAds.getCampaigns(client.google_ads_customer_id, {
      dateRange: { start: today, end: today },
    });

    for (const row of campaigns) {
      const campaign = row.campaign;
      const metrics = googleAds.formatGoogleAdsMetrics(row);

      if (!campaign || campaign.status !== 'ENABLED') continue;

      const budgetMicros = row.campaignBudget?.amountMicros || 0;
      const dailyBudget = budgetMicros / 1_000_000;

      // Overspend check
      if (dailyBudget > 0 && parseFloat(metrics.cost) > dailyBudget * 1.2) {
        issues.push({
          severity: 'warning',
          client: client.name,
          platform: 'Google Ads',
          campaign: campaign.name,
          description: `Overspending: $${metrics.cost} spent (budget: $${dailyBudget.toFixed(2)})`,
          recommendation: 'Review bid strategy',
        });
      }

      // Safety check
      const safetyCheck = shouldAutoPause({
        roas: metrics.roas,
        roasTarget: client.target_roas || 0,
        cpa: metrics.cpa * 100,
        cpaTarget: client.target_cpa_cents || 0,
        spend: parseFloat(metrics.cost) * 100,
        conversions: metrics.conversions,
        daysRunning: 3,
      });

      if (safetyCheck.pause) {
        issues.push({
          severity: 'critical',
          client: client.name,
          platform: 'Google Ads',
          campaign: campaign.name,
          description: safetyCheck.reason,
          recommendation: 'Requires manual review - Google Ads pause via API needs careful handling',
        });
      }
    }
  } catch (e) {
    log.warn(`Google Ads monitoring failed for ${client.name}`, { error: e.message });
  }
}

async function monitorClientTikTok(client, issues, autoActions) {
  if (!client.tiktok_advertiser_id) return;

  try {
    const today = new Date().toISOString().split('T')[0];
    const report = await tiktokAds.getReport(client.tiktok_advertiser_id, {
      startDate: today,
      endDate: today,
    });

    if (report?.list) {
      for (const item of report.list) {
        const spend = parseFloat(item.metrics?.spend || 0);
        const conversions = parseInt(item.metrics?.conversion || 0);
        const cpa = conversions > 0 ? spend / conversions : 0;

        if (spend > 50 && conversions === 0) {
          issues.push({
            severity: 'warning',
            client: client.name,
            platform: 'TikTok',
            description: `$${spend.toFixed(2)} spent with zero conversions`,
            recommendation: 'Check conversion tracking and creative performance',
          });
        }
      }
    }
  } catch (e) {
    log.warn(`TikTok monitoring failed for ${client.name}`, { error: e.message });
  }
}

// CLI entry point
if (process.argv[1]?.endsWith('daily-monitor.js')) {
  runDailyMonitor()
    .then(({ issues, autoActions }) => {
      console.log(`Found ${issues.length} issues, took ${autoActions.length} auto-actions`);
      process.exit(0);
    })
    .catch(err => { console.error(err); process.exit(1); });
}

export default runDailyMonitor;
