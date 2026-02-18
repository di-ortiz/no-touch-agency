import logger from '../utils/logger.js';
import { askClaude, deepAnalysis } from '../api/anthropic.js';
import { notifyOwnerMessage as sendWhatsApp, notifyOwnerApproval as sendApprovalRequest } from '../utils/notify-owner.js';
import * as googleDrive from '../api/google-drive.js';
import * as clickup from '../api/clickup.js';
import { getClient, buildClientContext, getTopCreatives, saveCreative } from '../services/knowledge-base.js';
import { auditLog } from '../services/cost-tracker.js';
import { SYSTEM_PROMPTS, USER_PROMPTS } from '../prompts/templates.js';
import { v4 as uuid } from 'uuid';

const log = logger.child({ workflow: 'creative-generation' });

// Platform-specific character limits
const CHAR_LIMITS = {
  meta: { headline: 40, bodyShort: 125, bodyLong: 250, description: 30 },
  google: { headline: 30, description: 90, longHeadline: 90 },
  tiktok: { headline: 100, description: 100 },
  twitter: { headline: 70, body: 280 },
};

/**
 * Workflow 4: Creative Generation & Approval
 * Triggered when a campaign brief is marked complete.
 * Generates ad copy variations and optionally visual concepts.
 */
export async function generateCreatives(params) {
  const {
    clientId,
    taskId,
    platform = 'meta',
    campaignObjective = 'conversions',
    targetAudience,
    keyMessages,
    offer,
    numberOfVariations = 5,
    includeVisuals = false,
  } = params;

  const client = getClient(clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  log.info(`Generating creatives for ${client.name}`, { platform, objective: campaignObjective });

  // 1. Build context
  const clientContext = buildClientContext(clientId);
  const topCreatives = getTopCreatives(clientId, 10);
  const limits = CHAR_LIMITS[platform] || CHAR_LIMITS.meta;

  const topPerformingCopy = topCreatives.length > 0
    ? topCreatives.map(c => `- "${c.headline}" / "${c.body_copy}" (CTR: ${(c.ctr * 100).toFixed(2)}%, ${c.conversions} conv)`).join('\n')
    : 'No past performance data available.';

  // 2. Generate ad copy
  const copyResponse = await deepAnalysis({
    systemPrompt: SYSTEM_PROMPTS.adCopyWriter,
    prompt: USER_PROMPTS.generateAdCopy({
      clientName: client.name,
      platform,
      objective: campaignObjective,
      targetAudience: targetAudience || client.target_audience || 'See client profile',
      brandVoice: client.brand_voice || 'Professional and engaging',
      keyMessages: keyMessages || 'Focus on core value proposition',
      offer: offer || null,
      topPerformingCopy,
    }),
    workflow: 'creative-generation',
    clientId,
  });

  const adCopy = copyResponse.text;

  // 3. Run brand compliance check
  const complianceCheck = await checkBrandCompliance(client, adCopy);

  // 4. Package creative options
  const creativePackage = {
    id: uuid(),
    clientId,
    clientName: client.name,
    platform,
    objective: campaignObjective,
    adCopy,
    complianceCheck,
    generatedAt: new Date().toISOString(),
    status: 'pending_approval',
  };

  // 5. Save to knowledge base
  const parsedVariations = parseAdCopyVariations(adCopy, platform);
  for (const variation of parsedVariations) {
    saveCreative({
      clientId,
      platform,
      creativeType: 'text',
      headline: variation.headline,
      bodyCopy: variation.body,
      cta: variation.cta,
      status: 'draft',
    });
  }

  // 6. Save to Google Drive
  if (client.drive_creatives_folder_id) {
    try {
      const date = new Date().toISOString().split('T')[0];
      await googleDrive.createDocument(
        `${client.name} - Creative Options ${date}`,
        formatCreativeDocument(creativePackage),
        client.drive_creatives_folder_id,
      );
    } catch (e) {
      log.warn('Failed to save creatives to Drive', { error: e.message });
    }
  }

  // 7. Update ClickUp task
  if (taskId) {
    try {
      await clickup.addComment(taskId, `🎨 **Creative Options Generated**\n\n${adCopy}\n\n---\n**Brand Compliance:** ${complianceCheck.passed ? '✅ Passed' : '⚠️ Issues found'}\n${complianceCheck.issues?.map(i => `- ${i}`).join('\n') || ''}`);
    } catch (e) {
      log.warn('Failed to update ClickUp task', { error: e.message });
    }
  }

  // 8. Send for approval
  await sendApprovalRequest({
    id: creativePackage.id,
    description: `Creative options for ${client.name} ${platform} campaign`,
    clientName: client.name,
    platform,
    impact: `${parsedVariations.length} ad copy variations generated`,
    details: `Objective: ${campaignObjective}\nVariations: ${parsedVariations.length}\nBrand compliance: ${complianceCheck.passed ? 'Passed' : 'Has issues'}`,
  });

  auditLog({
    action: 'creatives_generated',
    workflow: 'creative-generation',
    clientId,
    platform,
    details: { variationCount: parsedVariations.length, compliance: complianceCheck },
    approvedBy: 'pending',
    result: 'awaiting_approval',
  });

  log.info(`Creatives generated for ${client.name}`, { variations: parsedVariations.length });

  return creativePackage;
}

/**
 * Check generated copy against brand guidelines.
 */
async function checkBrandCompliance(client, adCopy) {
  if (!client.brand_voice && !client.brand_colors) {
    return { passed: true, issues: [], note: 'No brand guidelines configured' };
  }

  const response = await askClaude({
    systemPrompt: 'You are a brand compliance reviewer. Check ad copy against brand guidelines and flag any violations. Return JSON.',
    userMessage: `Check this ad copy for brand compliance:

Brand Guidelines:
- Voice: ${client.brand_voice || 'Not specified'}
- Colors: ${client.brand_colors || 'Not specified'}
- Fonts: ${client.brand_fonts || 'Not specified'}

Ad Copy:
${adCopy.slice(0, 2000)}

Return JSON:
{
  "passed": true/false,
  "score": 1-10,
  "issues": ["list of compliance issues"],
  "suggestions": ["improvements to better match brand"]
}`,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 512,
    workflow: 'brand-compliance',
    clientId: client.id,
  });

  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { passed: true, issues: [] };
  } catch {
    return { passed: true, issues: ['Compliance check parse failed'] };
  }
}

/**
 * Parse Claude's ad copy output into structured variations.
 */
function parseAdCopyVariations(text, platform) {
  const variations = [];
  const lines = text.split('\n');
  let currentHeadline = '';

  for (const line of lines) {
    const cleaned = line.replace(/^[\s\-\*\d.]+/, '').trim();
    if (!cleaned) continue;

    // Look for headline patterns
    const headlineMatch = cleaned.match(/^[""](.+?)[""]/) || cleaned.match(/^Headline[:\s]*[""]?(.+?)[""]?$/i);
    if (headlineMatch) {
      currentHeadline = headlineMatch[1].trim();
      variations.push({ headline: currentHeadline, body: '', cta: '' });
      continue;
    }

    // Look for body copy
    const bodyMatch = cleaned.match(/^Body[:\s]*[""]?(.+?)[""]?$/i);
    if (bodyMatch && variations.length > 0) {
      variations[variations.length - 1].body = bodyMatch[1].trim();
      continue;
    }

    // Look for CTA
    const ctaMatch = cleaned.match(/^CTA[:\s]*[""]?(.+?)[""]?$/i);
    if (ctaMatch && variations.length > 0) {
      variations[variations.length - 1].cta = ctaMatch[1].trim();
    }
  }

  return variations.length > 0 ? variations : [{ headline: 'See full copy above', body: '', cta: '' }];
}

/**
 * Format creatives for Google Drive document.
 */
function formatCreativeDocument(pkg) {
  return [
    `Creative Options - ${pkg.clientName}`,
    `Generated: ${pkg.generatedAt}`,
    `Platform: ${pkg.platform}`,
    `Objective: ${pkg.objective}`,
    '',
    '═══════════════════════════════════',
    '',
    pkg.adCopy,
    '',
    '═══════════════════════════════════',
    '',
    'Brand Compliance:',
    pkg.complianceCheck.passed ? 'PASSED' : 'ISSUES FOUND',
    ...(pkg.complianceCheck.issues || []).map(i => `- ${i}`),
  ].join('\n');
}

export default { generateCreatives };
