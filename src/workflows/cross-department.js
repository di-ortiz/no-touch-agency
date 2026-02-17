import logger from '../utils/logger.js';
import { quickAnalysis } from '../api/anthropic.js';
import { notifyOwnerMessage as sendWhatsApp, notifyOwnerAlert as sendAlert } from '../utils/notify-owner.js';
import * as hubspot from '../api/hubspot.js';
import { getAllClients } from '../services/knowledge-base.js';

const log = logger.child({ workflow: 'cross-department' });

/**
 * Workflow 12: Cross-Department Opportunity Detection
 * Runs daily. Analyzes PPC data for CRO, SEO, CRM, and content opportunities.
 */
export async function runCrossDepartmentDetection() {
  log.info('Starting cross-department opportunity detection');

  const clients = getAllClients();
  const opportunities = [];

  for (const client of clients) {
    try {
      const ops = await detectOpportunities(client);
      opportunities.push(...ops);
    } catch (e) {
      log.error(`Opportunity detection failed for ${client.name}`, { error: e.message });
    }
  }

  if (opportunities.length === 0) {
    log.info('No cross-department opportunities detected');
    return [];
  }

  // Sort by estimated value
  opportunities.sort((a, b) => b.estimatedValue - a.estimatedValue);

  // Send alert for high-value opportunities
  const highValue = opportunities.filter(o => o.estimatedValue >= 500);
  if (highValue.length > 0) {
    let message = `*Cross-Department Opportunities:*\n\n`;
    for (const op of highValue.slice(0, 10)) {
      const emoji = { cro: '🎯', seo: '🔍', crm: '📧', content: '📝' }[op.department] || '💡';
      message += `${emoji} *${op.client}* → ${op.department.toUpperCase()}\n`;
      message += `  ${op.description}\n`;
      message += `  Est. value: $${op.estimatedValue}/mo\n\n`;
    }
    await sendAlert('info', `${highValue.length} Upsell Opportunities Detected`, message);
  }

  // Create opportunities in HubSpot
  for (const op of opportunities.filter(o => o.estimatedValue >= 1000)) {
    try {
      await hubspot.createDeal({
        dealname: `${op.client} - ${op.department.toUpperCase()} Opportunity`,
        amount: op.estimatedValue,
        dealstage: 'qualifiedtobuy',
        pipeline: 'default',
      });
      log.info(`Created HubSpot deal for ${op.client} ${op.department} opportunity`);
    } catch (e) {
      log.warn('Failed to create HubSpot deal', { error: e.message });
    }
  }

  return opportunities;
}

async function detectOpportunities(client) {
  const opportunities = [];

  // Simple rule-based detection + AI enhancement
  const budget = (client.monthly_budget_cents || 0) / 100;

  // CRO Opportunity: High traffic but low conversion
  if (client.target_roas > 0 && budget > 1000) {
    opportunities.push({
      client: client.name,
      clientId: client.id,
      department: 'cro',
      description: `Budget of $${budget}/mo warrants CRO audit to maximize conversion rate`,
      estimatedValue: budget * 0.15, // 15% improvement = this value
      confidence: 'medium',
    });
  }

  // SEO Opportunity: If running brand search campaigns
  if (client.google_ads_customer_id && budget > 500) {
    opportunities.push({
      client: client.name,
      clientId: client.id,
      department: 'seo',
      description: `Significant PPC spend suggests SEO investment could reduce paid costs`,
      estimatedValue: budget * 0.1,
      confidence: 'medium',
    });
  }

  // CRM/Email: If generating leads via PPC
  if (client.primary_kpi === 'leads' || client.primary_kpi === 'CPA') {
    opportunities.push({
      client: client.name,
      clientId: client.id,
      department: 'crm',
      description: `Lead generation campaigns need nurture sequences to maximize conversion`,
      estimatedValue: budget * 0.2,
      confidence: 'high',
    });
  }

  // Content: Active advertisers can benefit from content marketing
  if (budget > 2000) {
    opportunities.push({
      client: client.name,
      clientId: client.id,
      department: 'content',
      description: `High ad spend indicates established product-market fit - content can reduce acquisition costs`,
      estimatedValue: budget * 0.08,
      confidence: 'low',
    });
  }

  // Use AI for more nuanced detection
  if (budget > 500) {
    try {
      const aiOpps = await detectAIOpportunities(client);
      opportunities.push(...aiOpps);
    } catch (e) {
      log.warn(`AI opportunity detection failed for ${client.name}`, { error: e.message });
    }
  }

  return opportunities;
}

async function detectAIOpportunities(client) {
  const response = await quickAnalysis({
    prompt: `Analyze this PPC client for cross-department upsell opportunities:

Client: ${client.name}
Industry: ${client.industry || 'Unknown'}
Monthly PPC Budget: $${((client.monthly_budget_cents || 0) / 100).toFixed(0)}
Primary KPI: ${client.primary_kpi || 'Unknown'}
Platforms: ${[client.meta_ad_account_id && 'Meta', client.google_ads_customer_id && 'Google', client.tiktok_advertiser_id && 'TikTok'].filter(Boolean).join(', ')}

Return JSON array of opportunities:
[{
  "department": "cro|seo|crm|content",
  "description": "specific opportunity",
  "estimatedValue": number (monthly),
  "confidence": "low|medium|high"
}]
Only include genuine opportunities. Max 3. JSON only.`,
    workflow: 'cross-department',
    clientId: client.id,
  });

  try {
    const jsonMatch = response.text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.map(o => ({ ...o, client: client.name, clientId: client.id }));
    }
  } catch { /* ignore parse errors */ }
  return [];
}

export default { runCrossDepartmentDetection };
