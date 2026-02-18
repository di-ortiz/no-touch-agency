import logger from '../utils/logger.js';
import { deepAnalysis } from '../api/anthropic.js';
import { searchAds, getPageAds, parseAdLibraryResults, formatAdsForWhatsApp } from '../api/meta-ad-library.js';
import { notifyOwnerMessage as sendWhatsApp } from '../utils/notify-owner.js';
import { getClient, buildClientContext } from '../services/knowledge-base.js';
import { auditLog } from '../services/cost-tracker.js';
import { SYSTEM_PROMPTS, USER_PROMPTS } from '../prompts/templates.js';

const log = logger.child({ workflow: 'competitor-creatives' });

/**
 * Workflow: Competitor Creative Intelligence
 * Pulls competitor ads from Meta Ad Library and sends them via WhatsApp
 * with AI analysis of creative strategy and takeaways for the client.
 *
 * @param {object} params
 * @param {string} params.clientId - Client ID
 * @param {string} [params.competitorName] - Specific competitor (or all)
 * @param {string} [params.country] - ISO country code (default: 'BR')
 * @param {number} [params.limit] - Max ads per competitor (default: 5)
 */
export async function pullCompetitorCreatives(params) {
  const {
    clientId,
    competitorName,
    country = 'BR',
    limit = 5,
  } = params;

  const client = getClient(clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const competitors = client.competitors || [];
  if (competitors.length === 0) {
    await sendWhatsApp(`⚠️ No competitors configured for *${client.name}*. Add competitors to the client profile first.`);
    return { status: 'no_competitors', ads: [] };
  }

  // If a specific competitor is requested, filter to just that one
  const targetCompetitors = competitorName
    ? competitors.filter(c => c.toLowerCase().includes(competitorName.toLowerCase()))
    : competitors;

  if (targetCompetitors.length === 0) {
    await sendWhatsApp(`❌ Competitor "${competitorName}" not found for *${client.name}*.\nConfigured competitors: ${competitors.join(', ')}`);
    return { status: 'not_found', ads: [] };
  }

  log.info(`Pulling competitor creatives for ${client.name}`, {
    competitors: targetCompetitors,
    country,
  });

  const allResults = [];

  for (const competitor of targetCompetitors) {
    try {
      // Search Ad Library for this competitor's ads
      const rawResults = await searchAds({
        searchTerms: competitor,
        country,
        adActiveStatus: 'ACTIVE',
        limit,
      });

      const parsedAds = parseAdLibraryResults(rawResults);

      if (parsedAds.length > 0) {
        // Send the raw ads via WhatsApp
        const formattedMsg = formatAdsForWhatsApp(parsedAds, competitor);
        await sendWhatsApp(formattedMsg);

        // Now generate AI analysis of the competitor's creative strategy
        const analysis = await analyzeCompetitorCreatives(client, competitor, parsedAds);
        await sendWhatsApp(analysis.whatsappMessage);

        allResults.push({
          competitor,
          adsFound: parsedAds.length,
          ads: parsedAds,
          analysis: analysis.text,
        });
      } else {
        await sendWhatsApp(`🔍 No active Meta ads found for *${competitor}*.`);
        allResults.push({ competitor, adsFound: 0, ads: [] });
      }
    } catch (e) {
      log.error(`Failed to pull ads for ${competitor}`, { error: e.message });
      await sendWhatsApp(`⚠️ Could not fetch ads for *${competitor}*: ${e.message}`);
      allResults.push({ competitor, adsFound: 0, error: e.message });
    }
  }

  // Audit log
  auditLog({
    action: 'competitor_creatives_pulled',
    workflow: 'competitor-creatives',
    clientId,
    platform: 'meta',
    details: {
      competitors: targetCompetitors,
      totalAdsFound: allResults.reduce((sum, r) => sum + r.adsFound, 0),
    },
    result: 'success',
  });

  return { status: 'success', results: allResults };
}

/**
 * Analyze competitor creatives with Claude and generate actionable insights.
 */
async function analyzeCompetitorCreatives(client, competitorName, parsedAds) {
  const adSummaries = parsedAds.map((ad, i) => {
    return `Ad ${i + 1}:
  Headline: ${ad.headline || 'N/A'}
  Body: ${ad.body || 'N/A'}
  Description: ${ad.description || 'N/A'}
  Platforms: ${ad.platforms.join(', ') || 'N/A'}
  Running since: ${ad.startDate?.split('T')[0] || 'Unknown'}`;
  }).join('\n\n');

  const response = await deepAnalysis({
    systemPrompt: SYSTEM_PROMPTS.competitorCreativeAnalysis,
    prompt: USER_PROMPTS.analyzeCompetitorCreatives({
      clientName: client.name,
      clientIndustry: client.industry || 'Unknown',
      clientBrandVoice: client.brand_voice || 'Not specified',
      competitorName,
      adSummaries,
      adCount: parsedAds.length,
    }),
    workflow: 'competitor-creative-analysis',
    clientId: client.id,
  });

  // Format for WhatsApp
  const whatsappMessage = formatAnalysisForWhatsApp(competitorName, client.name, response.text);

  return {
    text: response.text,
    whatsappMessage,
  };
}

/**
 * Format the AI analysis for WhatsApp delivery.
 */
function formatAnalysisForWhatsApp(competitorName, clientName, analysisText) {
  // Extract key sections from the analysis
  const lines = analysisText.split('\n');
  const condensed = [];
  let inSection = false;
  let sectionCount = 0;

  condensed.push(`🧠 *Creative Analysis: ${competitorName}*`);
  condensed.push(`_Insights for ${clientName}_\n`);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect section headers
    if (trimmed.startsWith('#') || trimmed.startsWith('**')) {
      if (sectionCount < 5) {
        const clean = trimmed.replace(/^#+\s*/, '').replace(/\*\*/g, '');
        condensed.push(`*${clean}*`);
        inSection = true;
        sectionCount++;
      }
      continue;
    }

    // Include bullet points and key content
    if (inSection && (trimmed.startsWith('-') || trimmed.startsWith('•') || trimmed.startsWith('*'))) {
      condensed.push(trimmed);
    }
  }

  // If we couldn't parse sections, just truncate the raw text
  if (condensed.length <= 2) {
    const truncated = analysisText.length > 2000
      ? analysisText.slice(0, 2000) + '...'
      : analysisText;
    return `🧠 *Creative Analysis: ${competitorName}*\n_for ${clientName}_\n\n${truncated}`;
  }

  return condensed.join('\n');
}

export default { pullCompetitorCreatives };
