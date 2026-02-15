import logger from '../utils/logger.js';
import { deepAnalysis } from '../api/anthropic.js';
import { sendAlert, sendWhatsApp } from '../api/whatsapp.js';
import * as clickup from '../api/clickup.js';
import * as googleDrive from '../api/google-drive.js';
import * as hubspot from '../api/hubspot.js';
import * as metaAds from '../api/meta-ads.js';
import * as googleAds from '../api/google-ads.js';
import { createClient, getClient, updateClient, buildClientContext } from '../services/knowledge-base.js';
import { ingestBrandAssets } from '../services/brand-ingestion.js';
import { auditLog } from '../services/cost-tracker.js';
import config from '../config.js';

const log = logger.child({ workflow: 'onboarding' });

/**
 * Workflow 2: New Client Onboarding
 * Triggered when a new PPC client is added to HubSpot or manually.
 * Creates the full operational infrastructure for a new client.
 */
export async function onboardNewClient(clientData) {
  const {
    name,
    hubspotDealId,
    industry,
    website,
    description,
    monthlyBudgetCents,
    targetRoas,
    targetCpaCents,
    primaryKpi,
    competitors,
    metaAdAccountId,
    googleAdsCustomerId,
    tiktokAdvertiserId,
    clickupListId,
  } = clientData;

  log.info(`Starting onboarding for ${name}`);
  const steps = [];
  const errors = [];

  // Step 1: Create client in knowledge base
  let client;
  try {
    client = createClient({
      name,
      hubspotId: hubspotDealId,
      industry,
      website,
      description,
      monthlyBudgetCents: monthlyBudgetCents || 0,
      targetRoas: targetRoas || 0,
      targetCpaCents: targetCpaCents || 0,
      primaryKpi: primaryKpi || 'ROAS',
      competitors: competitors || [],
      metaAdAccountId,
      googleAdsCustomerId,
      tiktokAdvertiserId,
    });
    steps.push('✅ Client profile created in knowledge base');
  } catch (e) {
    log.error(`Failed to create client profile`, { error: e.message });
    errors.push(`Client profile: ${e.message}`);
    return { success: false, steps, errors };
  }

  // Step 2: Create Google Drive folder structure
  try {
    const folders = await googleDrive.ensureClientFolders(name);
    if (folders) {
      updateClient(client.id, {
        drive_root_folder_id: folders.root.id,
        drive_reports_folder_id: folders.reports?.id,
        drive_creatives_folder_id: folders.creatives?.id,
        drive_plans_folder_id: folders.strategic_plans?.id,
      });
      steps.push(`✅ Google Drive folders created`);
    } else {
      steps.push('⬜ Google Drive skipped (not configured)');
    }
  } catch (e) {
    log.warn(`Drive folder creation failed`, { error: e.message });
    errors.push(`Google Drive: ${e.message}`);
    steps.push('⚠️ Google Drive folders failed');
  }

  // Step 3: Create ClickUp project
  try {
    if (clickupListId || config.CLICKUP_PPC_SPACE_ID) {
      const listId = clickupListId || config.CLICKUP_PPC_SPACE_ID;
      const tasks = await clickup.createOnboardingProject(name, listId);
      if (tasks.length > 0) {
        updateClient(client.id, { clickup_list_id: listId });
      }
      steps.push(`✅ ClickUp project created (${tasks.length} tasks)`);
    } else {
      steps.push('⬜ ClickUp skipped (no list ID)');
    }
  } catch (e) {
    log.warn(`ClickUp project creation failed`, { error: e.message });
    errors.push(`ClickUp: ${e.message}`);
    steps.push('⚠️ ClickUp project failed');
  }

  // Step 4: Pull historical ad account data and run audit
  let auditReport = null;
  try {
    auditReport = await runAccountAudit(client);
    if (auditReport) {
      steps.push('✅ Account audit completed');
    } else {
      steps.push('⬜ Account audit skipped (no ad accounts linked)');
    }
  } catch (e) {
    log.warn(`Account audit failed`, { error: e.message });
    errors.push(`Audit: ${e.message}`);
    steps.push('⚠️ Account audit failed');
  }

  // Step 5: Generate 90-day strategic plan
  let strategicPlan = null;
  try {
    strategicPlan = await generateStrategicPlan(client, auditReport);
    if (strategicPlan) {
      // Save to Google Drive
      const planFolder = client.drive_plans_folder_id;
      if (planFolder) {
        await googleDrive.createDocument(
          `${name} - 90-Day Strategic Plan`,
          strategicPlan.content,
          planFolder,
        );
      }
      steps.push('✅ 90-day strategic plan generated');
    }
  } catch (e) {
    log.warn(`Strategic plan generation failed`, { error: e.message });
    errors.push(`Strategic plan: ${e.message}`);
    steps.push('⚠️ Strategic plan failed');
  }

  // Step 6: Send onboarding summary
  const onboardingSummary = [
    `🎉 *New Client Onboarded: ${name}*\n`,
    `*Industry:* ${industry || 'N/A'}`,
    `*Budget:* $${((monthlyBudgetCents || 0) / 100).toFixed(0)}/month`,
    `*Target ROAS:* ${targetRoas || 'N/A'}`,
    `*Platforms:* ${[metaAdAccountId && 'Meta', googleAdsCustomerId && 'Google', tiktokAdvertiserId && 'TikTok'].filter(Boolean).join(', ') || 'None linked yet'}`,
    `\n*Onboarding Steps:*`,
    ...steps,
    errors.length > 0 ? `\n*Issues:*\n${errors.map(e => `⚠️ ${e}`).join('\n')}` : '',
    strategicPlan ? `\n📄 Strategic plan ready for review in Google Drive` : '',
  ].filter(Boolean).join('\n');

  await sendWhatsApp(onboardingSummary);

  auditLog({
    action: 'client_onboarded',
    workflow: 'onboarding',
    clientId: client.id,
    details: { name, steps, errors },
    approvedBy: 'system',
    result: errors.length === 0 ? 'success' : 'partial',
  });

  log.info(`Onboarding complete for ${name}`, { steps: steps.length, errors: errors.length });
  return { success: true, clientId: client.id, steps, errors, auditReport, strategicPlan };
}

/**
 * Run a comprehensive account audit for a client.
 * Pulls last 12 months of data and generates analysis.
 */
export async function runAccountAudit(client) {
  if (typeof client === 'string') client = getClient(client);
  if (!client) throw new Error('Client not found');

  const hasAccounts = client.meta_ad_account_id || client.google_ads_customer_id;
  if (!hasAccounts) return null;

  log.info(`Running account audit for ${client.name}`);

  let metaData = null;
  let googleData = null;

  // Pull last 12 months of Meta data
  if (client.meta_ad_account_id) {
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 12);

      metaData = await metaAds.getAccountInsights(client.meta_ad_account_id, {
        timeRange: {
          since: startDate.toISOString().split('T')[0],
          until: endDate.toISOString().split('T')[0],
        },
        level: 'account',
      });
    } catch (e) {
      log.warn(`Failed to pull Meta historical data`, { error: e.message });
    }
  }

  // Pull last 12 months of Google Ads data
  if (client.google_ads_customer_id) {
    try {
      const endDate = new Date().toISOString().split('T')[0];
      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 12);

      googleData = await googleAds.getCampaigns(client.google_ads_customer_id, {
        dateRange: { start: startDate.toISOString().split('T')[0], end: endDate },
      });
    } catch (e) {
      log.warn(`Failed to pull Google Ads historical data`, { error: e.message });
    }
  }

  // Generate audit with Claude
  const auditPrompt = `Perform a comprehensive PPC account audit for ${client.name}.

Client Info:
- Industry: ${client.industry || 'Unknown'}
- Website: ${client.website || 'Unknown'}
- Monthly Budget: $${((client.monthly_budget_cents || 0) / 100).toFixed(0)}
- Target ROAS: ${client.target_roas || 'Not set'}
- Target CPA: $${((client.target_cpa_cents || 0) / 100).toFixed(2)}

Meta Ads Data (12 months):
${metaData ? JSON.stringify(metaData, null, 2).slice(0, 3000) : 'No data available'}

Google Ads Data (12 months):
${googleData ? JSON.stringify(googleData.slice(0, 20), null, 2).slice(0, 3000) : 'No data available'}

Generate an audit covering:
1. **Performance Overview** - Key metrics, trends over 12 months
2. **What Worked** - Top performing campaigns, audiences, creatives
3. **What Failed** - Underperforming areas, wasted spend
4. **Audience Analysis** - Who converts best, untapped segments
5. **Creative Analysis** - Ad format performance, messaging themes
6. **Budget Efficiency** - Where money went, ROI by channel
7. **Seasonality Patterns** - Monthly trends, peak periods
8. **Competitive Gaps** - Opportunities based on data patterns
9. **Immediate Opportunities** - Quick wins to implement now
10. **Strategic Recommendations** - Long-term improvements

Be specific with numbers. If data is limited, note assumptions and recommend data collection.`;

  const response = await deepAnalysis({
    prompt: auditPrompt,
    workflow: 'account-audit',
    clientId: client.id,
  });

  return {
    content: response.text,
    metaDataAvailable: !!metaData,
    googleDataAvailable: !!googleData,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Generate a 90-day strategic plan.
 */
export async function generateStrategicPlan(client, auditReport) {
  if (typeof client === 'string') client = getClient(client);
  if (!client) throw new Error('Client not found');

  const clientContext = buildClientContext(client.id);

  const planPrompt = `Create a detailed 90-day PPC media plan for ${client.name}.

${clientContext}

${auditReport ? `Account Audit Summary:\n${auditReport.content.slice(0, 3000)}` : 'No audit data available - create plan based on client profile.'}

Generate a plan with:

## Month 1: Foundation & Quick Wins (Days 1-30)
- Week-by-week tactical plan
- Campaign structure recommendations
- Budget allocation by platform and campaign type
- Audience strategy (targeting, remarketing, lookalikes)
- Creative strategy (formats, messaging themes, testing plan)
- KPI targets for the month

## Month 2: Optimization & Expansion (Days 31-60)
- Scaling what works from Month 1
- New audience testing
- Creative refresh strategy
- Cross-channel integration
- Budget reallocation based on performance
- Updated KPI targets

## Month 3: Scale & Diversify (Days 61-90)
- Full funnel optimization
- New channel testing
- Advanced audience strategies
- Performance-based budget scaling
- Long-term strategic positioning
- 90-day review criteria

## Budget Breakdown
- Monthly allocation by platform
- Campaign type split (prospecting vs remarketing)
- Creative production budget

## Success Metrics
- Primary KPI targets by month
- Secondary metrics to track
- Review cadence

Be specific with budgets, audience sizes, and expected outcomes.`;

  const response = await deepAnalysis({
    systemPrompt: 'You are a senior PPC strategist with 10+ years of experience. Create detailed, actionable media plans with specific budgets, tactics, and timelines.',
    prompt: planPrompt,
    workflow: 'strategic-plan',
    clientId: client.id,
  });

  return {
    content: response.text,
    generatedAt: new Date().toISOString(),
    quarterStart: new Date().toISOString().split('T')[0],
  };
}

export default { onboardNewClient, runAccountAudit, generateStrategicPlan };
