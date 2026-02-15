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

// --- Telegram Conversational CSA Agent ---
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

When you need data or want to perform actions, use the provided tools. Always explain what you're doing in a natural way ("Let me pull up those numbers for you..."). After getting tool results, present them conversationally — don't just dump raw data.

If a tool returns an error, explain it simply and suggest alternatives. Never show raw error objects.

For approval-sensitive actions (pausing campaigns, budget changes), always confirm with the user before proceeding.`;

const TELEGRAM_TOOLS = [
  {
    name: 'get_client_stats',
    description: 'Get performance stats (spend, ROAS, CPA, conversions, CTR) for a client across their ad platforms (Meta, Google Ads). Use this when the user asks about performance, metrics, how campaigns are doing, etc.',
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
    description: 'Run a deep competitor intelligence analysis for a client. Analyzes competitor ad strategy, messaging, targeting, and identifies opportunities.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string' } }, required: ['clientName'] },
  },
  {
    name: 'pull_competitor_ads',
    description: 'Pull live competitor ads from the Meta Ad Library with AI creative analysis. Can target a specific competitor or all known competitors.',
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

async function executeTelegramTool(toolName, toolInput) {
  switch (toolName) {
    case 'get_client_stats': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found. Available clients: ${getAllClients().map(c => c.name).join(', ')}` };
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
      if (!client) return { error: `Client "${toolInput.clientName}" not found.` };
      const result = await analyzeCompetitors(client);
      return { client: client.name, highlights: result.highlights, reportSaved: true };
    }
    case 'pull_competitor_ads': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found.` };
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

async function handleTelegramCommand(message, chatId) {
  const reply = (msg) => sendTelegram(msg, chatId);

  // Handle approval responses directly (these need exact format)
  const approvalMatch = message.match(/^(APPROVE|DENY|DETAILS)\s+([a-f0-9-]+)/i);
  if (approvalMatch) {
    return handleTelegramApproval(approvalMatch[1].toUpperCase(), approvalMatch[2], chatId);
  }

  // Build context
  const clients = getAllClients();
  const clientContext = clients.length > 0
    ? `\n\nCurrent clients: ${clients.map(c => c.name).join(', ')}`
    : '\n\nNo clients onboarded yet.';

  const messages = [{ role: 'user', content: message }];

  // Conversational loop with tool use
  let response = await askClaude({
    systemPrompt: TELEGRAM_CSA_PROMPT + clientContext,
    messages,
    tools: TELEGRAM_TOOLS,
    model: 'claude-sonnet-4-5-20250514',
    maxTokens: 2048,
    workflow: 'telegram-csa',
  });

  // Handle tool use loop (max 5 rounds to prevent infinite loops)
  let rounds = 0;
  while (response.stopReason === 'tool_use' && rounds < 5) {
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
        const result = await executeTelegramTool(tool.name, tool.input);
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
      tools: TELEGRAM_TOOLS,
      model: 'claude-sonnet-4-5-20250514',
      maxTokens: 2048,
      workflow: 'telegram-csa',
    });
  }

  // Send final response
  if (response.text) {
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
      model: 'claude-sonnet-4-5-20250514',
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

// --- Command Handler ---
async function handleCommand(message) {
  // Check for approval responses first
  const approvalMatch = message.match(/^(APPROVE|DENY|DETAILS)\s+([a-f0-9-]+)/i);
  if (approvalMatch) {
    return handleApproval(approvalMatch[1].toUpperCase(), approvalMatch[2]);
  }

  // Use Claude to parse intent
  const parseResponse = await askClaude({
    systemPrompt: SYSTEM_PROMPTS.commandParser,
    userMessage: message,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 512,
    workflow: 'command-parser',
  });

  let parsed;
  try {
    // Extract JSON from response
    const jsonMatch = parseResponse.text.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { intent: 'unknown' };
  } catch {
    parsed = { intent: 'unknown', params: { originalMessage: message } };
  }

  log.info('Parsed command', { intent: parsed.intent, params: parsed.params });

  switch (parsed.intent) {
    case 'stats':
      return handleStats(parsed.params);
    case 'pause':
      return handlePause(parsed.params);
    case 'resume':
      return handleResume(parsed.params);
    case 'report':
      return handleReport(parsed.params);
    case 'overdue':
      return handleOverdue();
    case 'briefing':
      return handleBriefing();
    case 'competitor':
      return handleCompetitor(parsed.params);
    case 'budget':
      return handleBudget(parsed.params);
    case 'cost':
      return handleCostReport(parsed.params);
    case 'audit':
      return handleAuditLog(parsed.params);
    case 'client_info':
      return handleClientInfo(parsed.params);
    case 'create_campaign':
      return handleCreateCampaign(parsed.params);
    case 'standup':
      return handleStandup();
    case 'generate_creatives':
      return handleGenerateCreatives(parsed.params);
    case 'competitor_ads':
      return handleCompetitorAds(parsed.params);
    case 'media_plan':
      return handleMediaPlan(parsed.params);
    case 'help':
      return handleHelp();
    default:
      return handleUnknown(message);
  }
}

// --- Command Handlers ---

async function handleStats(params) {
  const { clientName, platform } = params || {};

  if (!clientName) {
    // Show summary of all clients
    const clients = getAllClients();
    let msg = `📊 *All Clients Summary*\n\n`;
    for (const c of clients) {
      msg += `• *${c.name}*: `;
      const platforms = [];
      if (c.meta_ad_account_id) platforms.push('Meta');
      if (c.google_ads_customer_id) platforms.push('Google');
      if (c.tiktok_advertiser_id) platforms.push('TikTok');
      msg += platforms.join(', ') || 'No accounts linked';
      msg += '\n';
    }
    return sendWhatsApp(msg);
  }

  const client = getClient(clientName);
  if (!client) {
    return sendWhatsApp(`❌ Client "${clientName}" not found. Type "clients" to see all clients.`);
  }

  let msg = `📊 *${client.name} - Performance*\n\n`;

  if (client.meta_ad_account_id && (!platform || platform === 'meta')) {
    try {
      const insights = await metaAds.getAccountInsights(client.meta_ad_account_id, { datePreset: 'last_7d' });
      const data = metaAds.extractConversions(insights);
      if (data) {
        msg += `*Meta (Last 7 Days):*\n`;
        msg += `Spend: $${data.spend.toFixed(2)}\n`;
        msg += `ROAS: ${data.roas.toFixed(2)}\n`;
        msg += `CPA: $${data.cpa.toFixed(2)}\n`;
        msg += `Conversions: ${data.conversions}\n`;
        msg += `CTR: ${data.ctr.toFixed(2)}%\n\n`;
      }
    } catch (e) {
      msg += `Meta: _Error fetching data_\n\n`;
    }
  }

  if (client.google_ads_customer_id && (!platform || platform === 'google')) {
    try {
      const perf = await googleAds.getAccountPerformance(client.google_ads_customer_id);
      if (perf.length > 0) {
        const data = googleAds.formatGoogleAdsMetrics(perf[0]);
        msg += `*Google Ads (Last 7 Days):*\n`;
        msg += `Spend: $${data.cost}\n`;
        msg += `ROAS: ${data.roas.toFixed(2)}\n`;
        msg += `CPA: $${data.cpa.toFixed(2)}\n`;
        msg += `Conversions: ${data.conversions}\n`;
        msg += `CTR: ${data.ctr.toFixed(2)}%\n\n`;
      }
    } catch (e) {
      msg += `Google Ads: _Error fetching data_\n\n`;
    }
  }

  return sendWhatsApp(msg);
}

async function handlePause(params) {
  const { campaignId, platform, reason } = params || {};
  if (!campaignId || !platform) {
    return sendWhatsApp('❌ Please specify campaign ID and platform.\nExample: "Pause campaign 12345 on Meta because low ROAS"');
  }

  // This requires approval
  const approvalId = `pause-${Date.now()}`;
  pendingApprovals.set(approvalId, { type: 'pause', campaignId, platform, reason });

  return sendWhatsApp(
    `🔐 *Confirm Pause*\n\nCampaign: ${campaignId}\nPlatform: ${platform}\nReason: ${reason || 'Not specified'}\n\nReply: *APPROVE ${approvalId}* or *DENY ${approvalId}*`
  );
}

async function handleResume(params) {
  return sendWhatsApp('⚠️ Resume functionality requires manual approval. Please confirm which campaign to resume and I\'ll set it up.');
}

async function handleReport(params) {
  const { clientName, type } = params || {};
  if (!clientName) {
    return sendWhatsApp('❌ Please specify a client name.\nExample: "Generate weekly report for Acme Corp"');
  }
  const client = getClient(clientName);
  if (!client) return sendWhatsApp(`❌ Client "${clientName}" not found.`);

  await sendWhatsApp(`📝 Generating ${type || 'weekly'} report for ${client.name}...`);
  try {
    if (type === 'monthly') {
      await generateMonthlyReview(client.id);
    } else {
      await generateWeeklyReport(client.id);
    }
  } catch (e) {
    await sendWhatsApp(`❌ Report generation failed: ${e.message}`);
  }
}

async function handleOverdue() {
  const result = await runTaskMonitor();
  if (result.overdue === 0) {
    return sendWhatsApp('✅ No overdue tasks! All on track.');
  }
  // The runTaskMonitor function already sends alerts for overdue tasks
}

async function handleBriefing() {
  await sendWhatsApp('📊 Generating morning briefing now...');
  await runMorningBriefing();
}

async function handleCompetitor(params) {
  const { clientName } = params || {};
  if (!clientName) {
    return sendWhatsApp('❌ Please specify a client name.\nExample: "Competitor analysis for Acme Corp"');
  }
  const client = getClient(clientName);
  if (!client) return sendWhatsApp(`❌ Client "${clientName}" not found.`);

  await sendWhatsApp(`🔍 Running competitor analysis for ${client.name}...`);
  try {
    const result = await analyzeCompetitors(client);
    const summary = result.highlights.map(h => `• ${h}`).join('\n');
    await sendWhatsApp(`🔍 *Competitor Analysis: ${client.name}*\n\n${summary}\n\n_Full report saved to Google Drive_`);
  } catch (e) {
    await sendWhatsApp(`❌ Competitor analysis failed: ${e.message}`);
  }
}

async function handleCreateCampaign(params) {
  const { clientName, objective } = params || {};
  if (!clientName) return sendWhatsApp('❌ Please specify a client.\nExample: "Create campaign for Acme Corp conversions"');
  const client = getClient(clientName);
  if (!client) return sendWhatsApp(`❌ Client "${clientName}" not found.`);

  await sendWhatsApp(`📝 Generating campaign brief for ${client.name}...`);
  try {
    const result = await generateCampaignBrief({
      clientId: client.id,
      campaignObjective: objective || 'conversions',
      platform: client.meta_ad_account_id ? 'meta' : 'google',
    });
    await sendWhatsApp(`📝 *Brief Generated: ${client.name}*\nCompleteness: ${result.completeness.score}/10\nSimilar past campaigns referenced: ${result.similarCampaigns}\n\n_Full brief posted to ClickUp_`);
  } catch (e) {
    await sendWhatsApp(`❌ Brief generation failed: ${e.message}`);
  }
}

async function handleStandup() {
  await sendWhatsApp('📋 Generating daily standup...');
  await generateDailyStandup();
}

async function handleGenerateCreatives(params) {
  const { clientName, platform } = params || {};
  if (!clientName) return sendWhatsApp('❌ Specify a client.\nExample: "Generate creatives for Acme Corp on Meta"');
  const client = getClient(clientName);
  if (!client) return sendWhatsApp(`❌ Client "${clientName}" not found.`);

  await sendWhatsApp(`🎨 Generating creatives for ${client.name}...`);
  try {
    const result = await generateCreatives({
      clientId: client.id,
      platform: platform || 'meta',
    });
    await sendWhatsApp(`🎨 *Creatives Ready: ${client.name}*\nSent for approval. Check ClickUp/Google Drive for full creative package.`);
  } catch (e) {
    await sendWhatsApp(`❌ Creative generation failed: ${e.message}`);
  }
}

async function handleCompetitorAds(params) {
  const { clientName, competitorName } = params || {};
  if (!clientName) {
    return sendWhatsApp('❌ Specify a client.\nExample: "Show competitor ads for Acme Corp" or "Show Nike ads for Acme Corp"');
  }
  const client = getClient(clientName);
  if (!client) return sendWhatsApp(`❌ Client "${clientName}" not found.`);

  await sendWhatsApp(`🔍 Pulling competitor ads for ${client.name}${competitorName ? ` (${competitorName})` : ''}...`);
  try {
    const result = await pullCompetitorCreatives({
      clientId: client.id,
      competitorName: competitorName || undefined,
    });
    const totalAds = result.results?.reduce((sum, r) => sum + r.adsFound, 0) || 0;
    if (totalAds === 0) {
      await sendWhatsApp(`🔍 No active competitor ads found. Try specifying a competitor name.`);
    }
  } catch (e) {
    await sendWhatsApp(`❌ Failed to pull competitor ads: ${e.message}`);
  }
}

async function handleMediaPlan(params) {
  const { clientName, goals, pains, audience, budget, platforms, offer, timeline } = params || {};
  if (!clientName) {
    return sendWhatsApp('❌ Specify a client.\nExample: "Create media plan for Acme Corp" or "Media plan for Acme Corp with $5000 budget focused on lead gen"');
  }
  const client = getClient(clientName);
  if (!client) return sendWhatsApp(`❌ Client "${clientName}" not found.`);

  await sendWhatsApp(`📋 Generating media plan for ${client.name}...\nThis includes creative mockup recommendations. Please wait.`);
  try {
    await generateMediaPlan({
      clientId: client.id,
      brief: {
        goals: goals || undefined,
        pains: pains || undefined,
        audience: audience || undefined,
        budget: budget || undefined,
        platforms: platforms || undefined,
        offer: offer || undefined,
        timeline: timeline || undefined,
      },
    });
  } catch (e) {
    await sendWhatsApp(`❌ Media plan generation failed: ${e.message}`);
  }
}

async function handleBudget(params) {
  const { clientName } = params || {};
  if (clientName) {
    const client = getClient(clientName);
    if (!client) return sendWhatsApp(`❌ Client "${clientName}" not found.`);
    return sendWhatsApp(`💰 *${client.name} Budget*\nMonthly: $${((client.monthly_budget_cents || 0) / 100).toFixed(0)}\nTarget ROAS: ${client.target_roas || 'N/A'}\nTarget CPA: $${((client.target_cpa_cents || 0) / 100).toFixed(2)}`);
  }

  const clients = getAllClients();
  let msg = '💰 *Budget Overview*\n\n';
  let totalBudget = 0;
  for (const c of clients) {
    const budget = (c.monthly_budget_cents || 0) / 100;
    totalBudget += budget;
    msg += `• ${c.name}: $${budget.toFixed(0)}/mo\n`;
  }
  msg += `\n*Total: $${totalBudget.toFixed(0)}/mo*`;
  return sendWhatsApp(msg);
}

async function handleCostReport(params) {
  const period = params?.period || 'month';
  const summary = getCostSummary(period);

  let msg = `🤖 *AI Cost Report (${period})*\n\n`;
  msg += `Total: *$${summary.totalDollars}*\n`;
  msg += `Budget Used: ${summary.budgetUsedPct}%\n\n`;

  if (summary.byPlatform.length > 0) {
    msg += `*By Platform:*\n`;
    for (const p of summary.byPlatform) {
      msg += `• ${p.platform}: $${(p.total / 100).toFixed(2)}\n`;
    }
  }

  if (summary.byWorkflow.length > 0) {
    msg += `\n*By Workflow:*\n`;
    for (const w of summary.byWorkflow) {
      msg += `• ${w.workflow}: $${(w.total / 100).toFixed(2)}\n`;
    }
  }

  return sendWhatsApp(msg);
}

async function handleAuditLog(params) {
  const entries = getAuditLog(params?.limit || 10, params?.clientName ? getClient(params.clientName)?.id : undefined);

  let msg = `📋 *Recent Actions (${entries.length})*\n\n`;
  for (const e of entries) {
    msg += `• ${e.timestamp} - ${e.action} (${e.approved_by}) - ${e.result}\n`;
  }

  return sendWhatsApp(msg);
}

async function handleClientInfo(params) {
  const { clientName } = params || {};
  if (!clientName) return sendWhatsApp('❌ Please specify a client name.');

  const client = getClient(clientName);
  if (!client) return sendWhatsApp(`❌ Client "${clientName}" not found.`);

  const context = buildClientContext(client.id);
  return sendWhatsApp(context);
}

async function handleHelp() {
  const msg = `🤖 *PPC Agency Bot Commands*

📊 *Performance:*
• "Stats for [client]"
• "How is [client] performing?"
• "Show me all clients"

⏸️ *Campaign Management:*
• "Pause campaign [ID] on [platform]"
• "Resume campaign [ID]"
• "Create campaign for [client]"
• "Generate creatives for [client]"

📋 *Tasks:*
• "Overdue tasks"
• "What's due today?"
• "Daily standup"

📝 *Reports:*
• "Weekly report for [client]"
• "Monthly report for [client]"
• "Morning briefing"

💰 *Budget & Costs:*
• "Budget for [client]"
• "AI cost report"
• "Budget overview"

🔍 *Intelligence:*
• "Competitor analysis for [client]"
• "Competitor ads for [client]"
• "Show [competitor] ads for [client]"
• "Client info for [client]"
• "Audit log"

📋 *Planning:*
• "Media plan for [client]"
• "Media plan for [client] with $5000 budget for lead gen"

🔐 *Approvals:*
• "APPROVE [id]" / "DENY [id]" / "DETAILS [id]"

All commands use natural language!`;

  return sendWhatsApp(msg);
}

async function handleUnknown(message) {
  // Use Claude to try to help
  const response = await askClaude({
    systemPrompt: 'You are a PPC agency assistant. The user sent a command that was not recognized. Help them by suggesting the right command format. Be brief.',
    userMessage: `User said: "${message}". Suggest the right command format from: stats, pause, report, overdue, briefing, competitor, budget, cost, audit, client info, help.`,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 256,
    workflow: 'command-unknown',
  });

  return sendWhatsApp(`🤔 I didn't quite understand that.\n\n${response.text}\n\nType *help* for all commands.`);
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
      model: 'claude-sonnet-4-5-20250514',
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
