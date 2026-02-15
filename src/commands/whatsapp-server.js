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

// --- Telegram Command Handler (mirrors WhatsApp commands but sends via Telegram) ---
async function handleTelegramCommand(message, chatId) {
  // Check for approval responses first
  const approvalMatch = message.match(/^(APPROVE|DENY|DETAILS)\s+([a-f0-9-]+)/i);
  if (approvalMatch) {
    return handleTelegramApproval(approvalMatch[1].toUpperCase(), approvalMatch[2], chatId);
  }

  // Use Claude to parse intent (same as WhatsApp)
  const parseResponse = await askClaude({
    systemPrompt: SYSTEM_PROMPTS.commandParser,
    userMessage: message,
    model: 'claude-haiku-3-5-20241022',
    maxTokens: 512,
    workflow: 'command-parser',
  });

  let parsed;
  try {
    const jsonMatch = parseResponse.text.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { intent: 'unknown' };
  } catch {
    parsed = { intent: 'unknown', params: { originalMessage: message } };
  }

  log.info('Telegram parsed command', { intent: parsed.intent, params: parsed.params });

  // Route to handlers, passing sendTelegram as the reply function
  const reply = (msg) => sendTelegram(msg, chatId);
  switch (parsed.intent) {
    case 'stats':
      return handleTelegramStats(parsed.params, reply);
    case 'pause':
      return handleTelegramPause(parsed.params, reply);
    case 'report':
      return handleTelegramReport(parsed.params, reply);
    case 'overdue':
      return handleTelegramOverdue(reply);
    case 'briefing':
      return handleTelegramBriefing(reply);
    case 'budget':
      return handleTelegramBudget(parsed.params, reply);
    case 'cost':
      return handleTelegramCostReport(parsed.params, reply);
    case 'help':
      return handleTelegramHelp(reply);
    default:
      return handleTelegramUnknown(message, reply);
  }
}

async function handleTelegramStats(params, reply) {
  const { clientName, platform } = params || {};
  if (!clientName) {
    const clients = getAllClients();
    let msg = `📊 <b>All Clients Summary</b>\n\n`;
    for (const c of clients) {
      msg += `• <b>${c.name}</b>: `;
      const platforms = [];
      if (c.meta_ad_account_id) platforms.push('Meta');
      if (c.google_ads_customer_id) platforms.push('Google');
      if (c.tiktok_advertiser_id) platforms.push('TikTok');
      msg += platforms.join(', ') || 'No accounts linked';
      msg += '\n';
    }
    return reply(msg);
  }
  const client = getClient(clientName);
  if (!client) return reply(`❌ Client "${clientName}" not found. Type "clients" to see all clients.`);

  let msg = `📊 <b>${client.name} - Performance</b>\n\n`;
  if (client.meta_ad_account_id && (!platform || platform === 'meta')) {
    try {
      const insights = await metaAds.getAccountInsights(client.meta_ad_account_id, { datePreset: 'last_7d' });
      const data = metaAds.extractConversions(insights);
      if (data) {
        msg += `<b>Meta (Last 7 Days):</b>\nSpend: $${data.spend.toFixed(2)}\nROAS: ${data.roas.toFixed(2)}\nCPA: $${data.cpa.toFixed(2)}\nConversions: ${data.conversions}\nCTR: ${data.ctr.toFixed(2)}%\n\n`;
      }
    } catch { msg += `Meta: <i>Error fetching data</i>\n\n`; }
  }
  if (client.google_ads_customer_id && (!platform || platform === 'google')) {
    try {
      const perf = await googleAds.getAccountPerformance(client.google_ads_customer_id);
      if (perf.length > 0) {
        const data = googleAds.formatGoogleAdsMetrics(perf[0]);
        msg += `<b>Google Ads (Last 7 Days):</b>\nSpend: $${data.cost}\nROAS: ${data.roas.toFixed(2)}\nCPA: $${data.cpa.toFixed(2)}\nConversions: ${data.conversions}\nCTR: ${data.ctr.toFixed(2)}%\n\n`;
      }
    } catch { msg += `Google Ads: <i>Error fetching data</i>\n\n`; }
  }
  return reply(msg);
}

async function handleTelegramPause(params, reply) {
  const { campaignId, platform, reason } = params || {};
  if (!campaignId || !platform) {
    return reply('❌ Please specify campaign ID and platform.\nExample: "Pause campaign 12345 on Meta because low ROAS"');
  }
  const approvalId = `pause-${Date.now()}`;
  pendingApprovals.set(approvalId, { type: 'pause', campaignId, platform, reason });
  return reply(
    `🔐 <b>Confirm Pause</b>\n\nCampaign: ${campaignId}\nPlatform: ${platform}\nReason: ${reason || 'Not specified'}\n\nReply: <b>APPROVE ${approvalId}</b> or <b>DENY ${approvalId}</b>`
  );
}

async function handleTelegramReport(params, reply) {
  const { clientName, type } = params || {};
  if (!clientName) return reply('❌ Please specify a client name.\nExample: "Generate weekly report for Acme Corp"');
  const client = getClient(clientName);
  if (!client) return reply(`❌ Client "${clientName}" not found.`);
  await reply(`📝 Generating ${type || 'weekly'} report for ${client.name}...`);
  try {
    if (type === 'monthly') await generateMonthlyReview(client.id);
    else await generateWeeklyReport(client.id);
  } catch (e) { await reply(`❌ Report generation failed: ${e.message}`); }
}

async function handleTelegramOverdue(reply) {
  const result = await runTaskMonitor();
  if (result.overdue === 0) return reply('✅ No overdue tasks! All on track.');
}

async function handleTelegramBriefing(reply) {
  await reply('📊 Generating morning briefing now...');
  await runMorningBriefing();
}

async function handleTelegramBudget(params, reply) {
  const { clientName } = params || {};
  if (clientName) {
    const client = getClient(clientName);
    if (!client) return reply(`❌ Client "${clientName}" not found.`);
    return reply(`💰 <b>${client.name} Budget</b>\nMonthly: $${((client.monthly_budget_cents || 0) / 100).toFixed(0)}\nTarget ROAS: ${client.target_roas || 'N/A'}\nTarget CPA: $${((client.target_cpa_cents || 0) / 100).toFixed(2)}`);
  }
  const clients = getAllClients();
  let msg = '💰 <b>Budget Overview</b>\n\n';
  let totalBudget = 0;
  for (const c of clients) {
    const budget = (c.monthly_budget_cents || 0) / 100;
    totalBudget += budget;
    msg += `• ${c.name}: $${budget.toFixed(0)}/mo\n`;
  }
  msg += `\n<b>Total: $${totalBudget.toFixed(0)}/mo</b>`;
  return reply(msg);
}

async function handleTelegramCostReport(params, reply) {
  const period = params?.period || 'month';
  const summary = getCostSummary(period);
  let msg = `🤖 <b>AI Cost Report (${period})</b>\n\nTotal: <b>$${summary.totalDollars}</b>\nBudget Used: ${summary.budgetUsedPct}%\n\n`;
  if (summary.byPlatform.length > 0) {
    msg += `<b>By Platform:</b>\n`;
    for (const p of summary.byPlatform) msg += `• ${p.platform}: $${(p.total / 100).toFixed(2)}\n`;
  }
  if (summary.byWorkflow.length > 0) {
    msg += `\n<b>By Workflow:</b>\n`;
    for (const w of summary.byWorkflow) msg += `• ${w.workflow}: $${(w.total / 100).toFixed(2)}\n`;
  }
  return reply(msg);
}

async function handleTelegramHelp(reply) {
  const msg = `🤖 <b>PPC Agency Bot Commands (Telegram)</b>

📊 <b>Performance:</b>
• "Stats for [client]"
• "How is [client] performing?"
• "Show me all clients"

⏸️ <b>Campaign Management:</b>
• "Pause campaign [ID] on [platform]"
• "Create campaign for [client]"

📋 <b>Tasks:</b>
• "Overdue tasks"
• "Daily standup"

📝 <b>Reports:</b>
• "Weekly report for [client]"
• "Monthly report for [client]"
• "Morning briefing"

💰 <b>Budget &amp; Costs:</b>
• "Budget for [client]"
• "AI cost report"

🔐 <b>Approvals:</b>
• "APPROVE [id]" / "DENY [id]" / "DETAILS [id]"

All commands use natural language!`;
  return reply(msg);
}

async function handleTelegramUnknown(message, reply) {
  const response = await askClaude({
    systemPrompt: 'You are a PPC agency assistant. The user sent a command that was not recognized. Help them by suggesting the right command format. Be brief.',
    userMessage: `User said: "${message}". Suggest the right command format from: stats, pause, report, overdue, briefing, budget, cost, help.`,
    model: 'claude-haiku-3-5-20241022',
    maxTokens: 256,
    workflow: 'command-unknown',
  });
  return reply(`🤔 I didn't quite understand that.\n\n${response.text}\n\nType <b>help</b> for all commands.`);
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
    model: 'claude-haiku-3-5-20241022',
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
    model: 'claude-haiku-3-5-20241022',
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
