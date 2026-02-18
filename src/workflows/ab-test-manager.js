import logger from '../utils/logger.js';
import { deepAnalysis, quickAnalysis } from '../api/anthropic.js';
import { notifyOwnerMessage as sendWhatsApp, notifyOwnerAlert as sendAlert } from '../utils/notify-owner.js';
import * as clickup from '../api/clickup.js';
import * as metaAds from '../api/meta-ads.js';
import { getAllClients, getClient, recordTestResult, getClientCampaignHistory } from '../services/knowledge-base.js';
import { auditLog } from '../services/cost-tracker.js';

const log = logger.child({ workflow: 'ab-test' });

/**
 * Workflow 7: A/B Test Management
 * Runs weekly (Mondays). Identifies testing opportunities,
 * monitors active tests, and declares winners.
 */
export async function runTestManager() {
  log.info('Starting A/B test management');

  const clients = getAllClients();
  const recommendations = [];
  const completedTests = [];

  for (const client of clients) {
    try {
      // 1. Check for active tests that may have reached significance
      const completed = await checkActiveTests(client);
      completedTests.push(...completed);

      // 2. Identify new testing opportunities
      const recs = await identifyTestingOpportunities(client);
      if (recs.length > 0) {
        recommendations.push({ client: client.name, tests: recs });
      }
    } catch (e) {
      log.error(`Test management failed for ${client.name}`, { error: e.message });
    }
  }

  // Send summary
  let message = '🧪 *Weekly A/B Test Report*\n\n';

  if (completedTests.length > 0) {
    message += `*Completed Tests:*\n`;
    for (const test of completedTests) {
      const emoji = test.winner ? '🏆' : '🔄';
      message += `${emoji} *${test.clientName}*: ${test.testName}\n`;
      message += `  Winner: ${test.winner || 'Inconclusive'} (${test.confidence}% confidence)\n`;
      message += `  Improvement: ${test.improvement}%\n\n`;
    }
  }

  if (recommendations.length > 0) {
    message += `*New Test Recommendations:*\n`;
    for (const rec of recommendations) {
      message += `\n*${rec.client}:*\n`;
      for (const test of rec.tests.slice(0, 3)) {
        message += `• ${test.type}: ${test.description}\n`;
        message += `  Expected impact: ${test.expectedImpact}\n`;
      }
    }
  }

  if (completedTests.length === 0 && recommendations.length === 0) {
    message += 'No tests completed or new opportunities this week.';
  }

  await sendWhatsApp(message);
  return { completedTests, recommendations };
}

/**
 * Check active tests for statistical significance.
 */
async function checkActiveTests(client) {
  const completed = [];

  // In a full implementation, you'd query each platform for test results.
  // Here we check Meta's built-in A/B test structure.
  if (!client.meta_ad_account_id) return completed;

  try {
    const campaigns = await metaAds.getCampaigns(client.meta_ad_account_id, {
      statusFilter: ['ACTIVE'],
    });

    for (const campaign of campaigns.data || []) {
      const adSets = await metaAds.getAdSets(campaign.id);
      const adSetData = adSets.data || [];

      // Multiple ad sets in one campaign = potential test
      if (adSetData.length >= 2) {
        const adSetInsights = [];
        for (const adSet of adSetData.slice(0, 5)) {
          const insights = await metaAds.getInsights(adSet.id, { datePreset: 'last_7d' });
          const metrics = metaAds.extractConversions(insights);
          if (metrics) {
            adSetInsights.push({ name: adSet.name, id: adSet.id, ...metrics });
          }
        }

        if (adSetInsights.length >= 2) {
          const result = evaluateTest(adSetInsights, client);
          if (result.significant) {
            completed.push({
              clientName: client.name,
              testName: `${campaign.name} - Ad Set Test`,
              winner: result.winner,
              loser: result.loser,
              confidence: result.confidence,
              improvement: result.improvement,
            });

            recordTestResult({
              clientId: client.id,
              platform: 'meta',
              testType: 'adset',
              testName: `${campaign.name} ad set comparison`,
              variantA: result.variants[0]?.name,
              variantB: result.variants[1]?.name,
              winner: result.winner,
              confidence: result.confidence,
              metricName: client.primary_kpi || 'ROAS',
              metricA: result.variants[0]?.value,
              metricB: result.variants[1]?.value,
              improvementPct: result.improvement,
              status: 'complete',
            });
          }
        }
      }
    }
  } catch (e) {
    log.warn(`Test check failed for ${client.name}`, { error: e.message });
  }

  return completed;
}

/**
 * Evaluate if a test has reached statistical significance.
 * Uses a simplified approach — for production, integrate a proper
 * statistical library or use platform native tools.
 */
function evaluateTest(variants, client) {
  if (variants.length < 2) return { significant: false };

  // Sort by primary KPI
  const kpi = (client.primary_kpi || 'roas').toLowerCase();
  const getValue = (v) => {
    if (kpi === 'roas') return v.roas || 0;
    if (kpi === 'cpa') return v.cpa > 0 ? -v.cpa : 0; // Lower CPA is better
    return v.conversions || 0;
  };

  const sorted = [...variants].sort((a, b) => getValue(b) - getValue(a));
  const best = sorted[0];
  const second = sorted[1];

  const bestVal = getValue(best);
  const secondVal = getValue(second);

  // Minimum sample size check
  const minImpressions = 1000;
  const minConversions = 10;
  const hasEnoughData = variants.every(v => v.impressions >= minImpressions);
  const hasEnoughConversions = variants.some(v => v.conversions >= minConversions);

  if (!hasEnoughData || !hasEnoughConversions) {
    return { significant: false, reason: 'Insufficient data' };
  }

  // Simple improvement threshold (20%+ difference indicates likely significance)
  const improvement = secondVal !== 0 ? ((bestVal - secondVal) / Math.abs(secondVal)) * 100 : 100;

  // Confidence estimation (simplified)
  const totalConversions = variants.reduce((s, v) => s + v.conversions, 0);
  const confidence = Math.min(95, 50 + totalConversions * 0.5 + Math.abs(improvement) * 0.5);

  const significant = confidence >= 90 && Math.abs(improvement) >= 10;

  return {
    significant,
    winner: significant ? best.name : null,
    loser: significant ? second.name : null,
    confidence: confidence.toFixed(0),
    improvement: improvement.toFixed(1),
    variants: sorted.map(v => ({ name: v.name, value: getValue(v) })),
  };
}

/**
 * Identify new testing opportunities for a client.
 */
async function identifyTestingOpportunities(client) {
  const history = getClientCampaignHistory(client.id, 10);

  const response = await quickAnalysis({
    prompt: `Identify A/B testing opportunities for "${client.name}" (${client.industry || 'unknown industry'}).

Current setup:
- Platforms: ${[client.meta_ad_account_id && 'Meta', client.google_ads_customer_id && 'Google', client.tiktok_advertiser_id && 'TikTok'].filter(Boolean).join(', ') || 'Unknown'}
- Monthly budget: $${((client.monthly_budget_cents || 0) / 100).toFixed(0)}
- Recent campaigns: ${history.length}

Return JSON array of test recommendations:
[
  {
    "type": "creative|audience|placement|bid|format",
    "description": "what to test",
    "hypothesis": "expected outcome",
    "expectedImpact": "low|medium|high",
    "estimatedDuration": "X weeks",
    "budgetNeeded": "$X"
  }
]
Limit to top 3 highest-impact tests. Return valid JSON only.`,
    workflow: 'test-recommendation',
    clientId: client.id,
  });

  try {
    const jsonMatch = response.text.match(/\[[\s\S]*\]/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch {
    return [];
  }
}

export default { runTestManager };
