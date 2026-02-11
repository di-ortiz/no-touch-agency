import logger from '../utils/logger.js';
import { deepAnalysis } from '../api/anthropic.js';
import { sendWhatsApp, sendAlert } from '../api/whatsapp.js';
import * as hubspot from '../api/hubspot.js';
import { getAllClients, getClient } from '../services/knowledge-base.js';

const log = logger.child({ workflow: 'landing-page' });

/**
 * Workflow 15: Landing Page Performance Integration
 * Runs weekly (Mondays). Analyzes landing page performance
 * and generates CRO recommendations.
 */
export async function runLandingPageAnalysis() {
  log.info('Starting landing page analysis');

  const clients = getAllClients();
  const reports = [];

  for (const client of clients) {
    if (!client.website) continue;

    try {
      const analysis = await analyzeLandingPages(client);
      if (analysis) reports.push(analysis);
    } catch (e) {
      log.error(`Landing page analysis failed for ${client.name}`, { error: e.message });
    }
  }

  if (reports.length > 0) {
    const issues = reports.filter(r => r.issues.length > 0);
    if (issues.length > 0) {
      let message = `🌐 *Landing Page Analysis*\n\n`;
      for (const report of issues) {
        message += `*${report.clientName}:*\n`;
        for (const issue of report.issues.slice(0, 3)) {
          message += `• ${issue}\n`;
        }
        message += '\n';
      }
      await sendAlert('info', `Landing Page Issues: ${issues.length} clients`, message);
    }
  }

  return reports;
}

/**
 * Analyze landing pages for a specific client.
 */
async function analyzeLandingPages(client) {
  // In a full implementation, you would:
  // 1. Pull Google Analytics data via API
  // 2. Cross-reference with PPC campaign landing pages
  // 3. Analyze bounce rates, conversion rates, load times
  //
  // For now, we use Claude to generate recommendations based on
  // what we know about the client and their campaigns.

  const response = await deepAnalysis({
    systemPrompt: `You are a CRO (Conversion Rate Optimization) specialist analyzing PPC landing pages.
Provide specific, actionable recommendations to improve conversion rates.
Focus on quick wins that can have immediate impact.`,
    prompt: `Analyze landing page optimization opportunities for ${client.name}.

Client Info:
- Website: ${client.website}
- Industry: ${client.industry || 'Unknown'}
- Primary KPI: ${client.primary_kpi || 'Conversions'}
- Target CPA: $${((client.target_cpa_cents || 0) / 100).toFixed(2)}
- Platforms: ${[client.meta_ad_account_id && 'Meta', client.google_ads_customer_id && 'Google'].filter(Boolean).join(', ')}

Based on typical ${client.industry || 'e-commerce'} landing pages, provide:

1. **Common Issues to Check**
   - Page load speed indicators
   - Mobile optimization
   - Form friction
   - Trust signals
   - CTA visibility

2. **Quick Wins**
   - Changes that can improve conversion rate 10-30%
   - A/B tests to run on landing pages
   - Form optimization ideas

3. **PPC-Specific Recommendations**
   - Message match between ads and landing pages
   - Dynamic content opportunities
   - Audience-specific landing page variants

4. **CRO Project Scope**
   - If a full CRO audit is warranted
   - Expected improvement range
   - Investment vs return estimate

Return:
- Top 3 issues (as short strings for alert)
- Full recommendations
- CRO project recommendation (yes/no with justification)`,
    workflow: 'landing-page-analysis',
    clientId: client.id,
  });

  // Extract issues for alerting
  const issues = [];
  const lines = response.text.split('\n');
  let inIssues = false;
  for (const line of lines) {
    if (line.toLowerCase().includes('issue') || line.toLowerCase().includes('common')) {
      inIssues = true;
      continue;
    }
    if (inIssues) {
      const cleaned = line.replace(/^[\s\-\*\d.]+/, '').trim();
      if (cleaned.length > 10 && cleaned.length < 150) {
        issues.push(cleaned);
      }
      if (issues.length >= 5) break;
    }
  }

  // Create CRO opportunity in HubSpot if warranted
  const croRecommended = response.text.toLowerCase().includes('recommend') &&
    (response.text.toLowerCase().includes('cro audit') || response.text.toLowerCase().includes('cro project'));

  if (croRecommended) {
    try {
      await hubspot.createDeal({
        dealname: `${client.name} - CRO Audit (from PPC data)`,
        amount: (client.monthly_budget_cents || 0) / 100 * 0.15, // 15% of monthly budget
        dealstage: 'qualifiedtobuy',
      });
    } catch (e) {
      log.warn('Failed to create HubSpot CRO deal', { error: e.message });
    }
  }

  return {
    clientName: client.name,
    issues,
    fullAnalysis: response.text,
    croRecommended,
  };
}

export default { runLandingPageAnalysis };
