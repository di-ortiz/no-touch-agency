import logger from '../utils/logger.js';
import { deepAnalysis } from '../api/anthropic.js';
import { notifyOwnerMessage as sendWhatsApp, notifyOwnerAlert as sendAlert } from '../utils/notify-owner.js';
import * as googleDrive from '../api/google-drive.js';
import { getAllClients, getClient, buildClientContext, getClientCampaignHistory } from '../services/knowledge-base.js';
import { generateStrategicPlan } from './client-onboarding.js';
import { SYSTEM_PROMPTS } from '../prompts/templates.js';

const log = logger.child({ workflow: 'monthly-review' });

/**
 * Workflow 9: Monthly Strategic Review
 * Runs last Friday of month. Deep analysis + plan updates for all clients.
 */
export async function runMonthlyReview() {
  log.info('Starting monthly strategic review');

  // Check if this is actually the last Friday of the month
  const today = new Date();
  const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  if (today.getDay() !== 5 || nextWeek.getMonth() === today.getMonth()) {
    log.info('Not the last Friday of the month, skipping');
    return null;
  }

  const clients = getAllClients();
  const reviews = [];

  for (const client of clients) {
    try {
      const review = await generateMonthlyReview(client.id);
      reviews.push({ client: client.name, status: 'success' });
    } catch (e) {
      log.error(`Monthly review failed for ${client.name}`, { error: e.message });
      reviews.push({ client: client.name, status: 'failed', error: e.message });
    }
  }

  await sendAlert('info', `Monthly Reviews Complete`,
    `${reviews.filter(r => r.status === 'success').length}/${reviews.length} reviews generated.\n\nReview strategic plans in Google Drive.`);

  return reviews;
}

/**
 * Generate monthly review for a specific client.
 */
export async function generateMonthlyReview(clientId) {
  const client = getClient(clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  log.info(`Generating monthly review for ${client.name}`);

  const clientContext = buildClientContext(clientId);
  const history = getClientCampaignHistory(clientId, 30);

  // Build monthly summary from history
  const monthSummary = history.length > 0
    ? history.map(h =>
      `${h.platform} | ${h.campaign_name}: Spend $${(h.spend_cents / 100).toFixed(0)}, ROAS ${h.roas.toFixed(2)}, CPA $${(h.cpa_cents / 100).toFixed(2)}, ${h.conversions} conv`
    ).join('\n')
    : 'Limited historical data available.';

  const response = await deepAnalysis({
    systemPrompt: `${SYSTEM_PROMPTS.strategicPlanning}

You are conducting a monthly strategic review. Be thorough, data-driven, and forward-looking.
The report should be 10-15 pages worth of content covering every aspect of the client's PPC performance.`,
    prompt: `Generate a comprehensive monthly strategic review for ${client.name}.

${clientContext}

**This Month's Performance Data:**
${monthSummary}

**Current Targets:**
- ROAS: ${client.target_roas || 'Not set'}
- CPA: $${((client.target_cpa_cents || 0) / 100).toFixed(2)}
- Monthly Budget: $${((client.monthly_budget_cents || 0) / 100).toFixed(0)}

Generate a thorough review covering:

## 1. Executive Summary
- Overall performance vs goals
- Key wins and challenges
- Top recommendations

## 2. Goal Achievement
- Did we hit ROAS/CPA/conversion targets?
- Where did we exceed? Where did we fall short?
- What drove the results?

## 3. Budget Efficiency
- Total spend vs budget
- Spend allocation by platform
- ROI by channel
- Wasted spend identification
- Budget reallocation recommendations

## 4. Channel Performance
- Meta Ads: detailed analysis
- Google Ads: detailed analysis
- TikTok (if applicable): detailed analysis
- Cross-channel comparison
- Channel synergies identified

## 5. Audience Insights
- Best performing audiences
- Audiences to expand
- Audiences to exclude
- New audience recommendations

## 6. Creative Performance
- Top performing creatives (and why)
- Underperformers (and why)
- Creative fatigue status
- Refresh recommendations

## 7. Competitive Landscape
- Market changes observed
- Competitor movements
- Opportunity gaps

## 8. Next Month Strategy
- Budget allocation changes
- New campaigns to launch
- Tests to run
- Creative needs
- Optimization priorities

## 9. 90-Day Plan Update
- Progress against current plan
- Adjustments needed
- Updated projections

## 10. Action Items
- Prioritized list of tasks for next month
- Responsible parties
- Deadlines`,
    workflow: 'monthly-review',
    clientId: client.id,
  });

  // Save to Google Drive
  if (client.drive_reports_folder_id) {
    try {
      const monthName = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      await googleDrive.createDocument(
        `${client.name} - Monthly Strategic Review ${monthName}`,
        response.text,
        client.drive_reports_folder_id,
      );
    } catch (e) {
      log.warn('Failed to save review to Drive', { error: e.message });
    }
  }

  // Update strategic plan
  try {
    await generateStrategicPlan(client, null);
    log.info(`Updated strategic plan for ${client.name}`);
  } catch (e) {
    log.warn(`Failed to update strategic plan for ${client.name}`, { error: e.message });
  }

  // Send summary
  const execSummary = response.text.split('\n').slice(0, 15).join('\n');
  await sendWhatsApp(`📋 *Monthly Review: ${client.name}*\n\n${execSummary}\n\n_Full review (10+ pages) in Google Drive_`);

  return { clientName: client.name, review: response.text };
}

export default { runMonthlyReview, generateMonthlyReview };
