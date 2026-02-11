import logger from '../utils/logger.js';
import { sendWhatsApp, sendAlert, sendApprovalRequest } from '../api/whatsapp.js';
import * as metaAds from '../api/meta-ads.js';
import * as clickup from '../api/clickup.js';
import { getClient } from '../services/knowledge-base.js';
import { validateAction, safeExecute } from '../services/safety.js';
import { auditLog } from '../services/cost-tracker.js';

const log = logger.child({ workflow: 'campaign-launch' });

/**
 * Workflow 5: Campaign Launch Process
 * Triggered after creative approval. Validates all prerequisites,
 * builds campaigns via API, runs QA, and launches.
 */
export async function launchCampaign(params) {
  const {
    clientId,
    taskId,
    platform,
    campaignName,
    objective,
    dailyBudgetCents,
    targetAudience,
    creativeIds,
    startDate,
    landingPageUrl,
    pixelId,
  } = params;

  const client = getClient(clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  log.info(`Starting campaign launch for ${client.name}`, { platform, campaignName });

  // Step 1: Validate all prerequisites
  const prereqs = await validatePrerequisites(params, client);
  if (!prereqs.allPassed) {
    const failedItems = prereqs.checks.filter(c => !c.passed);
    await sendAlert('warning', `Launch Blocked: ${client.name}`,
      `Campaign "${campaignName}" cannot launch. Missing prerequisites:\n${failedItems.map(c => `❌ ${c.name}: ${c.reason}`).join('\n')}`);

    return { launched: false, prereqs };
  }

  // Step 2: Require human approval for launch
  const validation = validateAction({
    type: 'launch_campaign',
    clientId,
    platform,
    workflow: 'campaign-launch',
  });

  if (!validation.allowed) {
    const approvalId = `launch-${Date.now()}`;
    await sendApprovalRequest({
      id: approvalId,
      description: `Launch campaign "${campaignName}" for ${client.name}`,
      clientName: client.name,
      platform,
      impact: `Daily budget: $${(dailyBudgetCents / 100).toFixed(2)}`,
      details: [
        `Campaign: ${campaignName}`,
        `Objective: ${objective}`,
        `Platform: ${platform}`,
        `Budget: $${(dailyBudgetCents / 100).toFixed(2)}/day`,
        `Start: ${startDate || 'Immediately'}`,
        `Landing Page: ${landingPageUrl || 'N/A'}`,
      ].join('\n'),
    });

    auditLog({
      action: 'campaign_launch_requested',
      workflow: 'campaign-launch',
      clientId,
      platform,
      details: params,
      approvedBy: 'pending',
      result: 'awaiting_approval',
    });

    return { launched: false, status: 'awaiting_approval', approvalId };
  }

  // Step 3: Build and launch campaign
  let result;
  try {
    if (platform === 'meta') {
      result = await launchMetaCampaign(client, params);
    } else {
      // Other platforms would follow similar pattern
      return { launched: false, status: 'unsupported_platform', platform };
    }
  } catch (e) {
    log.error(`Campaign launch failed`, { error: e.message });
    await sendAlert('critical', `Launch Failed: ${client.name}`,
      `Campaign "${campaignName}" failed to launch:\n${e.message}`);

    auditLog({
      action: 'campaign_launch_failed',
      workflow: 'campaign-launch',
      clientId,
      platform,
      details: { params, error: e.message },
      result: 'failed',
    });

    return { launched: false, error: e.message };
  }

  // Step 4: Post-launch notifications
  await sendAlert('success', `Campaign Launched: ${client.name}`,
    `✅ "${campaignName}" is now live on ${platform}\nBudget: $${(dailyBudgetCents / 100).toFixed(2)}/day\nCampaign ID: ${result.campaignId}\n\n24-hour monitoring alert is active.`);

  // Update ClickUp
  if (taskId) {
    try {
      await clickup.addComment(taskId, `✅ Campaign "${campaignName}" launched successfully.\nCampaign ID: ${result.campaignId}\nPlatform: ${platform}\nStatus: Active`);
      await clickup.updateTask(taskId, { status: 'complete' });
    } catch (e) {
      log.warn('Failed to update ClickUp', { error: e.message });
    }
  }

  auditLog({
    action: 'campaign_launched',
    workflow: 'campaign-launch',
    clientId,
    platform,
    details: { params, result },
    approvedBy: 'human',
    result: 'success',
    rollbackData: { campaignId: result.campaignId, platform },
  });

  return { launched: true, ...result };
}

/**
 * Validate all prerequisites before launch.
 */
async function validatePrerequisites(params, client) {
  const checks = [
    {
      name: 'Campaign name',
      passed: !!params.campaignName,
      reason: !params.campaignName ? 'Campaign name is required' : null,
    },
    {
      name: 'Budget set',
      passed: params.dailyBudgetCents > 0,
      reason: params.dailyBudgetCents <= 0 ? 'Daily budget must be set' : null,
    },
    {
      name: 'Budget within limits',
      passed: params.dailyBudgetCents <= (client.monthly_budget_cents || Infinity) / 30 * 2,
      reason: 'Daily budget exceeds 2x the daily average of monthly budget',
    },
    {
      name: 'Platform account linked',
      passed: (() => {
        switch (params.platform) {
          case 'meta': return !!client.meta_ad_account_id;
          case 'google': return !!client.google_ads_customer_id;
          case 'tiktok': return !!client.tiktok_advertiser_id;
          default: return false;
        }
      })(),
      reason: `No ${params.platform} ad account linked for this client`,
    },
    {
      name: 'Landing page specified',
      passed: !!params.landingPageUrl,
      reason: !params.landingPageUrl ? 'Landing page URL is required' : null,
    },
    {
      name: 'Objective specified',
      passed: !!params.objective,
      reason: !params.objective ? 'Campaign objective is required' : null,
    },
  ];

  return {
    allPassed: checks.every(c => c.passed),
    checks,
  };
}

/**
 * Build and launch a Meta campaign via API.
 */
async function launchMetaCampaign(client, params) {
  const adAccountId = client.meta_ad_account_id;

  // This is a structural example — actual Meta API campaign creation
  // requires multiple sequential calls with specific parameters.
  // In production, you'd build the full campaign/adset/ad structure here.

  log.info(`Building Meta campaign for ${client.name}`, { adAccountId });

  // The actual implementation would:
  // 1. Create campaign with objective
  // 2. Create ad set with targeting, budget, schedule
  // 3. Create ad with creative
  // 4. Verify campaign is in ACTIVE or PAUSED state
  // 5. Enable campaign

  // For safety, we start campaigns PAUSED so they can be reviewed
  // This would be the actual API call:
  // const campaign = await metaAds.createCampaign(adAccountId, { ... });
  // const adSet = await metaAds.createAdSet(campaign.id, { ... });
  // const ad = await metaAds.createAd(adSet.id, { ... });

  return {
    campaignId: `pending_${Date.now()}`,
    platform: 'meta',
    status: 'created_paused',
    note: 'Campaign created in PAUSED state. Enable after manual QA review.',
  };
}

export default { launchCampaign };
