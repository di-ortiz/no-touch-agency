import logger from '../utils/logger.js';
import { askClaude } from '../api/anthropic.js';
import { sendMorningBriefing, sendAlert } from '../api/whatsapp.js';
import * as clickup from '../api/clickup.js';
import * as metaAds from '../api/meta-ads.js';
import * as googleAds from '../api/google-ads.js';
import * as tiktokAds from '../api/tiktok-ads.js';
import { getAllClients } from '../services/knowledge-base.js';
import { getCostSummary } from '../services/cost-tracker.js';
import { SYSTEM_PROMPTS, USER_PROMPTS } from '../prompts/templates.js';

const log = logger.child({ workflow: 'morning-briefing' });

/**
 * Workflow 1: Morning Intelligence Briefing
 * Runs daily at 8:00 AM. Collects all platform data and generates
 * a prioritized briefing sent via WhatsApp.
 */
export async function runMorningBriefing() {
  log.info('Starting morning briefing');

  const clients = getAllClients();
  const results = {
    platformData: [],
    overdueTasks: [],
    dueToday: [],
    dueSoon: [],
    budgetIssues: [],
  };

  // 1. Pull performance data from all platforms for each client
  for (const client of clients) {
    try {
      const clientData = { name: client.name, platforms: {} };

      // Meta Ads
      if (client.meta_ad_account_id) {
        try {
          const insights = await metaAds.getAccountInsights(client.meta_ad_account_id, { datePreset: 'yesterday' });
          clientData.platforms.meta = metaAds.extractConversions(insights);
        } catch (e) {
          log.warn(`Failed to get Meta data for ${client.name}`, { error: e.message });
        }
      }

      // Google Ads
      if (client.google_ads_customer_id) {
        try {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const dateStr = yesterday.toISOString().split('T')[0];
          const perf = await googleAds.getAccountPerformance(client.google_ads_customer_id, { start: dateStr, end: dateStr });
          if (perf.length > 0) {
            clientData.platforms.google = googleAds.formatGoogleAdsMetrics(perf[0]);
          }
        } catch (e) {
          log.warn(`Failed to get Google Ads data for ${client.name}`, { error: e.message });
        }
      }

      // TikTok Ads
      if (client.tiktok_advertiser_id) {
        try {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const dateStr = yesterday.toISOString().split('T')[0];
          const report = await tiktokAds.getReport(client.tiktok_advertiser_id, {
            startDate: dateStr,
            endDate: dateStr,
          });
          clientData.platforms.tiktok = report;
        } catch (e) {
          log.warn(`Failed to get TikTok data for ${client.name}`, { error: e.message });
        }
      }

      results.platformData.push(clientData);
    } catch (e) {
      log.error(`Failed to collect data for ${client.name}`, { error: e.message });
    }
  }

  // 2. Check ClickUp for tasks
  try {
    const overdue = await clickup.getOverdueTasks();
    results.overdueTasks = (overdue.tasks || []).map(t => ({
      name: t.name,
      assignee: t.assignees?.[0]?.username || 'Unassigned',
      dueDate: t.due_date ? new Date(parseInt(t.due_date)).toLocaleDateString() : 'No date',
      status: t.status?.status || 'unknown',
    }));
  } catch (e) {
    log.warn('Failed to get overdue tasks', { error: e.message });
  }

  try {
    const today = await clickup.getTasksDueToday();
    results.dueToday = (today.tasks || []).map(t => ({
      name: t.name,
      assignee: t.assignees?.[0]?.username || 'Unassigned',
    }));
  } catch (e) {
    log.warn('Failed to get tasks due today', { error: e.message });
  }

  try {
    const soon = await clickup.getTasksDueSoon();
    results.dueSoon = (soon.tasks || []).map(t => ({
      name: t.name,
      dueDate: t.due_date ? new Date(parseInt(t.due_date)).toLocaleDateString() : 'No date',
    }));
  } catch (e) {
    log.warn('Failed to get upcoming tasks', { error: e.message });
  }

  // 3. Format platform data for Claude
  let platformSummary = '';
  for (const client of results.platformData) {
    platformSummary += `\n### ${client.name}:\n`;
    for (const [platform, data] of Object.entries(client.platforms)) {
      if (!data) continue;
      platformSummary += `${platform}: Spend $${data.spend?.toFixed(2) || 'N/A'}, `;
      platformSummary += `ROAS ${data.roas?.toFixed(2) || 'N/A'}, `;
      platformSummary += `CPA $${data.cpa?.toFixed(2) || 'N/A'}, `;
      platformSummary += `Conversions ${data.conversions || 0}\n`;
    }
  }

  const tasksDueStr = results.dueToday.map(t => `- ${t.name} (${t.assignee})`).join('\n') || 'None';
  const overdueStr = results.overdueTasks.map(t => `- ${t.name} (${t.assignee}, due ${t.dueDate})`).join('\n') || 'None';
  const soonStr = results.dueSoon.map(t => `- ${t.name} (due ${t.dueDate})`).join('\n') || 'None';

  // 4. AI cost info
  const costSummary = getCostSummary('today');

  // 5. Ask Claude to generate the briefing
  const promptData = {
    platformPerformance: platformSummary || 'No data available yet',
    tasksDueToday: tasksDueStr,
    overdueTasks: overdueStr,
    tasksDueSoon: soonStr,
    budgetPacing: results.budgetIssues.length > 0 ? results.budgetIssues.join('\n') : 'All budgets within normal range',
    activeCampaigns: results.platformData.reduce((sum, c) => sum + Object.keys(c.platforms).length, 0),
    activeClients: clients.length,
  };

  const response = await askClaude({
    systemPrompt: SYSTEM_PROMPTS.morningBriefing,
    userMessage: USER_PROMPTS.morningBriefing(promptData),
    workflow: 'morning-briefing',
    maxTokens: 2048,
  });

  // 6. Parse Claude's response and send via WhatsApp
  const briefingText = response.text;

  // Extract structured data from Claude's response (best-effort parsing)
  const healthMatch = briefingText.match(/health score[:\s]*(\d+)/i);
  const healthScore = healthMatch ? parseInt(healthMatch[1]) : 7;
  const healthEmoji = healthScore >= 8 ? '🟢' : healthScore >= 5 ? '🟡' : '🔴';

  const briefing = {
    date: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    healthScore,
    healthEmoji,
    urgentItems: extractListItems(briefingText, 'urgent') || ['No urgent items'],
    highlights: extractListItems(briefingText, 'highlight') || ['Data collection in progress'],
    issues: extractListItems(briefingText, 'issue') || extractListItems(briefingText, 'attention') || ['No major issues'],
    todayTasks: results.dueToday.map(t => `${t.name} (${t.assignee})`),
    overdueTasks: results.overdueTasks.map(t => `${t.name} - ${t.assignee} (due ${t.dueDate})`),
    budgetSummary: `AI costs today: $${costSummary.totalDollars}`,
    dashboardLink: null,
  };

  await sendMorningBriefing(briefing);
  log.info('Morning briefing sent successfully');

  return briefing;
}

function extractListItems(text, keyword) {
  const lines = text.split('\n');
  const items = [];
  let capturing = false;

  for (const line of lines) {
    if (line.toLowerCase().includes(keyword)) {
      capturing = true;
      continue;
    }
    if (capturing) {
      const cleaned = line.replace(/^[\s\-\*\d.]+/, '').trim();
      if (cleaned.length > 0 && cleaned.length < 200) {
        items.push(cleaned);
      }
      if (items.length >= 5 || (line.trim() === '' && items.length > 0)) {
        break;
      }
    }
  }

  return items.length > 0 ? items : null;
}

// CLI entry point
if (process.argv[1]?.endsWith('morning-briefing.js')) {
  runMorningBriefing()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}

export default runMorningBriefing;
