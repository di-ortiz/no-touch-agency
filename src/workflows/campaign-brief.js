import logger from '../utils/logger.js';
import { deepAnalysis, quickAnalysis } from '../api/anthropic.js';
import { notifyOwnerAlert as sendAlert } from '../utils/notify-owner.js';
import * as clickup from '../api/clickup.js';
import { getClient, buildClientContext, getClientCampaignHistory, getTopCreatives } from '../services/knowledge-base.js';

const log = logger.child({ workflow: 'campaign-brief' });

/**
 * Workflow 3: Campaign Brief Intelligence
 * When a new campaign task is created in ClickUp, this generates a smart
 * brief pre-filled with relevant data from past campaigns and client profile.
 */
export async function generateCampaignBrief(params) {
  const {
    clientId,
    taskId,
    campaignObjective,
    platform,
    budget,
    startDate,
    endDate,
    targetAudience,
    notes,
  } = params;

  const client = getClient(clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  log.info(`Generating campaign brief for ${client.name}`, { objective: campaignObjective, platform });

  // 1. Build context from knowledge base
  const clientContext = buildClientContext(clientId);
  const history = getClientCampaignHistory(clientId, 20);
  const topCreatives = getTopCreatives(clientId, 10);

  // Filter history for similar campaigns
  const similarCampaigns = history.filter(h => {
    if (platform && h.platform !== platform) return false;
    if (campaignObjective && h.objective && !h.objective.toLowerCase().includes(campaignObjective.toLowerCase())) return false;
    return true;
  }).slice(0, 5);

  const historySummary = similarCampaigns.length > 0
    ? similarCampaigns.map(h =>
      `- ${h.campaign_name} (${h.platform}): ROAS ${h.roas.toFixed(2)}, CPA $${(h.cpa_cents / 100).toFixed(2)}, ${h.conversions} conv, Spend $${(h.spend_cents / 100).toFixed(0)}`
    ).join('\n')
    : 'No similar past campaigns found.';

  const creativeSummary = topCreatives.length > 0
    ? topCreatives.map(c =>
      `- "${c.headline}" (${c.creative_type}): CTR ${(c.ctr * 100).toFixed(2)}%, ${c.conversions} conv`
    ).join('\n')
    : 'No past creative performance data.';

  // 2. Generate smart brief with Claude
  const response = await deepAnalysis({
    systemPrompt: `You are a PPC campaign strategist creating a detailed campaign brief.
Use the client's historical data to make informed recommendations.
Flag any missing critical information that must be gathered before proceeding.
Output the brief in a structured markdown format.`,
    prompt: `Generate a comprehensive campaign brief for ${client.name}.

${clientContext}

**Campaign Request:**
- Objective: ${campaignObjective || 'Not specified'}
- Platform: ${platform || 'Not specified'}
- Budget: ${budget ? `$${budget}` : 'Not specified'}
- Timeline: ${startDate || 'TBD'} to ${endDate || 'TBD'}
- Target Audience (requested): ${targetAudience || 'Use client profile defaults'}
- Additional Notes: ${notes || 'None'}

**Similar Past Campaigns:**
${historySummary}

**Top Performing Creatives:**
${creativeSummary}

Generate a brief with these sections:

## Campaign Overview
- Campaign name suggestion
- Objective and expected outcomes
- Platform(s) and ad formats

## Budget Recommendation
- Suggested daily/total budget based on historical CPAs
- Budget split (prospecting vs remarketing)
- Expected outcomes at this budget level

## Target Audience
- Primary audience (demographics, interests, behaviors)
- Remarketing audiences to include
- Lookalike audiences to build
- Negative audiences / exclusions
- *Based on what worked historically*

## Creative Direction
- Recommended ad formats
- Key messages and angles (based on brand voice and past winners)
- Number of creative variations needed
- A/B test plan

## Conversion Tracking
- Expected conversion events
- Attribution window recommendation
- Tracking requirements

## Success Metrics
- Primary KPI and target
- Secondary metrics
- Review checkpoints

## Pre-Launch Checklist
- [ ] Brief reviewed and approved
- [ ] Creative assets approved
- [ ] Landing page live and tested
- [ ] Tracking pixels verified
- [ ] Budget approved
- [ ] Audience lists built

## Missing Information
List any critical information NOT provided that must be gathered before proceeding.
For each, suggest a question to ask the client.`,
    workflow: 'campaign-brief',
    clientId,
  });

  const brief = response.text;

  // 3. Analyze completeness
  const completeness = await analyzeBriefCompleteness(brief, client.name);

  // 4. Update ClickUp task if provided
  if (taskId) {
    try {
      const commentText = [
        '🤖 **AI-Generated Campaign Brief**\n',
        brief,
        '\n---',
        `**Completeness Score:** ${completeness.score}/10`,
        completeness.missingItems.length > 0
          ? `\n**Missing Information:**\n${completeness.missingItems.map(i => `- ⚠️ ${i}`).join('\n')}`
          : '\n✅ Brief appears complete.',
      ].join('\n');

      await clickup.addComment(taskId, commentText);
      log.info(`Brief posted to ClickUp task ${taskId}`);
    } catch (e) {
      log.warn(`Failed to post brief to ClickUp`, { error: e.message });
    }
  }

  // 5. Alert if critical info is missing
  if (completeness.score < 6) {
    await sendAlert('warning', `Brief Needs Info: ${client.name}`,
      `The campaign brief for ${client.name} is missing critical information:\n${completeness.missingItems.map(i => `• ${i}`).join('\n')}\n\nPlease gather this before proceeding.`);
  }

  return {
    brief,
    completeness,
    similarCampaigns: similarCampaigns.length,
  };
}

/**
 * Analyze brief completeness and flag missing items.
 */
async function analyzeBriefCompleteness(brief, clientName) {
  const response = await quickAnalysis({
    prompt: `Analyze this campaign brief for completeness. Score 1-10.

Brief:
${brief.slice(0, 3000)}

Return JSON:
{
  "score": <1-10>,
  "missingItems": ["list of critical missing information"],
  "questionsForClient": ["questions to ask the client to fill gaps"]
}`,
    workflow: 'brief-completeness',
  });

  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { score: 5, missingItems: ['Could not assess'], questionsForClient: [] };
  } catch {
    return { score: 5, missingItems: ['Assessment failed'], questionsForClient: [] };
  }
}

/**
 * Generate questions to ask a client for a specific campaign type.
 */
export async function generateClientQuestions(clientId, campaignType) {
  const client = getClient(clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const response = await quickAnalysis({
    prompt: `Generate 5-8 essential questions to ask the client "${client.name}" (${client.industry || 'unknown industry'}) for a ${campaignType} PPC campaign.

Focus on:
- Business goals specific to this campaign
- Target audience details
- Competitive advantages to highlight
- Offers or promotions to feature
- Content/creative preferences
- Landing page readiness
- Timeline and launch constraints

Format as a numbered list with brief context for each question.`,
    workflow: 'client-questions',
    clientId,
  });

  return response.text;
}

export default { generateCampaignBrief, generateClientQuestions };
