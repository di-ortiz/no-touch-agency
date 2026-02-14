import logger from '../utils/logger.js';
import { deepAnalysis } from '../api/anthropic.js';
import { sendWhatsApp } from '../api/whatsapp.js';
import * as googleDrive from '../api/google-drive.js';
import {
  getClient,
  buildClientContext,
  getClientCampaignHistory,
  getTopCreatives,
} from '../services/knowledge-base.js';
import { auditLog } from '../services/cost-tracker.js';
import { SYSTEM_PROMPTS, USER_PROMPTS } from '../prompts/templates.js';

const log = logger.child({ workflow: 'media-plan' });

/**
 * Workflow: Media Plan Generator
 * Generates a full media plan based on the client's brief (goals, pains,
 * audience, competitors, budget) and includes creative mockup recommendations.
 * Delivers the plan via WhatsApp in digestible chunks.
 *
 * @param {object} params
 * @param {string} params.clientId - Client ID
 * @param {object} [params.brief] - Optional override brief data
 * @param {string} [params.brief.goals] - Campaign goals
 * @param {string} [params.brief.pains] - Client pain points / challenges
 * @param {string} [params.brief.audience] - Target audience description
 * @param {string} [params.brief.budget] - Budget override
 * @param {string} [params.brief.timeline] - Campaign timeline
 * @param {string} [params.brief.platforms] - Target platforms
 * @param {string} [params.brief.offer] - Special offer / promotion
 */
export async function generateMediaPlan(params) {
  const { clientId, brief = {} } = params;

  const client = getClient(clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  log.info(`Generating media plan for ${client.name}`);

  // 1. Build rich context from knowledge base
  const clientContext = buildClientContext(clientId);
  const history = getClientCampaignHistory(clientId, 20);
  const topCreatives = getTopCreatives(clientId, 10);

  const historySummary = history.length > 0
    ? history.slice(0, 8).map(h =>
      `- ${h.campaign_name} (${h.platform}): ROAS ${h.roas.toFixed(2)}, CPA $${(h.cpa_cents / 100).toFixed(2)}, ${h.conversions} conv, Spend $${(h.spend_cents / 100).toFixed(0)}`
    ).join('\n')
    : 'No campaign history available.';

  const creativeSummary = topCreatives.length > 0
    ? topCreatives.map(c =>
      `- "${c.headline}" (${c.creative_type}): CTR ${(c.ctr * 100).toFixed(2)}%, ${c.conversions} conv`
    ).join('\n')
    : 'No creative performance data.';

  // Merge client profile with any brief overrides
  const mergedBrief = {
    goals: brief.goals || (client.goals ? JSON.stringify(client.goals) : null) || 'Not specified',
    pains: brief.pains || 'Not specified',
    audience: brief.audience || client.target_audience || 'Not specified',
    competitors: (client.competitors || []).join(', ') || 'Not specified',
    budget: brief.budget || `$${((client.monthly_budget_cents || 0) / 100).toFixed(0)}/month`,
    timeline: brief.timeline || 'Ongoing',
    platforms: brief.platforms || determinePlatforms(client),
    offer: brief.offer || null,
    brandVoice: client.brand_voice || 'Professional',
    industry: client.industry || 'Unknown',
    primaryKpi: client.primary_kpi || 'ROAS',
    targetRoas: client.target_roas || null,
    targetCpa: client.target_cpa_cents ? `$${(client.target_cpa_cents / 100).toFixed(2)}` : null,
  };

  // 2. Generate the media plan with Claude
  const response = await deepAnalysis({
    systemPrompt: SYSTEM_PROMPTS.mediaPlanGenerator,
    prompt: USER_PROMPTS.generateMediaPlan({
      clientName: client.name,
      clientContext,
      brief: mergedBrief,
      historySummary,
      creativeSummary,
    }),
    workflow: 'media-plan',
    clientId,
  });

  const mediaPlan = response.text;

  // 3. Generate creative mockup recommendations
  const creativeRecs = await generateCreativeRecommendations({
    clientId,
    client,
    brief: mergedBrief,
    mediaPlan,
    topCreatives: creativeSummary,
  });

  // 4. Send via WhatsApp in structured chunks
  await deliverMediaPlanViaWhatsApp(client.name, mediaPlan, creativeRecs);

  // 5. Save full plan to Google Drive
  if (client.drive_plans_folder_id || client.drive_root_folder_id) {
    try {
      const date = new Date().toISOString().split('T')[0];
      const folderId = client.drive_plans_folder_id || client.drive_root_folder_id;
      await googleDrive.createDocument(
        `${client.name} - Media Plan ${date}`,
        formatFullPlanDocument(client.name, mediaPlan, creativeRecs),
        folderId,
      );
      log.info('Media plan saved to Google Drive');
    } catch (e) {
      log.warn('Failed to save media plan to Drive', { error: e.message });
    }
  }

  // 6. Audit
  auditLog({
    action: 'media_plan_generated',
    workflow: 'media-plan',
    clientId,
    details: {
      platforms: mergedBrief.platforms,
      budget: mergedBrief.budget,
      hasCreativeRecs: !!creativeRecs,
    },
    result: 'success',
  });

  log.info(`Media plan generated for ${client.name}`);

  return {
    mediaPlan,
    creativeRecommendations: creativeRecs,
    clientName: client.name,
  };
}

/**
 * Generate creative mockup recommendations based on the media plan.
 */
async function generateCreativeRecommendations({ clientId, client, brief, mediaPlan, topCreatives }) {
  const response = await deepAnalysis({
    systemPrompt: SYSTEM_PROMPTS.creativeRecommendations,
    prompt: USER_PROMPTS.generateCreativeRecommendations({
      clientName: client.name,
      brandVoice: brief.brandVoice,
      audience: brief.audience,
      platforms: brief.platforms,
      offer: brief.offer,
      mediaPlanSummary: mediaPlan.slice(0, 3000),
      topCreatives,
      industry: brief.industry,
    }),
    workflow: 'creative-recommendations',
    clientId,
  });

  return response.text;
}

/**
 * Deliver the media plan via WhatsApp in digestible chunks.
 */
async function deliverMediaPlanViaWhatsApp(clientName, mediaPlan, creativeRecs) {
  // Part 1: Executive Summary header
  await sendWhatsApp(
    `📋 *Media Plan: ${clientName}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Generated: ${new Date().toISOString().split('T')[0]}\n`
  );

  // Part 2: Send the media plan (auto-split by WhatsApp module)
  const planSections = splitIntoSections(mediaPlan);

  for (const section of planSections) {
    await sendWhatsApp(section);
  }

  // Part 3: Send creative recommendations
  if (creativeRecs) {
    await sendWhatsApp(
      `🎨 *Creative Recommendations*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n`
    );

    const creativeSections = splitIntoSections(creativeRecs);
    for (const section of creativeSections) {
      await sendWhatsApp(section);
    }
  }

  // Part 4: Closing
  await sendWhatsApp(
    `✅ *Media plan for ${clientName} is ready!*\n\n` +
    `📂 Full document saved to Google Drive\n` +
    `Reply with questions or "APPROVE" to proceed with implementation.`
  );
}

/**
 * Split a document into WhatsApp-friendly sections (~3500 chars each).
 */
function splitIntoSections(text) {
  const MAX_LEN = 3500;
  if (text.length <= MAX_LEN) return [text];

  const sections = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    // If adding this line would exceed limit, save current and start new section
    if (current.length + line.length + 1 > MAX_LEN && current.length > 0) {
      sections.push(current.trim());
      current = '';
    }
    current += line + '\n';
  }

  if (current.trim()) {
    sections.push(current.trim());
  }

  return sections;
}

/**
 * Determine which platforms the client is active on.
 */
function determinePlatforms(client) {
  const platforms = [];
  if (client.meta_ad_account_id) platforms.push('Meta (Facebook/Instagram)');
  if (client.google_ads_customer_id) platforms.push('Google Ads');
  if (client.tiktok_advertiser_id) platforms.push('TikTok');
  if (client.twitter_ads_account_id) platforms.push('Twitter/X');
  return platforms.length > 0 ? platforms.join(', ') : 'Meta (recommended starting platform)';
}

/**
 * Format the full plan document for Google Drive.
 */
function formatFullPlanDocument(clientName, mediaPlan, creativeRecs) {
  const date = new Date().toISOString().split('T')[0];
  return [
    `MEDIA PLAN - ${clientName}`,
    `Generated: ${date}`,
    `${'═'.repeat(50)}`,
    '',
    mediaPlan,
    '',
    `${'═'.repeat(50)}`,
    '',
    'CREATIVE RECOMMENDATIONS',
    `${'═'.repeat(50)}`,
    '',
    creativeRecs || 'No creative recommendations generated.',
  ].join('\n');
}

export default { generateMediaPlan };
