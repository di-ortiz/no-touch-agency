import logger from '../utils/logger.js';
import { deepAnalysis } from '../api/anthropic.js';
import { notifyOwnerMessage as sendWhatsApp, notifyOwnerAlert as sendAlert } from '../utils/notify-owner.js';
import * as googleDrive from '../api/google-drive.js';
import * as metaAds from '../api/meta-ads.js';
import * as googleAds from '../api/google-ads.js';
import { getAllClients, getClient, buildClientContext, recordCampaignPerformance } from '../services/knowledge-base.js';
import { SYSTEM_PROMPTS, USER_PROMPTS } from '../prompts/templates.js';

const log = logger.child({ workflow: 'weekly-report' });

/**
 * Workflow 8: Weekly Client Report
 * Runs every Friday at 4 PM. Generates performance reports for all clients.
 */
export async function runWeeklyReports() {
  log.info('Starting weekly report generation');

  const clients = getAllClients();
  const reports = [];

  for (const client of clients) {
    try {
      const report = await generateWeeklyReport(client.id);
      if (report) {
        reports.push({ client: client.name, status: 'success' });
      }
    } catch (e) {
      log.error(`Report failed for ${client.name}`, { error: e.message });
      reports.push({ client: client.name, status: 'failed', error: e.message });
    }
  }

  // Send summary
  const successful = reports.filter(r => r.status === 'success').length;
  const failed = reports.filter(r => r.status === 'failed').length;

  await sendAlert('info', `Weekly Reports: ${successful}/${reports.length} generated`,
    reports.map(r => `${r.status === 'success' ? '✅' : '❌'} ${r.client}`).join('\n'));

  return reports;
}

/**
 * Generate a weekly report for a specific client.
 */
export async function generateWeeklyReport(clientId) {
  const client = getClient(clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  log.info(`Generating weekly report for ${client.name}`);

  // Date ranges
  const now = new Date();
  const thisWeekEnd = now.toISOString().split('T')[0];
  const thisWeekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const lastWeekStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const lastMonthStart = new Date(now.getTime() - 37 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const lastMonthEnd = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  let thisWeekData = '';
  let lastWeekData = '';
  let lastMonthData = '';

  // Pull Meta data
  if (client.meta_ad_account_id) {
    try {
      const tw = await metaAds.getAccountInsights(client.meta_ad_account_id, {
        timeRange: { since: thisWeekStart, until: thisWeekEnd },
      });
      const lw = await metaAds.getAccountInsights(client.meta_ad_account_id, {
        timeRange: { since: lastWeekStart, until: thisWeekStart },
      });
      const lm = await metaAds.getAccountInsights(client.meta_ad_account_id, {
        timeRange: { since: lastMonthStart, until: lastMonthEnd },
      });

      const twM = metaAds.extractConversions(tw);
      const lwM = metaAds.extractConversions(lw);
      const lmM = metaAds.extractConversions(lm);

      if (twM) {
        thisWeekData += formatMetrics('Meta', twM);
        // Record to history
        recordCampaignPerformance({
          clientId: client.id,
          platform: 'meta',
          campaignId: 'account_total',
          campaignName: 'Account Total',
          startDate: thisWeekStart,
          endDate: thisWeekEnd,
          spendCents: Math.round(twM.spend * 100),
          impressions: twM.impressions,
          clicks: twM.clicks,
          conversions: twM.conversions,
          roas: twM.roas,
          cpaCents: Math.round(twM.cpa * 100),
        });
      }
      if (lwM) lastWeekData += formatMetrics('Meta', lwM);
      if (lmM) lastMonthData += formatMetrics('Meta', lmM);
    } catch (e) {
      log.warn(`Meta data pull failed for ${client.name}`, { error: e.message });
      thisWeekData += 'Meta: Data unavailable\n';
    }
  }

  // Pull Google Ads data
  if (client.google_ads_customer_id) {
    try {
      const twResults = await googleAds.getAccountPerformance(client.google_ads_customer_id, {
        start: thisWeekStart, end: thisWeekEnd,
      });
      const lwResults = await googleAds.getAccountPerformance(client.google_ads_customer_id, {
        start: lastWeekStart, end: thisWeekStart,
      });

      if (twResults.length > 0) {
        const twM = googleAds.formatGoogleAdsMetrics(twResults[0]);
        thisWeekData += formatGoogleMetrics('Google Ads', twM);
      }
      if (lwResults.length > 0) {
        const lwM = googleAds.formatGoogleAdsMetrics(lwResults[0]);
        lastWeekData += formatGoogleMetrics('Google Ads', lwM);
      }
    } catch (e) {
      log.warn(`Google data pull failed for ${client.name}`, { error: e.message });
      thisWeekData += 'Google Ads: Data unavailable\n';
    }
  }

  if (!thisWeekData) {
    log.info(`No data available for ${client.name}, skipping report`);
    return null;
  }

  // Generate report with Claude
  const targets = [
    `ROAS Target: ${client.target_roas || 'Not set'}`,
    `CPA Target: $${((client.target_cpa_cents || 0) / 100).toFixed(2)}`,
    `Monthly Budget: $${((client.monthly_budget_cents || 0) / 100).toFixed(0)}`,
    `Primary KPI: ${client.primary_kpi || 'Not set'}`,
  ].join('\n');

  const response = await deepAnalysis({
    systemPrompt: SYSTEM_PROMPTS.clientReport,
    prompt: USER_PROMPTS.weeklyReport({
      clientName: client.name,
      industry: client.industry || 'N/A',
      period: `${thisWeekStart} to ${thisWeekEnd}`,
      thisWeek: thisWeekData || 'No data',
      lastWeek: lastWeekData || 'No data',
      lastMonth: lastMonthData || 'No data',
      targets,
      activeTests: 'None documented',
    }),
    workflow: 'weekly-report',
    clientId: client.id,
  });

  // Save to Google Drive
  if (client.drive_reports_folder_id) {
    try {
      await googleDrive.createDocument(
        `${client.name} - Weekly Report ${thisWeekStart}`,
        response.text,
        client.drive_reports_folder_id,
      );
    } catch (e) {
      log.warn('Failed to save report to Drive', { error: e.message });
    }
  }

  // Send summary via WhatsApp
  const summary = response.text.split('\n').slice(0, 20).join('\n');
  await sendWhatsApp(`📊 *Weekly Report: ${client.name}*\n${thisWeekStart} to ${thisWeekEnd}\n\n${summary}\n\n_Full report saved to Google Drive_`);

  return { clientName: client.name, report: response.text };
}

function formatMetrics(platform, m) {
  return `${platform}:\n  Spend: $${m.spend.toFixed(2)}\n  ROAS: ${m.roas.toFixed(2)}\n  CPA: $${m.cpa.toFixed(2)}\n  Conversions: ${m.conversions}\n  Clicks: ${m.clicks}\n  CTR: ${m.ctr.toFixed(2)}%\n  Impressions: ${m.impressions.toLocaleString()}\n  Reach: ${m.reach?.toLocaleString() || 'N/A'}\n  Frequency: ${m.frequency?.toFixed(1) || 'N/A'}\n\n`;
}

function formatGoogleMetrics(platform, m) {
  return `${platform}:\n  Spend: $${m.cost}\n  ROAS: ${m.roas.toFixed(2)}\n  CPA: $${m.cpa.toFixed(2)}\n  Conversions: ${m.conversions}\n  Clicks: ${m.clicks}\n  CTR: ${m.ctr.toFixed(2)}%\n  Impressions: ${m.impressions.toLocaleString()}\n\n`;
}

export default { runWeeklyReports, generateWeeklyReport };
