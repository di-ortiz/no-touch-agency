import express from 'express';
import { askClaude } from '../api/anthropic.js';
import { sendWhatsApp, sendAlert } from '../api/whatsapp.js';
import { sendTelegram, sendAlert as sendTelegramAlert } from '../api/telegram.js';
import { getAllClients, getClient, buildClientContext } from '../services/knowledge-base.js';
import { getCostSummary, getAuditLog } from '../services/cost-tracker.js';
import { runMorningBriefing } from '../workflows/morning-briefing.js';
import { runDailyMonitor } from '../workflows/daily-monitor.js';
import { runTaskMonitor, generateDailyStandup } from '../workflows/clickup-monitor.js';
import { onboardNewClient } from '../workflows/client-onboarding.js';
import { generateCampaignBrief } from '../workflows/campaign-brief.js';
import { generateCreatives } from '../workflows/creative-generation.js';
import { generateWeeklyReport } from '../workflows/weekly-report.js';
import { generateMonthlyReview } from '../workflows/monthly-review.js';
import { analyzeCompetitors } from '../workflows/competitor-monitor.js';
import { pullCompetitorCreatives } from '../workflows/competitor-creatives.js';
import { generateMediaPlan } from '../workflows/media-plan.js';
import { runBudgetPacing } from '../workflows/budget-pacing.js';
import { getJobs, runJob } from '../services/scheduler.js';
import * as metaAds from '../api/meta-ads.js';
import * as metaAdLibrary from '../api/meta-ad-library.js';
import * as googleAds from '../api/google-ads.js';
import { SYSTEM_PROMPTS } from '../prompts/templates.js';
import config from '../config.js';
import logger from '../utils/logger.js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const log = logger.child({ workflow: 'whatsapp-command' });

const app = express();
app.use(helmet());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Rate limit webhook endpoint
app.use('/webhook', rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many requests',
}));

// Pending approval actions
const pendingApprovals = new Map();

// Conversation history for memory (keyed by chatId/phone)
const conversationHistory = new Map();
const MAX_HISTORY_MESSAGES = 20; // keep last 20 exchanges per user
const HISTORY_TTL_MS = 60 * 60 * 1000; // clear after 1 hour of inactivity

function getHistory(chatId) {
  const entry = conversationHistory.get(chatId);
  if (!entry) return [];
  // Clear stale history
  if (Date.now() - entry.lastActive > HISTORY_TTL_MS) {
    conversationHistory.delete(chatId);
    return [];
  }
  return entry.messages;
}

function addToHistory(chatId, role, content) {
  let entry = conversationHistory.get(chatId);
  if (!entry) {
    entry = { messages: [], lastActive: Date.now() };
    conversationHistory.set(chatId, entry);
  }
  entry.lastActive = Date.now();
  entry.messages.push({ role, content });
  // Trim to max size (keep pairs so context makes sense)
  while (entry.messages.length > MAX_HISTORY_MESSAGES * 2) {
    entry.messages.shift();
  }
}

function clearHistory(chatId) {
  conversationHistory.delete(chatId);
}

// --- WhatsApp Conversational CSA Agent ---
const WHATSAPP_CSA_PROMPT = `You are Sofia, a warm and professional Customer Success Agent for a PPC/digital marketing agency. You chat via WhatsApp with the agency owner.

Your personality:
- Friendly, proactive, and genuinely helpful — like a trusted team member
- You speak naturally, never like a command-line interface
- You celebrate wins ("Great ROAS this week!") and flag concerns proactively
- You offer suggestions and next steps without being asked
- You use casual but professional language — no jargon unless the user does first

Communication style:
- Use WhatsApp formatting: *bold*, _italic_, ~strikethrough~
- Keep messages concise but insightful — no walls of text
- When sharing data, add context ("That's 15% above your target!")
- If something needs attention, lead with that
- Use emojis naturally but sparingly

CRITICAL RULES:
- When the user asks you to do something, DO IT immediately using your tools. Never tell the user to "onboard a client first" or ask them to set up anything before you can act.
- You can search the Meta Ad Library directly for ANY brand, company, or domain — you do NOT need them to be an onboarded client.
- If asked to analyze competitor ads (e.g. "analyze v4company.com ads"), use the search_ad_library tool directly with their brand name.
- If asked about a specific company's Facebook page, use search_facebook_pages to find it, then pull their ads.
- For client-specific operations (stats, reports, campaigns), use the client-related tools.
- For ad-hoc research and competitor intelligence, use the direct search tools.
- NEVER get stuck in a loop. If a tool returns an error, explain it and try an alternative approach.
- ALWAYS follow through and complete the task. Deliver actual results, not instructions on how to get results.

When you need data or want to perform actions, use the provided tools. Always explain what you're doing in a natural way ("Let me pull up those numbers for you..."). After getting tool results, present them conversationally — don't just dump raw data.

If a tool returns an error, explain it simply and suggest alternatives. Never show raw error objects.

For approval-sensitive actions (pausing campaigns, budget changes), always confirm with the user before proceeding.`;

// Unified tool definitions shared by both WhatsApp and Telegram CSA agents
const CSA_TOOLS = [
  // --- Direct Ad Library Tools (no client required) ---
  {
    name: 'search_ad_library',
    description: 'Search the Meta Ad Library directly for any brand, company, or keyword. Use this for ad-hoc competitor research, analyzing any advertiser\'s ads, or when the user asks about a specific company/brand/domain that is NOT an onboarded client. Does NOT require a client to be set up. Returns active ads with headlines, copy, platforms, and snapshot links.',
    input_schema: { type: 'object', properties: { searchTerms: { type: 'string', description: 'Brand name, company name, keyword, or domain to search for (e.g. "v4company", "Nike", "HubSpot")' }, country: { type: 'string', description: 'ISO country code (default: BR)' }, limit: { type: 'number', description: 'Max results to return (default: 10, max: 25)' }, adActiveStatus: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'ALL'], description: 'Filter by ad status (default: ACTIVE)' } }, required: ['searchTerms'] },
  },
  {
    name: 'search_facebook_pages',
    description: 'Search for Facebook Pages by name or domain to find their Page ID. Useful when you need to look up a specific advertiser\'s page before pulling their ads. Does NOT require a client.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Page name or domain to search for' } }, required: ['query'] },
  },
  {
    name: 'get_page_ads',
    description: 'Get ads from a specific Facebook Page by its Page ID. Use this after search_facebook_pages to get ads from a specific page. Does NOT require a client.',
    input_schema: { type: 'object', properties: { pageId: { type: 'string', description: 'Facebook Page ID' }, country: { type: 'string', description: 'ISO country code (default: BR)' }, limit: { type: 'number', description: 'Max results (default: 10)' } }, required: ['pageId'] },
  },
  // --- Client-based tools ---
  {
    name: 'get_client_stats',
    description: 'Get performance stats (spend, ROAS, CPA, conversions, CTR) for an onboarded client across their ad platforms (Meta, Google Ads). Use this when the user asks about performance of one of our managed clients.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name to look up' }, platform: { type: 'string', enum: ['meta', 'google', 'all'], description: 'Which platform to check' } }, required: ['clientName'] },
  },
  {
    name: 'list_clients',
    description: 'List all clients managed by the agency with their connected platforms. Use when user asks about clients, accounts, or wants an overview.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_budget_info',
    description: 'Get budget details for a specific client or overview of all clients. Includes monthly budget, target ROAS, and target CPA.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name (omit for overview of all)' } } },
  },
  {
    name: 'run_competitor_analysis',
    description: 'Run a deep competitor intelligence analysis for an onboarded client (uses their configured competitor list). For ad-hoc competitor research on any company, use search_ad_library instead.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string' } }, required: ['clientName'] },
  },
  {
    name: 'pull_competitor_ads',
    description: 'Pull live competitor ads from the Meta Ad Library for an onboarded client (uses their configured competitor list). For ad-hoc research on any company, use search_ad_library instead.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string' }, competitorName: { type: 'string', description: 'Specific competitor (optional)' } }, required: ['clientName'] },
  },
  {
    name: 'generate_report',
    description: 'Generate a performance report (weekly or monthly) for a client.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string' }, reportType: { type: 'string', enum: ['weekly', 'monthly'] } }, required: ['clientName'] },
  },
  {
    name: 'generate_campaign_brief',
    description: 'Generate a campaign brief for a client, including objectives, targeting, and strategy.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string' }, objective: { type: 'string', description: 'Campaign objective (e.g. conversions, awareness, leads)' } }, required: ['clientName'] },
  },
  {
    name: 'generate_creatives',
    description: 'Generate ad creative concepts and copy for a client.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string' }, platform: { type: 'string', enum: ['meta', 'google'] } }, required: ['clientName'] },
  },
  {
    name: 'generate_media_plan',
    description: 'Generate a comprehensive media plan with budget allocation, platform strategy, and creative recommendations.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string' }, goals: { type: 'string' }, budget: { type: 'string' }, platforms: { type: 'string' }, audience: { type: 'string' }, offer: { type: 'string' }, timeline: { type: 'string' } }, required: ['clientName'] },
  },
  {
    name: 'check_overdue_tasks',
    description: 'Check for overdue tasks across all clients in the project management system.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'run_morning_briefing',
    description: 'Generate the morning briefing with overnight performance, alerts, and today\'s priorities.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_daily_standup',
    description: 'Generate a daily standup summary of tasks and progress.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_ai_cost_report',
    description: 'Get AI API usage costs for the agency (how much we\'re spending on Claude, GPT, etc.).',
    input_schema: { type: 'object', properties: { period: { type: 'string', enum: ['today', 'week', 'month'] } } },
  },
  {
    name: 'get_audit_log',
    description: 'View recent actions and changes made by the system.',
    input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Number of entries' }, clientName: { type: 'string' } } },
  },
  {
    name: 'get_client_info',
    description: 'Get detailed profile for a specific client including all settings, accounts, and configuration.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string' } }, required: ['clientName'] },
  },
  {
    name: 'request_campaign_pause',
    description: 'Request to pause a campaign. This creates an approval request that the owner must confirm.',
    input_schema: { type: 'object', properties: { campaignId: { type: 'string' }, platform: { type: 'string', enum: ['meta', 'google'] }, reason: { type: 'string' } }, required: ['campaignId', 'platform'] },
  },
];

/**
 * Unified tool executor for both WhatsApp and Telegram CSA agents.
 */
async function executeCSATool(toolName, toolInput) {
  switch (toolName) {
    // --- Direct Ad Library tools (no client required) ---
    case 'search_ad_library': {
      const rawResults = await metaAdLibrary.searchAds({
        searchTerms: toolInput.searchTerms,
        country: toolInput.country || 'BR',
        adActiveStatus: toolInput.adActiveStatus || 'ACTIVE',
        limit: Math.min(toolInput.limit || 10, 25),
      });
      const parsedAds = metaAdLibrary.parseAdLibraryResults(rawResults);
      return {
        searchTerms: toolInput.searchTerms,
        totalAdsFound: parsedAds.length,
        ads: parsedAds.map(ad => ({
          pageName: ad.pageName,
          headline: ad.headline,
          body: ad.body ? (ad.body.length > 300 ? ad.body.slice(0, 300) + '...' : ad.body) : '',
          description: ad.description,
          platforms: ad.platforms,
          startDate: ad.startDate?.split('T')[0] || null,
          isActive: ad.isActive,
          snapshotUrl: ad.snapshotUrl,
          estimatedAudience: ad.estimatedAudience,
          impressions: ad.impressions,
          spend: ad.spend,
        })),
      };
    }
    case 'search_facebook_pages': {
      const results = await metaAdLibrary.searchPages(toolInput.query);
      return {
        query: toolInput.query,
        pages: results?.data?.map(p => ({
          id: p.id,
          name: p.name,
          category: p.category,
          fanCount: p.fan_count,
          verified: p.verification_status,
          link: p.link,
        })) || [],
      };
    }
    case 'get_page_ads': {
      const rawResults = await metaAdLibrary.getPageAds(toolInput.pageId, {
        country: toolInput.country || 'BR',
        limit: toolInput.limit || 10,
      });
      const parsedAds = metaAdLibrary.parseAdLibraryResults(rawResults);
      return {
        pageId: toolInput.pageId,
        totalAdsFound: parsedAds.length,
        ads: parsedAds.map(ad => ({
          pageName: ad.pageName,
          headline: ad.headline,
          body: ad.body ? (ad.body.length > 300 ? ad.body.slice(0, 300) + '...' : ad.body) : '',
          description: ad.description,
          platforms: ad.platforms,
          startDate: ad.startDate?.split('T')[0] || null,
          isActive: ad.isActive,
          snapshotUrl: ad.snapshotUrl,
          estimatedAudience: ad.estimatedAudience,
          impressions: ad.impressions,
          spend: ad.spend,
        })),
      };
    }
    // --- Client-based tools ---
    case 'get_client_stats': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found. Available clients: ${getAllClients().map(c => c.name).join(', ') || 'none'}` };
      const results = {};
      const platform = toolInput.platform || 'all';
      if (client.meta_ad_account_id && (platform === 'meta' || platform === 'all')) {
        try {
          const insights = await metaAds.getAccountInsights(client.meta_ad_account_id, { datePreset: 'last_7d' });
          results.meta = metaAds.extractConversions(insights);
        } catch (e) { results.meta = { error: e.message }; }
      }
      if (client.google_ads_customer_id && (platform === 'google' || platform === 'all')) {
        try {
          const perf = await googleAds.getAccountPerformance(client.google_ads_customer_id);
          if (perf.length > 0) results.google = googleAds.formatGoogleAdsMetrics(perf[0]);
        } catch (e) { results.google = { error: e.message }; }
      }
      return { client: client.name, period: 'last_7d', ...results, monthlyBudget: (client.monthly_budget_cents || 0) / 100, targetRoas: client.target_roas, targetCpa: (client.target_cpa_cents || 0) / 100 };
    }
    case 'list_clients': {
      const clients = getAllClients();
      return { clients: clients.map(c => ({ name: c.name, platforms: [c.meta_ad_account_id ? 'Meta' : null, c.google_ads_customer_id ? 'Google' : null, c.tiktok_advertiser_id ? 'TikTok' : null].filter(Boolean), monthlyBudget: (c.monthly_budget_cents || 0) / 100 })) };
    }
    case 'get_budget_info': {
      if (toolInput.clientName) {
        const client = getClient(toolInput.clientName);
        if (!client) return { error: `Client "${toolInput.clientName}" not found.` };
        return { client: client.name, monthlyBudget: (client.monthly_budget_cents || 0) / 100, targetRoas: client.target_roas || 'N/A', targetCpa: (client.target_cpa_cents || 0) / 100 };
      }
      const clients = getAllClients();
      const overview = clients.map(c => ({ name: c.name, monthlyBudget: (c.monthly_budget_cents || 0) / 100 }));
      return { clients: overview, totalMonthly: overview.reduce((s, c) => s + c.monthlyBudget, 0) };
    }
    case 'run_competitor_analysis': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found. For ad-hoc competitor research, use the search_ad_library tool instead.` };
      const result = await analyzeCompetitors(client);
      return { client: client.name, highlights: result.highlights, reportSaved: true };
    }
    case 'pull_competitor_ads': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found. For ad-hoc competitor research, use the search_ad_library tool instead.` };
      const result = await pullCompetitorCreatives({ clientId: client.id, competitorName: toolInput.competitorName || undefined });
      const totalAds = result.results?.reduce((sum, r) => sum + r.adsFound, 0) || 0;
      return { client: client.name, totalAdsFound: totalAds, results: result.results };
    }
    case 'generate_report': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found.` };
      if (toolInput.reportType === 'monthly') await generateMonthlyReview(client.id);
      else await generateWeeklyReport(client.id);
      return { client: client.name, type: toolInput.reportType || 'weekly', status: 'generated' };
    }
    case 'generate_campaign_brief': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found.` };
      const result = await generateCampaignBrief({ clientId: client.id, campaignObjective: toolInput.objective || 'conversions', platform: client.meta_ad_account_id ? 'meta' : 'google' });
      return { client: client.name, completeness: result.completeness, similarCampaigns: result.similarCampaigns };
    }
    case 'generate_creatives': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found.` };
      await generateCreatives({ clientId: client.id, platform: toolInput.platform || 'meta' });
      return { client: client.name, status: 'creatives_generated', platform: toolInput.platform || 'meta' };
    }
    case 'generate_media_plan': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found.` };
      await generateMediaPlan({ clientId: client.id, brief: { goals: toolInput.goals, budget: toolInput.budget, platforms: toolInput.platforms, audience: toolInput.audience, offer: toolInput.offer, timeline: toolInput.timeline } });
      return { client: client.name, status: 'media_plan_generated' };
    }
    case 'check_overdue_tasks': {
      const result = await runTaskMonitor();
      return { overdue: result.overdue, total: result.total };
    }
    case 'run_morning_briefing': {
      await runMorningBriefing();
      return { status: 'briefing_generated' };
    }
    case 'get_daily_standup': {
      await generateDailyStandup();
      return { status: 'standup_generated' };
    }
    case 'get_ai_cost_report': {
      const summary = getCostSummary(toolInput.period || 'month');
      return summary;
    }
    case 'get_audit_log': {
      const clientId = toolInput.clientName ? getClient(toolInput.clientName)?.id : undefined;
      const entries = getAuditLog(toolInput.limit || 10, clientId);
      return { entries };
    }
    case 'get_client_info': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found.` };
      return { profile: buildClientContext(client.id) };
    }
    case 'request_campaign_pause': {
      const approvalId = `pause-${Date.now()}`;
      pendingApprovals.set(approvalId, { type: 'pause', campaignId: toolInput.campaignId, platform: toolInput.platform, reason: toolInput.reason });
      return { approvalId, status: 'pending_approval', message: `Approval needed. Reply APPROVE ${approvalId} or DENY ${approvalId}` };
    }
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// --- WhatsApp Cloud API Webhook Verification (GET) ---
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.WHATSAPP_VERIFY_TOKEN) {
    log.info('Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// --- WhatsApp Cloud API Webhook (POST) ---
app.post('/webhook/whatsapp', async (req, res) => {
  // Respond immediately to Meta
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message || message.type !== 'text') return;

    const from = message.from; // e.g. "1234567890"
    const body = message.text?.body?.trim();

    if (!body) return;

    log.info('WhatsApp message received', { from, body: body.substring(0, 100) });

    // Normalize phone numbers for comparison (strip + and leading zeros)
    const normalizePhone = (p) => p?.replace(/[^0-9]/g, '');
    const isOwner = normalizePhone(from) === normalizePhone(config.WHATSAPP_OWNER_PHONE);

    if (isOwner) {
      // Owner gets full command access
      await handleCommand(body);
    } else {
      // Client messages get AI-powered responses
      await handleClientMessage(from, body);
    }
  } catch (error) {
    log.error('Command handling failed', { error: error.message });
    await sendWhatsApp(`❌ Error: ${error.message}`);
  }
});

// --- Telegram Bot Webhook (POST) ---
app.post('/webhook/telegram', async (req, res) => {
  // Respond immediately to Telegram
  res.sendStatus(200);

  try {
    const message = req.body?.message;
    if (!message || !message.text) return;

    const chatId = String(message.chat?.id);
    const body = message.text.trim();

    if (!body) return;

    log.info('Telegram message received', { chatId, body: body.substring(0, 100) });

    const isOwner = chatId === config.TELEGRAM_OWNER_CHAT_ID;

    if (isOwner) {
      // Owner gets full command access — reuse existing command handler, send via Telegram
      await handleTelegramCommand(body, chatId);
    } else {
      // Non-owner messages get AI-powered responses via Telegram
      await handleTelegramClientMessage(chatId, body);
    }
  } catch (error) {
    log.error('Telegram command handling failed', { error: error.message });
    await sendTelegram(`❌ Error: ${error.message}`);
  }
});

// --- Telegram CSA Agent Prompt ---
const TELEGRAM_CSA_PROMPT = `You are Sofia, a warm and professional Customer Success Agent for a PPC/digital marketing agency. You chat via Telegram with the agency owner.

Your personality:
- Friendly, proactive, and genuinely helpful — like a trusted team member
- You speak naturally, never like a command-line interface
- You celebrate wins ("Great ROAS this week!") and flag concerns proactively
- You offer suggestions and next steps without being asked
- You use casual but professional language — no jargon unless the user does first

Communication style:
- Use Telegram HTML formatting: <b>bold</b>, <i>italic</i>
- Keep messages concise but insightful — no walls of text
- When sharing data, add context ("That's 15% above your target!")
- If something needs attention, lead with that
- Use emojis naturally but sparingly

CRITICAL RULES:
- When the user asks you to do something, DO IT immediately using your tools. Never tell the user to "onboard a client first" or ask them to set up anything before you can act.
- You can search the Meta Ad Library directly for ANY brand, company, or domain — you do NOT need them to be an onboarded client.
- If asked to analyze competitor ads (e.g. "analyze v4company.com ads"), use the search_ad_library tool directly with their brand name.
- If asked about a specific company's Facebook page, use search_facebook_pages to find it, then pull their ads.
- For client-specific operations (stats, reports, campaigns), use the client-related tools.
- For ad-hoc research and competitor intelligence, use the direct search tools.
- NEVER get stuck in a loop. If a tool returns an error, explain it and try an alternative approach.
- ALWAYS follow through and complete the task. Deliver actual results, not instructions on how to get results.

When you need data or want to perform actions, use the provided tools. Always explain what you're doing in a natural way ("Let me pull up those numbers for you..."). After getting tool results, present them conversationally — don't just dump raw data.

If a tool returns an error, explain it simply and suggest alternatives. Never show raw error objects.

For approval-sensitive actions (pausing campaigns, budget changes), always confirm with the user before proceeding.`;

async function handleTelegramCommand(message, chatId) {
  const reply = (msg) => sendTelegram(msg, chatId);

  // Handle approval responses directly (these need exact format)
  const approvalMatch = message.match(/^(APPROVE|DENY|DETAILS)\s+([a-f0-9-]+)/i);
  if (approvalMatch) {
    return handleTelegramApproval(approvalMatch[1].toUpperCase(), approvalMatch[2], chatId);
  }

  // Handle "clear" / "reset" to wipe memory
  if (/^(clear|reset|new chat|forget)$/i.test(message.trim())) {
    clearHistory(chatId);
    return reply('Memory cleared! Starting fresh.');
  }

  // Build context
  const clients = getAllClients();
  const clientContext = clients.length > 0
    ? `\n\nCurrent clients: ${clients.map(c => c.name).join(', ')}`
    : '\n\nNo clients onboarded yet.';

  // Load conversation history and append the new message
  const history = getHistory(chatId);
  addToHistory(chatId, 'user', message);
  const messages = [...history, { role: 'user', content: message }];

  // Conversational loop with tool use (using shared CSA_TOOLS)
  let response = await askClaude({
    systemPrompt: TELEGRAM_CSA_PROMPT + clientContext,
    messages,
    tools: CSA_TOOLS,
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    workflow: 'telegram-csa',
  });

  // Handle tool use loop (max 10 rounds to allow multi-step tasks)
  let rounds = 0;
  while (response.stopReason === 'tool_use' && rounds < 10) {
    rounds++;

    // Send a natural "working on it" message on first tool call
    if (rounds === 1 && response.text) {
      await reply(response.text);
    }

    // Execute all tool calls
    const toolResults = [];
    for (const tool of response.toolUse) {
      log.info('Executing tool', { tool: tool.name, input: tool.input });
      try {
        const result = await executeCSATool(tool.name, tool.input);
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result) });
      } catch (e) {
        log.error('Tool execution failed', { tool: tool.name, error: e.message });
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify({ error: e.message }), is_error: true });
      }
    }

    // Continue conversation with tool results
    messages.push({ role: 'assistant', content: response.raw.content });
    messages.push({ role: 'user', content: toolResults });

    response = await askClaude({
      systemPrompt: TELEGRAM_CSA_PROMPT + clientContext,
      messages,
      tools: CSA_TOOLS,
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 4096,
      workflow: 'telegram-csa',
    });
  }

  // Send final response and save assistant reply to history
  if (response.text) {
    addToHistory(chatId, 'assistant', response.text);
    await reply(response.text);
  }
}

async function handleTelegramApproval(action, approvalId, chatId) {
  const reply = (msg) => sendTelegram(msg, chatId);
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return reply(`❌ Approval "${approvalId}" not found or expired.`);
  if (action === 'DENY') { pendingApprovals.delete(approvalId); return reply(`❌ Action denied and cancelled.`); }
  if (action === 'DETAILS') return reply(`📋 <b>Action Details:</b>\n${JSON.stringify(pending, null, 2)}`);
  try {
    if (pending.type === 'pause' && pending.platform === 'meta') {
      await metaAds.pauseCampaign(pending.campaignId);
      pendingApprovals.delete(approvalId);
      return reply(`✅ Campaign ${pending.campaignId} paused on Meta.`);
    }
    pendingApprovals.delete(approvalId);
    return reply(`✅ Action approved and executed.`);
  } catch (error) { return reply(`❌ Action failed: ${error.message}`); }
}

async function handleTelegramClientMessage(chatId, message) {
  try {
    const clients = getAllClients();
    const response = await askClaude({
      systemPrompt: `You are an AI assistant for a professional PPC/digital marketing agency. You're chatting with a client via Telegram.

Your role:
- Answer questions about their campaigns, performance, and strategy
- Be professional, friendly, and concise
- If they ask about specific metrics you don't have, offer to have the account manager follow up
- Never share other clients' data
- Keep responses under 500 words
- Use Telegram HTML formatting: <b>bold</b>, <i>italic</i>

Current clients on file: ${clients.map(c => c.name).join(', ')}`,
      userMessage: `Client chat ID: ${chatId}\nMessage: ${message}`,
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 1024,
      workflow: 'client-chat',
    });
    await sendTelegram(response.text, chatId);
  } catch (error) {
    log.error('Telegram client message handling failed', { chatId, error: error.message });
    await sendTelegram('Thank you for your message. Our team will get back to you shortly.', chatId);
  }
}

// --- Health Check ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// --- WhatsApp Conversational Command Handler ---
async function handleCommand(message) {
  const ownerChatId = 'whatsapp-owner';

  // Check for approval responses first (exact format, bypass AI)
  const approvalMatch = message.match(/^(APPROVE|DENY|DETAILS)\s+([a-f0-9-]+)/i);
  if (approvalMatch) {
    return handleApproval(approvalMatch[1].toUpperCase(), approvalMatch[2]);
  }

  // Handle "clear" / "reset" to wipe memory
  if (/^(clear|reset|new chat|forget)$/i.test(message.trim())) {
    clearHistory(ownerChatId);
    return sendWhatsApp('Memory cleared! Starting fresh.');
  }

  // Build context
  const clients = getAllClients();
  const clientContext = clients.length > 0
    ? `\n\nCurrent managed clients: ${clients.map(c => c.name).join(', ')}`
    : '\n\nNo clients onboarded yet. You can still do ad-hoc research using search_ad_library and search_facebook_pages tools.';

  // Load conversation history and append the new message
  const history = getHistory(ownerChatId);
  addToHistory(ownerChatId, 'user', message);
  const messages = [...history, { role: 'user', content: message }];

  // Conversational tool-use loop (same architecture as Telegram)
  let response = await askClaude({
    systemPrompt: WHATSAPP_CSA_PROMPT + clientContext,
    messages,
    tools: CSA_TOOLS,
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    workflow: 'whatsapp-csa',
  });

  // Handle tool use loop (max 10 rounds to allow multi-step tasks)
  let rounds = 0;
  while (response.stopReason === 'tool_use' && rounds < 10) {
    rounds++;

    // Send a natural "working on it" message on first tool call
    if (rounds === 1 && response.text) {
      await sendWhatsApp(response.text);
    }

    // Execute all tool calls
    const toolResults = [];
    for (const tool of response.toolUse) {
      log.info('Executing tool', { tool: tool.name, input: tool.input });
      try {
        const result = await executeCSATool(tool.name, tool.input);
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result) });
      } catch (e) {
        log.error('Tool execution failed', { tool: tool.name, error: e.message });
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify({ error: e.message }), is_error: true });
      }
    }

    // Continue conversation with tool results
    messages.push({ role: 'assistant', content: response.raw.content });
    messages.push({ role: 'user', content: toolResults });

    response = await askClaude({
      systemPrompt: WHATSAPP_CSA_PROMPT + clientContext,
      messages,
      tools: CSA_TOOLS,
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 4096,
      workflow: 'whatsapp-csa',
    });
  }

  // Send final response and save to history
  if (response.text) {
    addToHistory(ownerChatId, 'assistant', response.text);
    await sendWhatsApp(response.text);
  }
}

// --- Client Message Handler (non-owner contacts) ---
async function handleClientMessage(from, message) {
  try {
    const clients = getAllClients();
    const response = await askClaude({
      systemPrompt: `You are an AI assistant for a professional PPC/digital marketing agency. You're chatting with a client via WhatsApp.

Your role:
- Answer questions about their campaigns, performance, and strategy
- Be professional, friendly, and concise
- If they ask about specific metrics you don't have, offer to have the account manager follow up
- Never share other clients' data
- Keep responses under 500 words
- Use WhatsApp formatting: *bold*, _italic_

Current clients on file: ${clients.map(c => c.name).join(', ')}`,
      userMessage: `Client phone: ${from}\nMessage: ${message}`,
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 1024,
      workflow: 'client-chat',
    });

    await sendWhatsApp(response.text, from);
  } catch (error) {
    log.error('Client message handling failed', { from, error: error.message });
    await sendWhatsApp('Thank you for your message. Our team will get back to you shortly.', from);
  }
}

async function handleApproval(action, approvalId) {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    return sendWhatsApp(`❌ Approval "${approvalId}" not found or expired.`);
  }

  if (action === 'DENY') {
    pendingApprovals.delete(approvalId);
    return sendWhatsApp(`❌ Action denied and cancelled.`);
  }

  if (action === 'DETAILS') {
    return sendWhatsApp(`📋 *Action Details:*\n${JSON.stringify(pending, null, 2)}`);
  }

  // APPROVE
  try {
    if (pending.type === 'pause' && pending.platform === 'meta') {
      await metaAds.pauseCampaign(pending.campaignId);
      pendingApprovals.delete(approvalId);
      return sendWhatsApp(`✅ Campaign ${pending.campaignId} paused on Meta.`);
    }

    pendingApprovals.delete(approvalId);
    return sendWhatsApp(`✅ Action approved and executed.`);
  } catch (error) {
    return sendWhatsApp(`❌ Action failed: ${error.message}`);
  }
}

// --- Start Server ---
export function startServer(port) {
  const p = port || config.PORT || 3000;
  app.listen(p, () => {
    log.info(`WhatsApp server listening on port ${p}`);
    console.log(`Webhook server running on port ${p}`);
    console.log(`WhatsApp webhook: http://your-server:${p}/webhook/whatsapp`);
    console.log(`Telegram webhook: http://your-server:${p}/webhook/telegram`);
    console.log(`Health check: http://your-server:${p}/health`);
  });
  return app;
}

// CLI entry point
if (process.argv[1]?.endsWith('whatsapp-server.js')) {
  startServer();
}

export default { startServer, app };
