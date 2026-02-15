import logger from '../utils/logger.js';
import { deepAnalysis } from '../api/anthropic.js';
import { sendWhatsApp, sendAlert } from '../api/whatsapp.js';
import * as googleDrive from '../api/google-drive.js';
import { getAllClients, getClient } from '../services/knowledge-base.js';

const log = logger.child({ workflow: 'competitor-monitor' });

/**
 * Workflow 11: Competitor Monitoring
 * Runs weekly (Wednesdays). Analyzes competitor strategies for each client.
 */
export async function runCompetitorMonitor() {
  log.info('Starting competitor monitoring');

  const clients = getAllClients();
  const clientsWithCompetitors = clients.filter(c =>
    c.competitors && c.competitors.length > 0
  );

  if (clientsWithCompetitors.length === 0) {
    log.info('No clients with competitors configured');
    return;
  }

  const reports = [];

  for (const client of clientsWithCompetitors) {
    try {
      const report = await analyzeCompetitors(client);
      reports.push({ client: client.name, report });
    } catch (e) {
      log.error(`Competitor analysis failed for ${client.name}`, { error: e.message });
    }
  }

  // Send summary
  if (reports.length > 0) {
    let summary = `🔍 *Weekly Competitor Intel*\n\n`;
    for (const r of reports) {
      summary += `*${r.client}:*\n`;
      summary += r.report.highlights.map(h => `• ${h}`).join('\n');
      summary += '\n\n';
    }
    await sendWhatsApp(summary);
  }

  return reports;
}

/**
 * Analyze competitors for a specific client.
 */
export async function analyzeCompetitors(clientOrId) {
  const client = typeof clientOrId === 'string' ? getClient(clientOrId) : clientOrId;
  if (!client) throw new Error('Client not found');

  const competitors = client.competitors || [];
  if (competitors.length === 0) {
    return { highlights: ['No competitors configured for this client'] };
  }

  log.info(`Analyzing competitors for ${client.name}`, { competitors });

  const response = await deepAnalysis({
    systemPrompt: `You are a competitive intelligence analyst specializing in PPC advertising.
Analyze competitors based on publicly available information and general industry knowledge.
Focus on actionable insights our client can use.
Be factual — clearly distinguish between known information and educated assumptions.`,
    prompt: `Perform a competitive analysis for ${client.name}.

**Our Client:**
- Industry: ${client.industry || 'Unknown'}
- Website: ${client.website || 'Unknown'}
- Description: ${client.description || 'N/A'}
- Primary platforms: ${[client.meta_ad_account_id && 'Meta', client.google_ads_customer_id && 'Google', client.tiktok_advertiser_id && 'TikTok'].filter(Boolean).join(', ') || 'Unknown'}

**Competitors to Analyze:**
${competitors.map((c, i) => `${i + 1}. ${c}`).join('\n')}

For each competitor, analyze (based on general industry knowledge):

1. **Likely Ad Strategy**
   - Platforms they likely focus on
   - Campaign types (search, social, display)
   - Estimated budget tier (small/medium/large)

2. **Messaging Themes**
   - Key value propositions they likely promote
   - Pricing/offer strategies
   - Emotional vs rational appeals

3. **Audience Targeting**
   - Who they're likely targeting
   - Geographic focus
   - Demographic skew

4. **Creative Approach**
   - Ad formats likely used
   - Visual style patterns
   - Video vs static preferences

5. **Gaps & Opportunities for Our Client**
   - What competitors may be missing
   - Audiences they might not be reaching
   - Messaging angles our client could own
   - Platform opportunities

Return:
- 3-5 key highlights (most important findings)
- Specific actionable recommendations for our client
- Threats to monitor

Format for easy scanning. Be specific and actionable.`,
    workflow: 'competitor-analysis',
    clientId: client.id,
  });

  // Extract highlights
  const highlights = extractHighlights(response.text);

  // Save report to Google Drive
  if (client.drive_root_folder_id) {
    try {
      const date = new Date().toISOString().split('T')[0];
      await googleDrive.createDocument(
        `${client.name} - Competitor Report ${date}`,
        response.text,
        client.drive_root_folder_id,
      );
    } catch (e) {
      log.warn(`Failed to save competitor report to Drive`, { error: e.message });
    }
  }

  return {
    fullReport: response.text,
    highlights,
    competitors,
    analyzedAt: new Date().toISOString(),
  };
}

function extractHighlights(text) {
  const highlights = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const cleaned = line.replace(/^[\s\-\*\d.#]+/, '').trim();
    if (cleaned.length > 20 && cleaned.length < 150) {
      if (
        cleaned.toLowerCase().includes('opportunity') ||
        cleaned.toLowerCase().includes('recommend') ||
        cleaned.toLowerCase().includes('gap') ||
        cleaned.toLowerCase().includes('threat') ||
        cleaned.toLowerCase().includes('key finding') ||
        cleaned.toLowerCase().includes('highlight')
      ) {
        highlights.push(cleaned);
      }
    }
    if (highlights.length >= 5) break;
  }

  // Fallback: take first few substantive lines
  if (highlights.length === 0) {
    for (const line of lines) {
      const cleaned = line.replace(/^[\s\-\*\d.#]+/, '').trim();
      if (cleaned.length > 30 && cleaned.length < 150 && !cleaned.startsWith('For each')) {
        highlights.push(cleaned);
        if (highlights.length >= 3) break;
      }
    }
  }

  return highlights.length > 0 ? highlights : ['Analysis complete - see full report'];
}

export default { runCompetitorMonitor, analyzeCompetitors };
