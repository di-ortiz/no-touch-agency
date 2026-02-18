import express from 'express';
import { askClaude } from '../api/anthropic.js';
import { sendWhatsApp, sendAlert, sendThinkingMessage as sendWhatsAppThinking, sendWhatsAppImage, sendWhatsAppVideo, sendWhatsAppDocument } from '../api/whatsapp.js';
import { sendTelegram, sendAlert as sendTelegramAlert, sendThinkingMessage as sendTelegramThinking, sendTelegramPhoto, sendTelegramVideo, sendTelegramDocument } from '../api/telegram.js';
import {
  getAllClients, getClient, buildClientContext, getContactByPhone, getOnboardingSession,
  createPendingClient, getPendingClientByToken, getPendingClientByTokenAny, getLatestPendingClient, activatePendingClient,
  saveMessage, getMessages, clearMessages, createOnboardingSession, updateOnboardingSession,
  createContact, checkClientMessageLimit, updateClient,
  getContactsByClientId, getCrossChannelHistory,
} from '../services/knowledge-base.js';
import { handleOnboardingMessage, initiateOnboarding, hasActiveOnboarding, getClientContextByPhone, buildPersonalizedWelcome } from '../services/client-onboarding-flow.js';
import { getMe as getTelegramMe } from '../api/telegram.js';
import crypto from 'crypto';
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
import * as pagespeed from '../api/pagespeed.js';
import * as googleSheets from '../api/google-sheets.js';
import * as keywordPlanner from '../api/google-keyword-planner.js';
import * as dataforseo from '../api/dataforseo.js';
import * as openaiMedia from '../api/openai-media.js';
import * as googleSlides from '../api/google-slides.js';
import * as creativeEngine from '../services/creative-engine.js';
import * as webScraper from '../api/web-scraper.js';
import * as leadsie from '../api/leadsie.js';
import * as seoEngine from '../services/seo-engine.js';
import * as supabase from '../api/supabase.js';
import * as googleDrive from '../api/google-drive.js';
import * as googleAnalytics from '../api/google-analytics.js';
import * as googleTransparency from '../api/google-transparency.js';
import * as presentationBuilder from '../services/presentation-builder.js';
import * as reportBuilder from '../services/report-builder.js';
import * as chartBuilderService from '../services/chart-builder.js';
import * as campaignRecord from '../services/campaign-record.js';
import { SYSTEM_PROMPTS } from '../prompts/templates.js';
import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const log = logger.child({ workflow: 'whatsapp-command' });

// Token regex: matches both legacy 12-char hex tokens AND UUID v4 format
const TOKEN_RE_START = /^\/start\s+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{12})$/i;
const TOKEN_RE_INLINE = /\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{12})\b/i;

// Helper: send a "thinking" indicator on the correct channel
async function sendThinkingIndicator(channel, chatId, message) {
  try {
    if (channel === 'telegram') {
      await sendTelegramThinking(chatId, message);
    } else {
      await sendWhatsAppThinking(chatId, message);
    }
  } catch (e) {
    log.debug('Failed to send thinking indicator', { error: e.message });
  }
}

// Helper: deliver generated media (images/videos) inline after tool execution
async function deliverMediaInline(toolName, result, channel, chatId) {
  const sendImage = (url, caption) =>
    channel === 'telegram' ? sendTelegramPhoto(url, caption, chatId) : sendWhatsAppImage(url, caption, chatId);
  const sendVideo = (url, caption) =>
    channel === 'telegram' ? sendTelegramVideo(url, caption, chatId) : sendWhatsAppVideo(url, caption, chatId);

  try {
    // Generated ad images (DALL-E 3)
    if (toolName === 'generate_ad_images' && result.images) {
      for (const img of result.images) {
        if (!img.url || img.error) continue;
        await sendImage(img.url, img.label || img.format || 'Ad image');
      }
    }
    // Generated ad video (Sora 2)
    if (toolName === 'generate_ad_video' && result.videoUrl) {
      await sendVideo(result.videoUrl, `${result.duration || ''}s ${result.aspectRatio || ''} video`.trim());
    }
    // Creative package (images + optional video)
    if (toolName === 'generate_creative_package' && result.imageUrls) {
      for (const url of result.imageUrls) {
        if (url) await sendImage(url, 'Creative package image');
      }
    }
    // Ad library search results — send snapshot previews
    if ((toolName === 'search_ad_library' || toolName === 'get_page_ads') && result.ads) {
      for (const ad of result.ads) {
        if (!ad.snapshotUrl) continue;
        const caption = ad.pageName ? `${ad.pageName}${ad.headline ? ' — ' + ad.headline : ''}` : (ad.headline || 'Ad preview');
        await sendImage(ad.snapshotUrl, caption);
      }
    }
    // Google Ads Transparency — send creative previews
    if (toolName === 'search_google_ads_transparency' && result.creatives) {
      for (const creative of result.creatives) {
        if (!creative.previewUrl) continue;
        if (creative.format === 'VIDEO') {
          await sendVideo(creative.previewUrl, `Google Ad — ${creative.format}`);
        } else {
          await sendImage(creative.previewUrl, `Google Ad — ${creative.format || 'preview'}`);
        }
      }
    }
  } catch (e) {
    log.warn('Failed to deliver media inline', { error: e.message, toolName });
  }
}

const app = express();
app.set('trust proxy', 1); // Trust first proxy (Railway, Render, etc.)
app.use(helmet());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Rate limit webhook endpoint
app.use('/webhook', rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many requests',
  validate: { xForwardedForHeader: false, default: true },
}));

// CORS for /api routes (called from Lovable website)
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Rate limit /api endpoints
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many requests',
  validate: { xForwardedForHeader: false, default: true },
}));

// --- POST /api/client-init --- (called by Lovable after payment)
app.post('/api/client-init', async (req, res) => {
  try {
    // Optional API key check
    if (config.CLIENT_INIT_API_KEY) {
      const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
      if (apiKey !== config.CLIENT_INIT_API_KEY) {
        return res.status(401).json({ error: 'Invalid API key' });
      }
    }

    const { email, plan, name, language, phone, website, business_name, business_description, product_service, submissionId } = req.body || {};

    // Use Lovable UUID as token if provided, otherwise generate a new UUID
    const token = submissionId || crypto.randomUUID();

    // Build enriched data, optionally filling gaps from Supabase
    let enrichedData = { email, plan, name, language: language || 'en', phone, website, business_name, business_description, product_service };
    if (submissionId) {
      try {
        const supabaseData = await supabase.getOnboardingSubmission(submissionId);
        if (supabaseData) {
          for (const [key, value] of Object.entries(supabaseData)) {
            if (key !== 'token' && !enrichedData[key] && value) {
              enrichedData[key] = value;
            }
          }
        }
      } catch (e) {
        log.warn('Supabase enrichment failed, continuing with provided data', { error: e.message });
      }
    }

    // Store in DB with all form fields
    createPendingClient({ token, ...enrichedData });

    // Build WhatsApp deep link
    const waPhone = config.WHATSAPP_BUSINESS_PHONE || config.WHATSAPP_OWNER_PHONE;
    const waMessage = `Hi Sofia, I am ${name || 'a new client'}${business_name ? `, representing ${business_name}` : ''}${website ? ` (${website})` : ''}. My Unique Client Code is ${token}.`;
    const whatsappLink = `https://wa.me/${waPhone}?text=${encodeURIComponent(waMessage)}`;

    // Build Telegram deep link
    let telegramLink = null;
    if (telegramBotUsername) {
      telegramLink = `https://t.me/${telegramBotUsername}?start=${token}`;
    } else if (config.TELEGRAM_BOT_TOKEN) {
      // Try to fetch bot username dynamically
      try {
        const me = await getTelegramMe();
        telegramBotUsername = me.username;
        telegramLink = `https://t.me/${telegramBotUsername}?start=${token}`;
      } catch (e) {
        log.warn('Could not fetch Telegram bot username', { error: e.message });
      }
    }

    log.info('Client init created', { token, email, plan, name, language: language || 'en', website, business_name });

    res.json({
      success: true,
      token,
      links: {
        whatsapp: whatsappLink,
        telegram: telegramLink,
      },
    });
  } catch (error) {
    log.error('Client init failed', { error: error.message });
    res.status(500).json({ error: 'Failed to create client session' });
  }
});

// Pending approval actions
const pendingApprovals = new Map();

// Persistent conversation history (DB-backed, survives restarts)
const MAX_HISTORY_MESSAGES = 20; // keep last 20 exchanges per user

function getHistory(chatId) {
  return getMessages(chatId, MAX_HISTORY_MESSAGES * 2);
}

function addToHistory(chatId, role, content, channel = 'whatsapp') {
  saveMessage(chatId, channel, role, content);
}

function clearHistory(chatId) {
  clearMessages(chatId);
}

/**
 * Summarize tool results for persistent conversation history.
 * Extracts key deliverables (URLs, counts, ad copy previews) so Sofia
 * retains awareness of what she generated/shared across messages.
 */
function summarizeToolDeliverables(toolResults) {
  const lines = [];
  for (const result of toolResults) {
    try {
      const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      const data = JSON.parse(content);
      if (data.error) continue;

      // Creative package
      if (data.presentationUrl) lines.push(`Presentation: ${data.presentationUrl}`);
      if (data.sheetUrl) lines.push(`Data sheet: ${data.sheetUrl}`);
      if (data.imageUrls?.length) lines.push(`Generated ${data.imageUrls.length} images`);
      if (data.textAdsCount) lines.push(`Generated ${data.textAdsCount} ad copy variations`);
      if (data.textAdPreview?.length) {
        lines.push(`Ad preview: ${data.textAdPreview.map(a => `"${a.headline}" [${a.cta}]`).join(' | ')}`);
      }
      if (data.videosCount) lines.push(`Generated ${data.videosCount} video(s)`);
      if (data.videoUrl) lines.push(`Video: ${data.videoUrl}`);

      // Standalone text ads
      if (data.ads?.length && !data.textAdsCount) {
        lines.push(`Generated ${data.ads.length} ad copy variations`);
        const preview = data.ads.slice(0, 3).map(a => `"${a.headline}" [${a.cta}]`).join(' | ');
        if (preview) lines.push(`Ad preview: ${preview}`);
      }

      // Standalone images
      if (data.images?.length && !data.imageUrls) {
        const ok = data.images.filter(i => !i.error);
        if (ok.length) lines.push(`Generated ${ok.length} images: ${ok.map(i => i.label || i.format).join(', ')}`);
      }

      // Keyword / SERP research
      if (data.keywords?.length) lines.push(`Found ${data.keywords.length} keywords`);
      if (data.results?.length) lines.push(`Returned ${data.results.length} results`);

      // Competitor research
      if (data.competitors?.length) lines.push(`Analyzed ${data.competitors.length} competitors`);

      // Campaign summary
      if (data.summary && typeof data.summary === 'string') lines.push(`Summary: ${data.summary.slice(0, 300)}`);
      if (data.message && typeof data.message === 'string' && !lines.length) lines.push(data.message.slice(0, 300));
    } catch (e) {
      // Skip unparseable results
    }
  }
  return lines.length ? lines.join('\n') : '';
}

/**
 * Try to link a second channel (e.g. Telegram) to an existing client
 * that was already onboarded via another channel (e.g. WhatsApp).
 * Returns the client context if linking succeeded, null otherwise.
 */
function tryLinkCrossChannel(token, chatId, channel) {
  const pending = getPendingClientByTokenAny(token);
  if (!pending || !pending.chat_id) return null;

  // Find the existing contact from the first channel
  const existingContact = getContactByPhone(pending.chat_id);
  if (!existingContact?.client_id) return null;

  // Create a new contact for this channel, linked to the same client
  try {
    createContact({
      phone: chatId,
      name: existingContact.name,
      email: existingContact.email,
      clientId: existingContact.client_id,
      channel,
    });
    log.info('Cross-channel link created', {
      clientId: existingContact.client_id,
      existingChatId: pending.chat_id,
      newChatId: chatId,
      channel,
    });
  } catch (e) {
    // Contact already exists — that's fine
    log.info('Cross-channel contact already exists', { chatId, channel });
  }

  return getClientContextByPhone(chatId);
}

/**
 * Look up a pending client by token, with Supabase fallback.
 * If not found locally and token is a UUID, queries Supabase and creates
 * a local pending_clients record from the submission data.
 */
async function getPendingClientWithFallback(token) {
  // 1. Try local DB first (fast, synchronous)
  const local = getPendingClientByToken(token);
  if (local) return local;

  // 2. If token looks like a UUID, try Supabase
  const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!UUID_RE.test(token)) return null;

  try {
    const submission = await supabase.getOnboardingSubmission(token);
    if (!submission) return null;

    // Create local pending_clients record from Supabase data
    createPendingClient(submission);
    log.info('Created local pending client from Supabase submission', { token });

    return getPendingClientByToken(token);
  } catch (error) {
    log.error('Supabase fallback failed', { token, error: error.message });
    return null;
  }
}

// Cache for Telegram bot username (fetched once at startup)
let telegramBotUsername = config.TELEGRAM_BOT_USERNAME || '';

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
- NEVER assume a tool is broken or credentials are unavailable based on past failures. ALWAYS call the tool again — credentials and configurations can change at any time. Never tell the user that "credentials are unavailable" without actually calling the tool first to verify.
- When asked to create presentations, charts, graphs, reports, or any Google Slides/Sheets/Drive/Docs content, you MUST call the appropriate tool (build_media_plan_deck, build_competitor_deck, build_performance_deck, create_chart_presentation, create_single_chart, generate_performance_pdf, generate_competitor_pdf). NEVER substitute with text-based tables, ASCII art, or emoji-based charts. The tools create REAL Google Slides with interactive charts.
- If a Google tool fails, use check_credentials to diagnose the issue and report the specific error — do not give up or offer text alternatives.

CREATIVE GENERATION PROCESS — FOLLOW THIS STRICTLY:
When the user asks you to create ads, visuals, creatives, or mockups, DO NOT generate immediately. Instead, follow this process:

1. *Gather the Creative Brief* — Before generating anything, ask the user these questions (adapt naturally, don't list them robotically — ask the most relevant 3-5 based on context):
   - What's the campaign objective? (brand awareness, leads, conversions, traffic?)
   - Who is the target audience? (demographics, interests, pain points)
   - What's the offer or value proposition? (discount, free trial, unique benefit?)
   - Any visual references or inspiration? (competitor ads they like, mood boards, websites they admire, style preferences)
   - Brand guidelines? (colors, fonts, tone — or suggest they send a brand guide via file upload)
   - What platforms? (Meta, Google, TikTok, Instagram?)
   - What creative style? (photorealistic product shot, lifestyle photography, flat/minimal design, bold/vibrant graphic, editorial, cinematic?)
   - Any competitors to reference or differentiate from?
   - Specific products/services to feature?
   - What emotion should the ad evoke? (urgency, trust, excitement, aspiration, exclusivity?)

2. *Research First* — Before generating, use your tools:
   - Browse the client's website (browse_website) to understand brand, colors, visual style, messaging
   - Search competitor ads (search_ad_library) to see what's working in the space
   - Check brand files if they have a Drive folder (list_client_files)

3. *Generate with Full Context* — Only after gathering info, generate creatives. Pass ALL context (brand colors, audience, references, style, mood, competitive landscape) to the generation tools. The more detail you provide in the prompt, the better the result.

4. *Present & Iterate* — Show results and ask: "What do you think? Want me to adjust the style, colors, mood, or try a completely different angle?"

EXCEPTION: If the user gives ALL context upfront (audience, offer, style, platform), skip questions and generate.
EXCEPTION: If the user says "just do it" or "surprise me", generate with available context but mention your assumptions.

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
  // --- Search Volume & Keyword Research ---
  {
    name: 'get_search_volume',
    description: 'Get search volume, CPC, and competition data for specific keywords. Uses DataForSEO for accurate data. Great for keyword research and campaign planning.',
    input_schema: { type: 'object', properties: { keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to look up (max 100)' }, location: { type: 'string', description: 'Location (default: "United States")' }, language: { type: 'string', description: 'Language (default: "English")' } }, required: ['keywords'] },
  },
  {
    name: 'get_keyword_ideas',
    description: 'Get keyword suggestions and related terms based on a seed keyword. Returns ideas with search volume, competition, and CPC. Perfect for expanding keyword lists.',
    input_schema: { type: 'object', properties: { keyword: { type: 'string', description: 'Seed keyword to get ideas for' }, location: { type: 'string', description: 'Location (default: "United States")' }, limit: { type: 'number', description: 'Max results (default: 20)' } }, required: ['keyword'] },
  },
  // --- SERP & Competitor Intelligence ---
  {
    name: 'analyze_serp',
    description: 'Analyze the Google search results page (SERP) for a keyword. Shows who ranks organically and in paid positions, plus featured snippets. Great for understanding competitive landscape.',
    input_schema: { type: 'object', properties: { keyword: { type: 'string', description: 'Keyword to search' }, location: { type: 'string', description: 'Location (default: "United States")' } }, required: ['keyword'] },
  },
  {
    name: 'find_seo_competitors',
    description: 'Find the top SEO competitors for a domain — who competes for similar keywords in organic search.',
    input_schema: { type: 'object', properties: { domain: { type: 'string', description: 'Domain to analyze (e.g. "example.com")' }, location: { type: 'string', description: 'Location (default: "United States")' }, limit: { type: 'number', description: 'Max results (default: 10)' } }, required: ['domain'] },
  },
  {
    name: 'get_keyword_gap',
    description: 'Find keywords that a competitor ranks for but you do not. Reveals opportunities to target. Essential for competitive strategy.',
    input_schema: { type: 'object', properties: { yourDomain: { type: 'string', description: 'Your domain (e.g. "yourbrand.com")' }, competitorDomain: { type: 'string', description: 'Competitor domain (e.g. "competitor.com")' }, location: { type: 'string', description: 'Location (default: "United States")' }, limit: { type: 'number', description: 'Max results (default: 20)' } }, required: ['yourDomain', 'competitorDomain'] },
  },
  {
    name: 'get_domain_overview',
    description: 'Get an SEO overview of a domain — organic traffic estimate, number of ranking keywords, paid traffic, and backlinks.',
    input_schema: { type: 'object', properties: { domain: { type: 'string', description: 'Domain to analyze' }, location: { type: 'string', description: 'Location (default: "United States")' } }, required: ['domain'] },
  },
  // --- Audits ---
  {
    name: 'audit_landing_page',
    description: 'Run a full landing page audit using Google PageSpeed Insights. Returns performance score, Core Web Vitals (LCP, CLS, TBT), SEO score, accessibility score, and top opportunities for improvement. Free and works on any URL.',
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'Full URL to audit (e.g. "https://example.com/landing")' }, strategy: { type: 'string', enum: ['mobile', 'desktop'], description: 'Device type (default: mobile)' } }, required: ['url'] },
  },
  {
    name: 'audit_seo_page',
    description: 'Run a detailed on-page SEO audit for a URL. Checks title, meta description, headings, word count, images, links, mobile-friendliness, HTTPS, and more. Uses DataForSEO.',
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'Full URL to audit' } }, required: ['url'] },
  },
  // --- Content Calendars ---
  {
    name: 'create_content_calendar',
    description: 'Create a content/post calendar as a Google Sheet. Sofia generates the calendar with dates, platforms, content types, copy, creative briefs, CTAs, and status tracking. Returns a shareable Google Sheets link.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, month: { type: 'string', description: 'Month to plan (e.g. "2026-03")' }, platforms: { type: 'string', description: 'Comma-separated platforms (e.g. "Instagram, Facebook, TikTok")' }, postsPerWeek: { type: 'number', description: 'Posts per week per platform (default: 3)' }, themes: { type: 'string', description: 'Content themes or campaign focus (optional)' } }, required: ['clientName', 'month'] },
  },
  // --- Report Export ---
  {
    name: 'export_report_to_sheet',
    description: 'Export a performance report to a formatted Google Sheet with data tables. Returns a shareable link.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, reportType: { type: 'string', enum: ['weekly', 'monthly', 'custom'], description: 'Report type' }, data: { type: 'string', description: 'Report data description or metrics to include' } }, required: ['clientName', 'reportType'] },
  },
  // --- Creative Generation ---
  {
    name: 'generate_text_ads',
    description: 'Generate platform-specific text ad variations (headlines, descriptions, body copy, CTAs) with proper character limits for each platform. Returns structured ad objects ready for launch.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, platform: { type: 'string', enum: ['meta', 'instagram', 'google', 'tiktok'], description: 'Ad platform' }, objective: { type: 'string', description: 'Campaign objective (e.g. conversions, awareness, leads)' }, audience: { type: 'string', description: 'Target audience description' }, offer: { type: 'string', description: 'Offer or promotion (optional)' }, concept: { type: 'string', description: 'Creative angle or theme (optional)' }, variations: { type: 'number', description: 'Number of variations (default: 5, max: 10)' } }, required: ['clientName', 'platform'] },
  },
  {
    name: 'generate_ad_images',
    description: 'Generate ad creative images using DALL-E 3 in platform-specific dimensions. IMPORTANT: For best results, provide as much context as possible — brand colors, target audience, creative style, references, mood, and any insights from browsing the client website or competitor ads. The more detail you provide, the better the output.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, platform: { type: 'string', enum: ['meta', 'instagram', 'google', 'tiktok'], description: 'Platform for proper sizing' }, concept: { type: 'string', description: 'Detailed creative concept — what the image should show, the scene, the mood, the story. Be very specific.' }, product: { type: 'string', description: 'Product or service being advertised' }, audience: { type: 'string', description: 'Target audience description (demographics, interests, pain points)' }, mood: { type: 'string', description: 'Mood/emotion to evoke (e.g. "premium and aspirational", "urgent and energetic", "calm and trustworthy")' }, style: { type: 'string', description: 'Creative style: photorealistic, lifestyle photography, minimalist, editorial, flat design, cinematic, product shot, etc.' }, brandColors: { type: 'string', description: 'Brand color palette (e.g. "#1a2b3c navy blue, #ff6b35 coral orange, white")' }, references: { type: 'string', description: 'Visual references or inspiration (e.g. "Like Apple product ads — clean, minimal, lots of white space")' }, websiteInsights: { type: 'string', description: 'Key insights from browsing the client website (brand feel, visual style, messaging tone)' }, competitorInsights: { type: 'string', description: 'Insights from competitor ad research (what competitors are doing, gaps to exploit)' }, formats: { type: 'string', description: 'Comma-separated format keys: meta_feed, meta_square, meta_story, instagram_feed, instagram_story, google_display, tiktok (optional, uses platform defaults)' } }, required: ['clientName', 'platform', 'concept'] },
  },
  {
    name: 'generate_ad_video',
    description: 'Generate a short ad video using Sora 2 AI. Creates a professional advertising video clip (4-12 seconds) in the right aspect ratio for the platform.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, concept: { type: 'string', description: 'Video concept — what should happen in the video' }, platform: { type: 'string', enum: ['meta_feed', 'meta_story', 'instagram_feed', 'instagram_story', 'tiktok', 'youtube', 'google_display'], description: 'Platform/format for aspect ratio' }, duration: { type: 'number', description: 'Duration in seconds (4, 8, or 12)' }, offer: { type: 'string', description: 'Product/offer to feature (optional)' } }, required: ['clientName', 'concept'] },
  },
  {
    name: 'generate_creative_package',
    description: 'Generate a FULL creative package: text ads + ad images + optional video, all assembled into a Google Slides presentation deck for client approval. IMPORTANT: Gather a complete creative brief before calling this tool — the more context you provide (audience, offer, style, mood, brand colors, competitor insights, website insights), the better the output.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, platform: { type: 'string', enum: ['meta', 'instagram', 'google', 'tiktok'], description: 'Primary platform' }, campaignName: { type: 'string', description: 'Campaign name for the deck' }, objective: { type: 'string', description: 'Campaign objective (awareness, leads, conversions, traffic)' }, audience: { type: 'string', description: 'Detailed target audience (demographics, interests, pain points)' }, offer: { type: 'string', description: 'Offer/promotion/value proposition' }, concept: { type: 'string', description: 'Detailed creative concept — visual direction, mood, style, what the ads should convey' }, style: { type: 'string', description: 'Creative style: photorealistic, lifestyle, minimalist, editorial, cinematic, bold/vibrant' }, mood: { type: 'string', description: 'Emotion to evoke: urgency, trust, excitement, aspiration, exclusivity' }, brandColors: { type: 'string', description: 'Brand color palette' }, references: { type: 'string', description: 'Visual references or inspiration' }, websiteInsights: { type: 'string', description: 'Key insights from browsing client website' }, competitorInsights: { type: 'string', description: 'Insights from competitor ad research' }, textVariations: { type: 'number', description: 'Number of text ad variations (default: 5)' }, generateImages: { type: 'boolean', description: 'Generate images with DALL-E 3 (default: true)' }, generateVideo: { type: 'boolean', description: 'Generate video with Sora 2 (default: false)' } }, required: ['clientName', 'platform'] },
  },
  // --- Web Browsing ---
  {
    name: 'browse_website',
    description: 'Visit a website and extract its content, headings, images, brand colors, and metadata. Perfect for researching competitor websites, getting creative inspiration, analyzing landing pages, or understanding a brand before creating ads. Works on any public URL.',
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'URL to visit (e.g. "https://example.com" or "example.com")' }, purpose: { type: 'string', description: 'Why you\'re visiting: "creative_inspiration", "competitor_research", "brand_analysis", or "general"' } }, required: ['url'] },
  },
  // --- SEO & Content Management ---
  {
    name: 'full_seo_audit',
    description: 'Run a comprehensive SEO audit on a client\'s website. Combines PageSpeed performance, on-page SEO (meta tags, headings, images), domain overview (traffic, keywords, backlinks), and WordPress SEO analysis (if CMS connected via Leadsie). Returns prioritized recommendations.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name to audit' } }, required: ['clientName'] },
  },
  {
    name: 'generate_blog_post',
    description: 'Generate a full SEO-optimized blog post and optionally publish/schedule it on the client\'s WordPress site. Includes title, HTML content, meta tags, excerpt, and featured image prompt. If WordPress is connected, it can publish as draft or schedule for a future date.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string', description: 'Client name' },
      topic: { type: 'string', description: 'Blog post topic or title idea' },
      keywords: { type: 'string', description: 'Comma-separated target keywords' },
      tone: { type: 'string', description: 'Writing tone: professional, casual, educational, persuasive (default: professional)' },
      wordCount: { type: 'number', description: 'Target word count (default: 1200)' },
      action: { type: 'string', enum: ['generate_only', 'save_draft', 'schedule'], description: 'What to do: generate_only (just return content), save_draft (create WP draft), schedule (schedule for future publish)' },
      publishDate: { type: 'string', description: 'ISO 8601 date for scheduled publishing (only if action=schedule)' },
    }, required: ['clientName', 'topic'] },
  },
  {
    name: 'fix_meta_tags',
    description: 'Generate optimized SEO meta tags (title + description) for a specific page and optionally push the update to WordPress. If no page specified, audits ALL pages and fixes the worst ones.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string', description: 'Client name' },
      url: { type: 'string', description: 'Specific page URL to fix (optional — omit to audit all pages)' },
      pageId: { type: 'number', description: 'WordPress page/post ID (if known)' },
      pageType: { type: 'string', enum: ['posts', 'pages'], description: 'WordPress content type (default: posts)' },
      focusKeyword: { type: 'string', description: 'Target keyword for this page' },
      applyChanges: { type: 'boolean', description: 'If true, push meta tag updates to WordPress (default: false — preview only)' },
    }, required: ['clientName'] },
  },
  {
    name: 'plan_content_calendar',
    description: 'Create an SEO-driven content calendar with blog post topics, keywords, content types, and publish dates. Based on keyword gaps, competitor analysis, and industry trends. Returns a structured calendar that can be saved to Google Sheets.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string', description: 'Client name' },
      keywords: { type: 'string', description: 'Comma-separated seed keywords (optional — will research if not provided)' },
      monthsAhead: { type: 'number', description: 'How many months to plan (default: 3)' },
      postsPerWeek: { type: 'number', description: 'Posts per week (default: 1)' },
    }, required: ['clientName'] },
  },
  {
    name: 'list_wp_content',
    description: 'List all posts and pages on a client\'s WordPress site. Shows title, status, date, and SEO meta info. Requires WordPress CMS access via Leadsie.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string', description: 'Client name' },
      contentType: { type: 'string', enum: ['posts', 'pages', 'all'], description: 'What to list (default: all)' },
      status: { type: 'string', enum: ['publish', 'draft', 'future', 'any'], description: 'Filter by status (default: publish)' },
    }, required: ['clientName'] },
  },
  {
    name: 'update_wp_post',
    description: 'Update an existing WordPress post or page — content, title, status, or SEO meta. Requires WordPress CMS access via Leadsie.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string', description: 'Client name' },
      postId: { type: 'number', description: 'WordPress post/page ID to update' },
      title: { type: 'string', description: 'New title (optional)' },
      content: { type: 'string', description: 'New HTML content (optional)' },
      status: { type: 'string', enum: ['publish', 'draft', 'future'], description: 'New status (optional)' },
      seoTitle: { type: 'string', description: 'New SEO title (optional)' },
      seoDescription: { type: 'string', description: 'New meta description (optional)' },
      focusKeyword: { type: 'string', description: 'New focus keyword (optional)' },
    }, required: ['clientName', 'postId'] },
  },
  {
    name: 'generate_schema_markup',
    description: 'Generate JSON-LD schema markup (structured data) for a page. Supports LocalBusiness, Article, Product, Service, FAQ, HowTo types. Helps pages appear as rich results in Google.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string', description: 'Client name' },
      pageType: { type: 'string', description: 'Schema type: LocalBusiness, Article, Product, Service, FAQ, HowTo' },
      url: { type: 'string', description: 'Page URL' },
    }, required: ['clientName', 'pageType', 'url'] },
  },
  // --- Client Onboarding (Leadsie) ---
  {
    name: 'create_onboarding_link',
    description: 'Create a Leadsie invite link to send to a new client so they can grant access to their ad accounts (Meta, Google Ads, TikTok), CMS (WordPress, Shopify), DNS (GoDaddy), and CRM (HubSpot) in one click. Sofia will send the link directly via chat.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client business name' }, clientEmail: { type: 'string', description: 'Client email (optional)' }, platforms: { type: 'string', description: 'Comma-separated platforms: facebook, google, tiktok, wordpress, shopify, godaddy, hubspot (default: facebook,google,wordpress,hubspot)' } }, required: ['clientName'] },
  },
  {
    name: 'check_onboarding_status',
    description: 'Check whether a client has completed their Leadsie onboarding (granted ad account access).',
    input_schema: { type: 'object', properties: { inviteId: { type: 'string', description: 'Leadsie invite ID to check' } }, required: ['inviteId'] },
  },
  {
    name: 'start_client_onboarding',
    description: 'Start the conversational onboarding flow for a new client. Sofia will send them a welcome message on WhatsApp and guide them through questions (name, business, website, audience, competitors, channels, etc.). The client answers at their own pace and Sofia remembers where they left off. Once complete, Sofia auto-creates their Drive folder, Leadsie link, and intake document.',
    input_schema: { type: 'object', properties: { clientPhone: { type: 'string', description: 'Client WhatsApp phone number (with country code, e.g. "5511999999999")' } }, required: ['clientPhone'] },
  },
  // --- Drive File Management ---
  {
    name: 'setup_client_drive',
    description: 'Create the full Google Drive folder structure for a new client (Brand Assets, Reports, Creatives, Strategic Plans, Audits, Competitor Research). Returns folder IDs for configuration.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' } }, required: ['clientName'] },
  },
  {
    name: 'list_client_files',
    description: 'List files in a client\'s Google Drive folder. Shows brand assets, reports, creatives, and other uploaded files.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, folder: { type: 'string', enum: ['all', 'brand_assets', 'reports', 'creatives', 'strategic_plans', 'audits', 'competitor_research'], description: 'Which folder to list (default: all)' } }, required: ['clientName'] },
  },
  // --- Google Analytics ---
  {
    name: 'get_analytics_metrics',
    description: 'Get Google Analytics (GA4) website metrics: sessions, users, page views, bounce rate, engagement rate, conversions. Use this to understand website traffic and behavior for a client.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name (must have GA4 property configured)' }, startDate: { type: 'string', description: 'Start date (YYYY-MM-DD or "7daysAgo", "30daysAgo")' }, endDate: { type: 'string', description: 'End date (YYYY-MM-DD or "today")' } }, required: ['clientName'] },
  },
  {
    name: 'get_analytics_top_pages',
    description: 'Get the top performing pages from Google Analytics (GA4) by page views. Shows path, title, views, duration, bounce rate, and conversions.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, startDate: { type: 'string' }, endDate: { type: 'string' }, limit: { type: 'number', description: 'Max results (default: 20)' } }, required: ['clientName'] },
  },
  {
    name: 'get_analytics_traffic_sources',
    description: 'Get traffic source breakdown from Google Analytics (GA4). Shows which channels (organic, paid, direct, social, etc.) drive the most sessions and conversions.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, startDate: { type: 'string' }, endDate: { type: 'string' } }, required: ['clientName'] },
  },
  {
    name: 'get_analytics_audience',
    description: 'Get audience demographics from Google Analytics (GA4): device breakdown, top countries, and gender distribution.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, startDate: { type: 'string' }, endDate: { type: 'string' } }, required: ['clientName'] },
  },
  {
    name: 'get_analytics_daily_trend',
    description: 'Get daily metrics trend from Google Analytics (GA4). Returns sessions, users, conversions, and page views per day. Great for spotting trends and building projections.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, startDate: { type: 'string' }, endDate: { type: 'string' } }, required: ['clientName'] },
  },
  // --- Google Ads Transparency Center ---
  {
    name: 'search_google_ads_transparency',
    description: 'Search the Google Ads Transparency Center for an advertiser. Shows what Google Ads a company is running, including ad formats, date ranges, and preview links. Great for researching competitor Google Ads activity.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Advertiser name or domain to search' }, region: { type: 'string', description: 'Region filter (default: "anywhere")' }, limit: { type: 'number', description: 'Max results (default: 10)' } }, required: ['query'] },
  },
  // --- Google Keyword Planner (via Google Ads API) ---
  {
    name: 'get_keyword_planner_ideas',
    description: 'Get keyword ideas from Google Keyword Planner (via Google Ads API). Returns search volume, competition, and estimated CPC. Use seed keywords OR a URL to generate ideas. More authoritative than DataForSEO for Google Ads planning.',
    input_schema: { type: 'object', properties: { keywords: { type: 'array', items: { type: 'string' }, description: 'Seed keywords to get ideas for' }, url: { type: 'string', description: 'URL to extract keyword ideas from (alternative to keywords)' }, limit: { type: 'number', description: 'Max results (default: 20)' } }, required: [] },
  },
  {
    name: 'get_keyword_planner_volume',
    description: 'Get historical search volume data from Google Keyword Planner for specific keywords. Returns monthly trends, competition index, and bid estimates. Best for Google Ads campaign planning.',
    input_schema: { type: 'object', properties: { keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to get volume for' } }, required: ['keywords'] },
  },
  // --- Presentation Builders ---
  {
    name: 'build_media_plan_deck',
    description: 'Build a professional Google Slides media plan presentation with REAL CHARTS (pie charts for budget allocation, bar charts for projections). Includes executive summary, objectives, target audiences, channel strategy, budget allocation chart, projections chart, creative mockups, and timeline. Returns a shareable link.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string' }, campaignName: { type: 'string' }, mediaPlan: { type: 'object', description: 'Media plan data: { summary, objective, budget, timeline, kpis[], audiences[], channels[{platform, budget, projectedClicks, projectedConversions}], budgetBreakdown[{channel, amount, percentage, objective}], projections: {impressions, clicks, conversions, cpa, roas, reach, notes}, nextSteps }' }, creatives: { type: 'array', description: 'Creative mockup refs: [{ label, url, concept }]' }, charts: { type: 'array', description: 'Additional custom charts: [{ title, chartType, labels[], series[{name, values[]}] }]' } }, required: ['clientName', 'mediaPlan'] },
  },
  {
    name: 'build_competitor_deck',
    description: 'Build a professional Google Slides competitor research presentation with REAL CHARTS (bar charts for traffic comparison, keyword counts). Includes competitor landscape, domain overview, keyword gap analysis, SERP analysis, and competitor ad examples. Returns a shareable link.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string' }, competitors: { type: 'array', description: 'Competitor data: [{ name, domain, traffic, keywords, avgPosition, strengths, weaknesses }]' }, keywordGap: { type: 'array', description: 'Keyword gap data: [{ keyword, volume, competition, competitorPosition, yourPosition }]' }, competitorAds: { type: 'array', description: 'Competitor ads: [{ pageName, headline, body, cta, platforms }]' }, serpAnalysis: { type: 'object', description: '{ keyword, organicResults, paidResults }' }, domainOverview: { type: 'object', description: '{ organicTraffic, paidTraffic, organicKeywords, backlinks }' }, summary: { type: 'string' }, recommendations: { type: 'string' }, charts: { type: 'array', description: 'Additional custom charts: [{ title, chartType, labels[], series[{name, values[]}] }]' } }, required: ['clientName'] },
  },
  {
    name: 'build_performance_deck',
    description: 'Build a professional Google Slides performance report presentation with REAL CHARTS (spend pie chart, traffic sources pie, daily trend line, device breakdown pie). Includes KPI metrics, campaign breakdown, website analytics, traffic sources, top pages, keyword performance, audience insights, and recommendations. Returns a shareable link.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string' }, reportType: { type: 'string', enum: ['weekly', 'monthly'] }, dateRange: { type: 'string', description: 'Date range label (e.g. "Feb 1-7, 2026")' }, metrics: { type: 'object', description: 'Ad metrics: { spend, impressions, clicks, conversions, ctr, cpa, roas, cpc }' }, analytics: { type: 'object', description: 'GA4 data: { sessions, totalUsers, pageViews, bounceRate, engagementRate, conversions, trafficSources[], topPages[] }' }, campaigns: { type: 'array', description: 'Campaign data: [{ name, spend, clicks, conversions, cpa, roas }]' }, topKeywords: { type: 'array', description: '[{ keyword, impressions, clicks, ctr, conversions, cpa }]' }, audienceData: { type: 'object', description: '{ devices[], countries[], gender[] }' }, dailyTrend: { type: 'array', description: 'Daily data: [{ date, sessions, conversions }] — for line chart' }, analysis: { type: 'string' }, recommendations: { type: 'string' }, charts: { type: 'array', description: 'Additional custom charts: [{ title, chartType, labels[], series[{name, values[]}] }]' } }, required: ['clientName'] },
  },
  // --- PDF Reports ---
  {
    name: 'generate_performance_pdf',
    description: 'Generate a performance report as a Google Doc with PDF download link. Includes all metrics, campaign data, analytics, keywords, and AI analysis. Returns both editable Doc URL and PDF download link.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string' }, reportType: { type: 'string', enum: ['weekly', 'monthly'] }, dateRange: { type: 'string' }, metrics: { type: 'object', description: 'Ad metrics: { spend, impressions, clicks, conversions, ctr, cpa, roas }' }, analytics: { type: 'object', description: 'GA4 data' }, campaigns: { type: 'array' }, topKeywords: { type: 'array' }, audienceData: { type: 'object' }, analysis: { type: 'string' }, recommendations: { type: 'string' } }, required: ['clientName'] },
  },
  {
    name: 'generate_competitor_pdf',
    description: 'Generate a competitor analysis report as a Google Doc with PDF download link. Includes competitor landscape, keyword gap, ad analysis, and strategic recommendations.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string' }, competitors: { type: 'array' }, keywordGap: { type: 'array' }, competitorAds: { type: 'array' }, summary: { type: 'string' }, recommendations: { type: 'string' } }, required: ['clientName'] },
  },
  // --- Charts ---
  {
    name: 'create_chart_presentation',
    description: 'Create a Google Slides presentation with one or more data charts (pie, bar, column, line, area, stacked). Each chart is a real embedded Google Sheets chart — not text, not an image, but an actual interactive chart. Use this whenever the user wants to visualize data like budget allocation, performance projections, competitor comparisons, traffic sources, trends, etc.',
    input_schema: { type: 'object', properties: {
      clientName: { type: 'string', description: 'Client name' },
      title: { type: 'string', description: 'Presentation title (e.g. "Budget & Performance Projections")' },
      charts: { type: 'array', description: 'Array of chart configs. Each: { title: "Chart Title", chartType: "pie|bar|column|line|area|stacked_bar|stacked_column", labels: ["Label1", "Label2", ...], series: [{ name: "Series Name", values: [100, 200, ...] }] }', items: { type: 'object', properties: {
        title: { type: 'string' },
        chartType: { type: 'string', enum: ['pie', 'bar', 'column', 'line', 'area', 'stacked_bar', 'stacked_column'] },
        labels: { type: 'array', items: { type: 'string' } },
        series: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }, required: ['name', 'values'] } },
      }, required: ['title', 'chartType', 'labels', 'series'] } },
    }, required: ['clientName', 'charts'] },
  },
  {
    name: 'create_single_chart',
    description: 'Create a single chart in Google Sheets and return a link. Use this for quick one-off charts without a full presentation. Returns a Google Sheets link where the chart can be viewed and downloaded.',
    input_schema: { type: 'object', properties: {
      title: { type: 'string', description: 'Chart title' },
      chartType: { type: 'string', enum: ['pie', 'bar', 'column', 'line', 'area', 'stacked_bar', 'stacked_column'], description: 'Chart type' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Category labels' },
      series: { type: 'array', description: 'Data series: [{ name: "Name", values: [1,2,3] }]', items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }, required: ['name', 'values'] } },
    }, required: ['title', 'chartType', 'labels', 'series'] },
  },
  // --- Diagnostics ---
  {
    name: 'check_credentials',
    description: 'Check which API credentials are configured and working. Use this FIRST when any Google operation fails to diagnose the exact problem and give the user step-by-step instructions to fix it.',
    input_schema: { type: 'object', properties: {} },
  },
];

/**
 * Unified tool executor for both WhatsApp and Telegram CSA agents.
 */
async function executeCSATool(toolName, toolInput) {
  try {
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
    // --- Search Volume & Keyword Research ---
    case 'get_search_volume': {
      try {
        const results = await dataforseo.getKeywordData({
          keywords: toolInput.keywords.slice(0, 100),
          location: toolInput.location,
          language: toolInput.language,
        });
        return { keywords: results, source: 'DataForSEO' };
      } catch (e) {
        // Fallback to Google Keyword Planner if DataForSEO fails
        if (config.GOOGLE_ADS_MANAGER_ACCOUNT_ID) {
          try {
            const results = await keywordPlanner.getSearchVolume({ keywords: toolInput.keywords.slice(0, 20) });
            return { keywords: results, source: 'Google Keyword Planner' };
          } catch (e2) {
            return { error: `Both DataForSEO and Google Keyword Planner failed. DataForSEO: ${e.message}. Google: ${e2.message}` };
          }
        }
        return { error: e.message };
      }
    }
    case 'get_keyword_ideas': {
      try {
        const results = await dataforseo.getKeywordSuggestions({
          keyword: toolInput.keyword,
          location: toolInput.location,
          limit: toolInput.limit || 20,
        });
        return { seedKeyword: toolInput.keyword, ideas: results, source: 'DataForSEO' };
      } catch (e) {
        if (config.GOOGLE_ADS_MANAGER_ACCOUNT_ID) {
          try {
            const results = await keywordPlanner.getKeywordIdeas({ keywords: [toolInput.keyword], limit: toolInput.limit || 20 });
            return { seedKeyword: toolInput.keyword, ideas: results, source: 'Google Keyword Planner' };
          } catch (e2) {
            return { error: `Both DataForSEO and Google Keyword Planner failed. DataForSEO: ${e.message}. Google: ${e2.message}` };
          }
        }
        return { error: e.message };
      }
    }
    // --- SERP & Competitor Intelligence ---
    case 'analyze_serp': {
      const results = await dataforseo.getSerpResults({
        keyword: toolInput.keyword,
        location: toolInput.location,
      });
      return results;
    }
    case 'find_seo_competitors': {
      const results = await dataforseo.getCompetitors({
        domain: toolInput.domain,
        location: toolInput.location,
        limit: toolInput.limit || 10,
      });
      return { domain: toolInput.domain, competitors: results };
    }
    case 'get_keyword_gap': {
      const results = await dataforseo.getKeywordGap({
        yourDomain: toolInput.yourDomain,
        competitorDomain: toolInput.competitorDomain,
        location: toolInput.location,
        limit: toolInput.limit || 20,
      });
      return { yourDomain: toolInput.yourDomain, competitorDomain: toolInput.competitorDomain, gaps: results };
    }
    case 'get_domain_overview': {
      const results = await dataforseo.getDomainOverview({
        domain: toolInput.domain,
        location: toolInput.location,
      });
      return results;
    }
    // --- Audits ---
    case 'audit_landing_page': {
      const results = await pagespeed.runPageSpeedAudit(toolInput.url, {
        strategy: toolInput.strategy || 'mobile',
      });
      return results;
    }
    case 'audit_seo_page': {
      const results = await dataforseo.onPageAudit({ url: toolInput.url });
      return results;
    }
    // --- Content Calendars ---
    case 'create_content_calendar': {
      const client = getClient(toolInput.clientName);
      const folderId = client?.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;

      // Generate calendar content using AI
      const platforms = (toolInput.platforms || 'Instagram, Facebook').split(',').map(p => p.trim());
      const postsPerWeek = toolInput.postsPerWeek || 3;
      const month = toolInput.month;

      const calendarPrompt = `Generate a content calendar for ${toolInput.clientName} for ${month}.
Platforms: ${platforms.join(', ')}
Posts per week per platform: ${postsPerWeek}
${toolInput.themes ? `Themes/Focus: ${toolInput.themes}` : ''}
${client ? `Industry: ${client.industry || 'N/A'}\nBrand voice: ${client.brand_voice || 'Professional'}` : ''}

Return a JSON array of post objects with these fields:
- date (YYYY-MM-DD format, spread across the month)
- platform (one of the specified platforms)
- type (Story, Reel, Carousel, Static Post, Video, Live, etc.)
- copy (the actual caption/copy — 2-3 sentences)
- creative (brief description of the visual/creative)
- cta (call to action)
- hashtags (relevant hashtags, 5-8 per post)

Return ONLY the JSON array, no other text.`;

      const { askClaude: generateCalendar } = await import('../api/anthropic.js');
      const aiResponse = await generateCalendar({
        systemPrompt: 'You are a social media content strategist. Generate practical, engaging content calendars. Return only valid JSON arrays.',
        userMessage: calendarPrompt,
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 8192,
        workflow: 'content-calendar',
        clientId: client?.id,
      });

      let posts = [];
      try {
        const jsonMatch = aiResponse.text.match(/\[[\s\S]*\]/);
        if (jsonMatch) posts = JSON.parse(jsonMatch[0]);
      } catch (e) {
        return { error: 'Failed to generate calendar content. Please try again.' };
      }

      const result = await googleSheets.createContentCalendar({
        clientName: toolInput.clientName,
        month,
        posts,
        folderId,
      });

      if (!result) return { error: 'Google Sheets not configured. Set GOOGLE_APPLICATION_CREDENTIALS in .env' };
      return { clientName: toolInput.clientName, month, totalPosts: posts.length, platforms, spreadsheetUrl: result.url, spreadsheetId: result.spreadsheetId };
    }
    // --- Report Export ---
    case 'export_report_to_sheet': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found.` };
      const folderId = client.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;

      // Gather performance data
      const reportData = [];
      const headers = ['Metric', 'Value', 'Target', 'Status'];
      reportData.push(headers);

      if (client.meta_ad_account_id) {
        try {
          const insights = await metaAds.getAccountInsights(client.meta_ad_account_id, { datePreset: toolInput.reportType === 'monthly' ? 'last_30d' : 'last_7d' });
          const metrics = metaAds.extractConversions(insights);
          reportData.push(['Platform', 'Meta Ads', '', '']);
          reportData.push(['Spend', `$${metrics.spend || 0}`, `$${(client.monthly_budget_cents || 0) / 100}`, '']);
          reportData.push(['ROAS', `${metrics.roas || 0}x`, `${client.target_roas || 'N/A'}x`, '']);
          reportData.push(['CPA', `$${metrics.cpa || 0}`, `$${(client.target_cpa_cents || 0) / 100}`, '']);
          reportData.push(['Conversions', metrics.conversions || 0, '', '']);
          reportData.push(['CTR', `${metrics.ctr || 0}%`, '', '']);
          reportData.push(['Impressions', metrics.impressions || 0, '', '']);
          reportData.push(['', '', '', '']);
        } catch (e) { reportData.push(['Meta Ads', `Error: ${e.message}`, '', '']); }
      }

      if (client.google_ads_customer_id) {
        try {
          const perf = await googleAds.getAccountPerformance(client.google_ads_customer_id);
          if (perf.length > 0) {
            const metrics = googleAds.formatGoogleAdsMetrics(perf[0]);
            reportData.push(['Platform', 'Google Ads', '', '']);
            reportData.push(['Spend', `$${metrics.cost}`, '', '']);
            reportData.push(['ROAS', `${metrics.roas.toFixed(2)}x`, `${client.target_roas || 'N/A'}x`, '']);
            reportData.push(['CPA', `$${metrics.cpa.toFixed(2)}`, `$${(client.target_cpa_cents || 0) / 100}`, '']);
            reportData.push(['Conversions', metrics.conversions, '', '']);
            reportData.push(['CTR', `${metrics.ctr.toFixed(2)}%`, '', '']);
            reportData.push(['Impressions', metrics.impressions, '', '']);
          }
        } catch (e) { reportData.push(['Google Ads', `Error: ${e.message}`, '', '']); }
      }

      const result = await googleSheets.createReportSheet({
        clientName: toolInput.clientName,
        reportType: toolInput.reportType,
        data: reportData,
        folderId,
      });

      if (!result) return { error: 'Google Sheets not configured. Set GOOGLE_APPLICATION_CREDENTIALS in .env' };
      return { clientName: toolInput.clientName, reportType: toolInput.reportType, spreadsheetUrl: result.url, spreadsheetId: result.spreadsheetId };
    }
    // --- Creative Generation ---
    case 'generate_text_ads': {
      const ads = await creativeEngine.generateTextAds({
        clientName: toolInput.clientName,
        platform: toolInput.platform,
        objective: toolInput.objective,
        audience: toolInput.audience,
        offer: toolInput.offer,
        angle: toolInput.concept,
        variations: Math.min(toolInput.variations || 5, 10),
      });

      // Save companion Sheet to Drive
      let sheetUrl = null;
      try {
        const client = getClient(toolInput.clientName);
        const folderId = client?.drive_creatives_folder_id || client?.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
        const sheet = await campaignRecord.createTextAdsRecord({
          clientName: toolInput.clientName,
          platform: toolInput.platform,
          ads,
          folderId,
        });
        sheetUrl = sheet?.url || null;
      } catch (e) {
        log.error('Failed to create text ads record sheet', { error: e.message });
      }

      return { clientName: toolInput.clientName, platform: toolInput.platform, ads, totalVariations: ads.length, sheetUrl };
    }
    case 'generate_ad_images': {
      if (!config.OPENAI_API_KEY) return { error: 'OPENAI_API_KEY not configured. Set it in .env to enable image generation.' };
      const client = getClient(toolInput.clientName);

      // Generate the image prompt using AI with full context
      const imagePrompt = await creativeEngine.generateImagePrompt({
        clientName: toolInput.clientName,
        platform: toolInput.platform,
        product: toolInput.product,
        concept: toolInput.concept,
        audience: toolInput.audience || client?.target_audience,
        mood: toolInput.mood,
        style: toolInput.style,
        brandColors: toolInput.brandColors || client?.brand_colors,
        references: toolInput.references,
        websiteInsights: toolInput.websiteInsights,
        competitorInsights: toolInput.competitorInsights,
      });

      // Parse custom formats if provided
      const formats = toolInput.formats ? toolInput.formats.split(',').map(f => f.trim()) : undefined;

      const images = await openaiMedia.generateAdImages({
        prompt: imagePrompt,
        platform: toolInput.platform,
        formats,
        quality: 'hd',
        style: 'natural',
        workflow: 'ad-image-generation',
        clientId: client?.id,
      });

      const mappedImages = images.map(img => ({
        format: img.format,
        label: img.dimensions?.label || img.format,
        url: img.url,
        error: img.error,
      }));

      // Save companion Sheet to Drive
      let sheetUrl = null;
      try {
        const imgFolderId = client?.drive_creatives_folder_id || client?.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
        const sheet = await campaignRecord.createAdImagesRecord({
          clientName: toolInput.clientName,
          platform: toolInput.platform,
          concept: toolInput.concept,
          imagePrompt,
          images: mappedImages,
          folderId: imgFolderId,
        });
        sheetUrl = sheet?.url || null;
      } catch (e) {
        log.error('Failed to create ad images record sheet', { error: e.message });
      }

      return {
        clientName: toolInput.clientName,
        platform: toolInput.platform,
        concept: toolInput.concept,
        imagePrompt,
        images: mappedImages,
        totalGenerated: images.filter(i => !i.error).length,
        sheetUrl,
      };
    }
    case 'generate_ad_video': {
      if (!config.OPENAI_API_KEY) return { error: 'OPENAI_API_KEY not configured. Set it in .env to enable video generation.' };
      const client = getClient(toolInput.clientName);

      const videoPrompt = `Professional advertising video for ${toolInput.clientName}. ${toolInput.concept}. ${toolInput.offer ? `Featuring: ${toolInput.offer}.` : ''} High production quality, smooth camera movement, cinematic lighting. No text overlays.`;

      try {
        const video = await openaiMedia.generateAdVideo({
          prompt: videoPrompt,
          format: toolInput.platform || 'meta_feed',
          duration: toolInput.duration || 8,
          workflow: 'ad-video-generation',
          clientId: client?.id,
        });

        return {
          clientName: toolInput.clientName,
          concept: toolInput.concept,
          videoUrl: video.videoUrl,
          duration: video.duration,
          resolution: video.resolution,
          aspectRatio: video.aspectRatio,
          status: video.status,
        };
      } catch (videoError) {
        log.error('Video generation failed', { error: videoError.message, client: toolInput.clientName });
        return {
          error: `Video generation encountered an issue: ${videoError.message}. This can happen due to high demand or content restrictions. Try again with a simpler concept, or I can generate static images instead.`,
          suggestion: 'Try generate_ad_images as an alternative',
        };
      }
    }
    case 'generate_creative_package': {
      const pkg = await creativeEngine.generateCreativePackage({
        clientName: toolInput.clientName,
        platform: toolInput.platform,
        campaignName: toolInput.campaignName,
        objective: toolInput.objective,
        audience: toolInput.audience,
        offer: toolInput.offer,
        concept: toolInput.concept,
        style: toolInput.style,
        mood: toolInput.mood,
        brandColors: toolInput.brandColors,
        references: toolInput.references,
        websiteInsights: toolInput.websiteInsights,
        competitorInsights: toolInput.competitorInsights,
        textVariations: toolInput.textVariations,
        generateImages: toolInput.generateImages !== false,
        generateVideo: toolInput.generateVideo || false,
        buildDeck: true,
      });

      // Save companion Sheet to Drive
      let sheetUrl = null;
      try {
        const client = getClient(toolInput.clientName);
        const folderId = client?.drive_creatives_folder_id || client?.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
        const sheet = await campaignRecord.createCreativeRecord({
          clientName: pkg.clientName,
          platform: pkg.platform,
          campaignName: pkg.campaignName,
          textAds: pkg.textAds,
          images: pkg.images,
          videos: pkg.videos,
          summary: pkg.summary,
          presentationUrl: pkg.presentation?.url,
          folderId,
        });
        sheetUrl = sheet?.url || null;
      } catch (e) {
        log.error('Failed to create creative record sheet', { error: e.message });
      }

      return {
        clientName: pkg.clientName,
        platform: pkg.platform,
        campaignName: pkg.campaignName,
        summary: pkg.summary,
        textAdsCount: pkg.textAds.length,
        textAdPreview: pkg.textAds.slice(0, 3).map(a => ({ headline: a.headline, cta: a.cta, angle: a.angle })),
        imagesCount: pkg.images.filter(i => !i.error).length,
        imageUrls: pkg.images.filter(i => !i.error).map(i => i.url),
        videosCount: pkg.videos.filter(v => !v.error).length,
        presentationUrl: pkg.presentation?.url || null,
        sheetUrl,
        status: 'awaiting_approval',
        message: pkg.presentation?.url
          ? `Creative deck ready for review: ${pkg.presentation.url}` + (sheetUrl ? ` | Data sheet: ${sheetUrl}` : '')
          : 'Creative package generated (Google Slides not configured for deck)',
      };
    }
    // --- Website Browsing ---
    case 'browse_website': {
      const purpose = toolInput.purpose || 'general';
      if (purpose === 'creative_inspiration') {
        const analysis = await webScraper.analyzeForCreativeInspiration(toolInput.url);
        return {
          url: analysis.url,
          brandName: analysis.brand.name,
          tagline: analysis.brand.tagline,
          heroImage: analysis.brand.heroImage,
          brandColors: analysis.brand.colors,
          headline: analysis.messaging.headline,
          subheadings: analysis.messaging.subheadings?.slice(0, 5),
          keyPhrases: analysis.messaging.keyPhrases?.slice(0, 5),
          images: analysis.visuals.images?.slice(0, 5),
          contentPreview: analysis.content?.slice(0, 2000),
          wordCount: analysis.wordCount,
        };
      }
      const page = await webScraper.fetchWebpage(toolInput.url, {
        includeImages: true,
        includeLinks: purpose === 'competitor_research',
        maxLength: 6000,
      });
      return {
        url: page.url,
        statusCode: page.statusCode,
        title: page.title,
        description: page.description,
        headings: { h1: page.headings.h1, h2: page.headings.h2?.slice(0, 8) },
        bodyPreview: page.bodyText?.slice(0, 3000),
        images: page.images?.slice(0, 10),
        links: page.links?.slice(0, 15),
        brandColors: page.brandColors,
        wordCount: page.wordCount,
      };
    }

    // --- SEO & Content Management ---
    case 'full_seo_audit': {
      const audit = await seoEngine.fullSEOAudit(toolInput.clientName);
      const recs = await seoEngine.generateSEORecommendations(audit);
      return {
        audit: {
          url: audit.url,
          performance: audit.performance?.scores || audit.performance,
          coreWebVitals: audit.performance?.coreWebVitals,
          onPage: audit.onPage,
          content: audit.content,
          domain: audit.domain,
          wordpress: audit.wordpress,
        },
        recommendations: recs.recommendations || [],
        overallScore: recs.overallScore,
        summary: recs.summary,
        message: `Full SEO audit completed for ${audit.clientName}. Overall score: ${recs.overallScore || 'N/A'}/100. ${recs.recommendations?.length || 0} recommendations generated.`,
      };
    }

    case 'generate_blog_post': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found` };

      const keywords = toolInput.keywords ? toolInput.keywords.split(',').map(k => k.trim()) : [];
      const post = await seoEngine.generateBlogPost({
        topic: toolInput.topic,
        keywords,
        tone: toolInput.tone,
        wordCount: toolInput.wordCount || 1200,
        clientName: client.name,
        businessDescription: client.description,
        targetAudience: client.target_audience,
      });

      if (post.error) return post;

      const result = { ...post, action: toolInput.action || 'generate_only' };

      // Publish to WordPress if requested and connected
      if (toolInput.action && toolInput.action !== 'generate_only') {
        const wp = seoEngine.getWordPressClient(client);
        if (!wp) {
          result.wpStatus = 'not_connected';
          result.message = `Blog post generated but WordPress is not connected for ${client.name}. Send them a Leadsie link with WordPress access to enable publishing.`;
        } else {
          try {
            const status = toolInput.action === 'schedule' ? 'future' : 'draft';
            const wpPost = await wp.createPost({
              title: post.title,
              content: post.content,
              excerpt: post.excerpt,
              slug: post.slug,
              status,
              date: toolInput.publishDate,
              meta: {
                _yoast_wpseo_title: post.seoTitle,
                _yoast_wpseo_metadesc: post.seoDescription,
                _yoast_wpseo_focuskw: post.focusKeyword,
              },
            });
            result.wpPost = wpPost;
            result.wpStatus = status;
            result.message = status === 'future'
              ? `Blog post "${post.title}" scheduled for ${toolInput.publishDate} on WordPress! Link: ${wpPost.link}`
              : `Blog post "${post.title}" saved as draft on WordPress! Link: ${wpPost.link}`;
          } catch (e) {
            result.wpStatus = 'failed';
            result.wpError = e.message;
            result.message = `Blog post generated but WordPress publish failed: ${e.message}`;
          }
        }
      } else {
        result.message = `Blog post "${post.title}" generated (${post.content?.length || 0} chars). Ready to review before publishing.`;
      }

      return result;
    }

    case 'fix_meta_tags': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found` };

      const wp = seoEngine.getWordPressClient(client);

      // If specific page, generate meta tags for it
      if (toolInput.url || toolInput.pageId) {
        const currentMeta = toolInput.pageId && wp
          ? await wp.getPageSEO(toolInput.pageId, toolInput.pageType || 'posts')
          : {};

        const newMeta = await seoEngine.generateMetaTags({
          url: toolInput.url || currentMeta.link || client.website,
          currentTitle: currentMeta.seoTitle,
          currentDescription: currentMeta.seoDescription,
          focusKeyword: toolInput.focusKeyword || currentMeta.focusKeyword,
          businessDescription: client.description,
        });

        if (toolInput.applyChanges && wp && toolInput.pageId) {
          try {
            await wp.updatePageSEO(toolInput.pageId, newMeta, toolInput.pageType || 'posts');
            newMeta.applied = true;
            newMeta.message = `Meta tags updated on WordPress for page #${toolInput.pageId}!`;
          } catch (e) {
            newMeta.applied = false;
            newMeta.message = `Meta tags generated but update failed: ${e.message}`;
          }
        } else {
          newMeta.applied = false;
          newMeta.message = wp
            ? `Meta tags generated. Set applyChanges=true to push to WordPress.`
            : `Meta tags generated. Connect WordPress via Leadsie to auto-apply.`;
        }

        return newMeta;
      }

      // Audit ALL pages if no specific page
      if (!wp) return { error: `WordPress not connected for ${client.name}. Cannot audit all pages without CMS access.` };

      const allSEO = await wp.getAllPagesSEO();
      const needsFix = allSEO.filter(p => !p.seoTitle || !p.seoDescription || p.seoTitle === '(missing)' || p.seoDescription === '(missing)');

      return {
        totalPages: allSEO.length,
        pagesNeedingFix: needsFix.length,
        pages: needsFix.slice(0, 15).map(p => ({
          id: p.id, title: p.title, type: p.type, slug: p.slug,
          seoTitle: p.seoTitle, seoDescription: p.seoDescription,
        })),
        message: `Found ${needsFix.length}/${allSEO.length} pages missing or incomplete meta tags. Use fix_meta_tags with a specific pageId to generate and apply fixes.`,
      };
    }

    case 'plan_content_calendar': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found` };

      const keywords = toolInput.keywords ? toolInput.keywords.split(',').map(k => k.trim()) : [];
      const competitors = client.competitors ? (typeof client.competitors === 'string' ? JSON.parse(client.competitors) : client.competitors) : [];

      const calendar = await seoEngine.planContentCalendar({
        clientName: client.name,
        keywords,
        competitors,
        industry: client.industry,
        monthsAhead: toolInput.monthsAhead || 3,
        postsPerWeek: toolInput.postsPerWeek || 1,
      });

      if (calendar.error) return calendar;

      // Save to Google Sheets if client has Drive folder
      if (client.drive_root_folder_id) {
        try {
          const sheet = await googleSheets.createSpreadsheet(
            `${client.name} — SEO Content Calendar`,
            client.drive_root_folder_id,
          );
          const rows = [['Week', 'Publish Date', 'Title', 'Primary Keyword', 'Content Type', 'Search Volume', 'Brief', 'Status']];
          for (const item of (calendar.calendar || [])) {
            rows.push([item.week, item.publishDate, item.title, item.primaryKeyword, item.contentType, item.searchVolume, item.brief, 'Planned']);
          }
          await googleSheets.writeData(sheet.spreadsheetId, 'Sheet1!A1', rows);
          calendar.sheetUrl = `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}`;
          calendar.message = `Content calendar created with ${calendar.calendar?.length || 0} posts! View and edit: ${calendar.sheetUrl}`;
        } catch (e) {
          log.warn('Failed to save content calendar to Sheets', { error: e.message });
          calendar.message = `Content calendar created with ${calendar.calendar?.length || 0} posts (Google Sheet save failed: ${e.message}).`;
        }
      } else {
        calendar.message = `Content calendar created with ${calendar.calendar?.length || 0} posts.`;
      }

      return calendar;
    }

    case 'list_wp_content': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found` };

      const wp = seoEngine.getWordPressClient(client);
      if (!wp) return { error: `WordPress not connected for ${client.name}. Send them a Leadsie link with WordPress access.` };

      const contentType = toolInput.contentType || 'all';
      const status = toolInput.status === 'any' ? undefined : (toolInput.status || 'publish');
      const results = {};

      if (contentType === 'posts' || contentType === 'all') {
        results.posts = await wp.listPosts({ status, perPage: 50 });
      }
      if (contentType === 'pages' || contentType === 'all') {
        results.pages = await wp.listPages({ status, perPage: 50 });
      }

      const totalPosts = results.posts?.length || 0;
      const totalPages = results.pages?.length || 0;
      return { ...results, totalPosts, totalPages, message: `Found ${totalPosts} posts and ${totalPages} pages on ${client.name}'s WordPress site.` };
    }

    case 'update_wp_post': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found` };

      const wp = seoEngine.getWordPressClient(client);
      if (!wp) return { error: `WordPress not connected for ${client.name}.` };

      const updates = {};
      if (toolInput.title) updates.title = toolInput.title;
      if (toolInput.content) updates.content = toolInput.content;
      if (toolInput.status) updates.status = toolInput.status;

      // Update post content
      const postResult = await wp.updatePost(toolInput.postId, updates);

      // Update SEO meta separately if provided
      if (toolInput.seoTitle || toolInput.seoDescription || toolInput.focusKeyword) {
        await wp.updatePageSEO(toolInput.postId, {
          seoTitle: toolInput.seoTitle,
          seoDescription: toolInput.seoDescription,
          focusKeyword: toolInput.focusKeyword,
        });
      }

      return { ...postResult, message: `Post #${toolInput.postId} updated successfully on WordPress.` };
    }

    case 'generate_schema_markup': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found` };

      const schema = await seoEngine.generateSchemaMarkup({
        pageType: toolInput.pageType,
        url: toolInput.url,
        businessName: client.name,
        businessDescription: client.description,
      });

      return { schema, message: `JSON-LD schema markup generated for ${toolInput.pageType}. Add this to the page's <head> section.` };
    }

    // --- Leadsie Onboarding ---
    case 'create_onboarding_link': {
      const platforms = toolInput.platforms
        ? toolInput.platforms.split(',').map(p => p.trim())
        : ['facebook', 'google', 'wordpress', 'hubspot'];
      const invite = await leadsie.createInvite({
        clientName: toolInput.clientName,
        clientEmail: toolInput.clientEmail || '',
        platforms,
      });
      return {
        inviteUrl: invite.inviteUrl,
        inviteId: invite.inviteId,
        status: invite.status,
        platforms,
        message: `Onboarding link created for ${toolInput.clientName}. Send this link to the client: ${invite.inviteUrl}`,
      };
    }

    case 'check_onboarding_status': {
      const status = await leadsie.getInviteStatus(toolInput.inviteId);
      return {
        inviteId: status.inviteId,
        clientName: status.clientName,
        status: status.status,
        platforms: status.platforms,
        grantedAccounts: status.grantedAccounts,
        createdAt: status.createdAt,
        completedAt: status.completedAt,
        message: status.status === 'completed'
          ? `${status.clientName} has completed onboarding! Access granted for: ${status.grantedAccounts?.map(a => a.name || a.id).join(', ') || 'accounts linked'}.`
          : `Onboarding status: ${status.status}. The client hasn't completed the process yet.`,
      };
    }

    case 'start_client_onboarding': {
      const result = await initiateOnboarding(toolInput.clientPhone);
      if (result.status === 'already_active') {
        return {
          status: 'already_active',
          phone: toolInput.clientPhone,
          currentStep: result.session.current_step,
          message: `There's already an active onboarding session for this number. The client is on step: ${result.session.current_step}. They can continue by messaging Sofia.`,
        };
      }
      return {
        status: 'started',
        phone: toolInput.clientPhone,
        message: `Onboarding started! I've sent a welcome message to ${toolInput.clientPhone}. Sofia will guide them through the questions and auto-create their Drive folder, Leadsie link, and intake document when done.`,
      };
    }

    // --- Google Drive Client Folders ---
    case 'setup_client_drive': {
      const folders = await googleDrive.ensureClientFolders(toolInput.clientName);
      if (!folders) {
        return { error: 'Google Drive not configured. Set GOOGLE_DRIVE_ROOT_FOLDER_ID in .env.' };
      }
      return {
        clientName: toolInput.clientName,
        rootFolderId: folders.root?.id,
        folders: Object.entries(folders).filter(([k]) => k !== 'root').map(([key, f]) => ({
          name: key,
          id: f?.id,
        })),
        message: `Google Drive folder structure created for ${toolInput.clientName}. They can now send files via WhatsApp and I'll save them automatically.`,
      };
    }

    case 'list_client_files': {
      const client = getClient(toolInput.clientName);
      const folderKey = toolInput.folder || 'all';
      const folderId = client?.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;

      if (!folderId) {
        return { error: 'No Google Drive folder found for this client. Use setup_client_drive first.' };
      }

      const files = await googleDrive.listFiles(folderId, { limit: 30 });
      return {
        clientName: toolInput.clientName,
        folder: folderKey,
        files: (files || []).map(f => ({
          name: f.name,
          type: f.mimeType,
          modifiedTime: f.modifiedTime,
          webViewLink: f.webViewLink,
        })),
        totalFiles: files?.length || 0,
      };
    }

    // --- Google Analytics ---
    case 'get_analytics_metrics': {
      const client = getClient(toolInput.clientName);
      const propertyId = client?.ga4_property_id || config.GA4_PROPERTY_ID;
      if (!propertyId) return { error: 'No GA4 property ID configured for this client. Set ga4_property_id in client config or GA4_PROPERTY_ID env var.' };
      const metrics = await googleAnalytics.getPropertyMetrics(propertyId, { startDate: toolInput.startDate, endDate: toolInput.endDate });
      return { clientName: toolInput.clientName, ...metrics };
    }
    case 'get_analytics_top_pages': {
      const client = getClient(toolInput.clientName);
      const propertyId = client?.ga4_property_id || config.GA4_PROPERTY_ID;
      if (!propertyId) return { error: 'No GA4 property ID configured.' };
      const pages = await googleAnalytics.getTopPages(propertyId, { startDate: toolInput.startDate, endDate: toolInput.endDate, limit: toolInput.limit });
      return { clientName: toolInput.clientName, topPages: pages };
    }
    case 'get_analytics_traffic_sources': {
      const client = getClient(toolInput.clientName);
      const propertyId = client?.ga4_property_id || config.GA4_PROPERTY_ID;
      if (!propertyId) return { error: 'No GA4 property ID configured.' };
      const sources = await googleAnalytics.getTrafficSources(propertyId, { startDate: toolInput.startDate, endDate: toolInput.endDate });
      return { clientName: toolInput.clientName, trafficSources: sources };
    }
    case 'get_analytics_audience': {
      const client = getClient(toolInput.clientName);
      const propertyId = client?.ga4_property_id || config.GA4_PROPERTY_ID;
      if (!propertyId) return { error: 'No GA4 property ID configured.' };
      const audience = await googleAnalytics.getAudienceDemographics(propertyId, { startDate: toolInput.startDate, endDate: toolInput.endDate });
      return { clientName: toolInput.clientName, ...audience };
    }
    case 'get_analytics_daily_trend': {
      const client = getClient(toolInput.clientName);
      const propertyId = client?.ga4_property_id || config.GA4_PROPERTY_ID;
      if (!propertyId) return { error: 'No GA4 property ID configured.' };
      const trend = await googleAnalytics.getDailyTrend(propertyId, { startDate: toolInput.startDate, endDate: toolInput.endDate });
      return { clientName: toolInput.clientName, dailyTrend: trend };
    }

    // --- Google Ads Transparency Center ---
    case 'search_google_ads_transparency': {
      const result = await googleTransparency.searchAndGetCreatives({
        query: toolInput.query,
        region: toolInput.region,
        limit: toolInput.limit,
      });
      return result;
    }

    // --- Google Keyword Planner ---
    case 'get_keyword_planner_ideas': {
      const ideas = await keywordPlanner.getKeywordIdeas({
        keywords: toolInput.keywords,
        url: toolInput.url,
        limit: toolInput.limit,
      });
      return { keywords: toolInput.keywords, url: toolInput.url, ideas };
    }
    case 'get_keyword_planner_volume': {
      const volume = await keywordPlanner.getSearchVolume({ keywords: toolInput.keywords });
      return { keywords: toolInput.keywords, data: volume };
    }

    // --- Presentation Builders ---
    case 'build_media_plan_deck': {
      const client = getClient(toolInput.clientName);
      const folderId = client?.drive_strategic_plans_folder_id || client?.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      const result = await presentationBuilder.buildMediaPlanDeck({
        clientName: toolInput.clientName,
        campaignName: toolInput.campaignName,
        mediaPlan: toolInput.mediaPlan,
        creatives: toolInput.creatives,
        charts: toolInput.charts,
        folderId,
      });
      if (!result) return { error: 'Failed to build media plan deck. Check Google credentials.' };

      // Save companion Sheet to Drive
      let sheetUrl = null;
      try {
        const sheet = await campaignRecord.createMediaPlanRecord({
          clientName: toolInput.clientName,
          campaignName: toolInput.campaignName,
          mediaPlan: toolInput.mediaPlan,
          folderId,
        });
        sheetUrl = sheet?.url || null;
      } catch (e) {
        log.error('Failed to create media plan record sheet', { error: e.message });
      }

      return {
        clientName: toolInput.clientName,
        presentationUrl: result.url,
        presentationId: result.presentationId,
        sheetUrl,
        message: `Media plan deck ready: ${result.url}` + (sheetUrl ? ` | Data sheet: ${sheetUrl}` : ''),
      };
    }
    case 'build_competitor_deck': {
      const client = getClient(toolInput.clientName);
      const folderId = client?.drive_competitor_research_folder_id || client?.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      const result = await presentationBuilder.buildCompetitorDeck({
        clientName: toolInput.clientName,
        competitors: toolInput.competitors,
        keywordGap: toolInput.keywordGap,
        competitorAds: toolInput.competitorAds,
        serpAnalysis: toolInput.serpAnalysis,
        domainOverview: toolInput.domainOverview,
        summary: toolInput.summary,
        recommendations: toolInput.recommendations,
        charts: toolInput.charts,
        folderId,
      });
      if (!result) return { error: 'Failed to build competitor deck. Check Google credentials.' };

      // Save companion Sheet to Drive
      let sheetUrl = null;
      try {
        const sheet = await campaignRecord.createCompetitorRecord({
          clientName: toolInput.clientName,
          competitors: toolInput.competitors,
          keywordGap: toolInput.keywordGap,
          competitorAds: toolInput.competitorAds,
          domainOverview: toolInput.domainOverview,
          summary: toolInput.summary,
          recommendations: toolInput.recommendations,
          folderId,
        });
        sheetUrl = sheet?.url || null;
      } catch (e) {
        log.error('Failed to create competitor record sheet', { error: e.message });
      }

      return {
        clientName: toolInput.clientName,
        presentationUrl: result.url,
        presentationId: result.presentationId,
        sheetUrl,
        message: `Competitor research deck ready: ${result.url}` + (sheetUrl ? ` | Data sheet: ${sheetUrl}` : ''),
      };
    }
    case 'build_performance_deck': {
      const client = getClient(toolInput.clientName);
      const folderId = client?.drive_reports_folder_id || client?.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      const result = await presentationBuilder.buildPerformanceDeck({
        clientName: toolInput.clientName,
        reportType: toolInput.reportType,
        dateRange: toolInput.dateRange,
        metrics: toolInput.metrics,
        analytics: toolInput.analytics,
        campaigns: toolInput.campaigns,
        topKeywords: toolInput.topKeywords,
        audienceData: toolInput.audienceData,
        dailyTrend: toolInput.dailyTrend,
        analysis: toolInput.analysis,
        recommendations: toolInput.recommendations,
        charts: toolInput.charts,
        folderId,
      });
      if (!result) return { error: 'Failed to build performance deck. Check Google credentials.' };

      // Save companion Sheet to Drive
      let sheetUrl = null;
      try {
        const sheet = await campaignRecord.createPerformanceRecord({
          clientName: toolInput.clientName,
          reportType: toolInput.reportType,
          dateRange: toolInput.dateRange,
          metrics: toolInput.metrics,
          analytics: toolInput.analytics,
          campaigns: toolInput.campaigns,
          topKeywords: toolInput.topKeywords,
          audienceData: toolInput.audienceData,
          analysis: toolInput.analysis,
          recommendations: toolInput.recommendations,
          folderId,
        });
        sheetUrl = sheet?.url || null;
      } catch (e) {
        log.error('Failed to create performance record sheet', { error: e.message });
      }

      return {
        clientName: toolInput.clientName,
        presentationUrl: result.url,
        presentationId: result.presentationId,
        sheetUrl,
        message: `Performance report deck ready: ${result.url}` + (sheetUrl ? ` | Data sheet: ${sheetUrl}` : ''),
      };
    }

    // --- PDF Reports ---
    case 'generate_performance_pdf': {
      const client = getClient(toolInput.clientName);
      const folderId = client?.drive_reports_folder_id || client?.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      const result = await reportBuilder.generatePerformanceReport({
        clientName: toolInput.clientName,
        reportType: toolInput.reportType,
        dateRange: toolInput.dateRange,
        metrics: toolInput.metrics,
        analytics: toolInput.analytics,
        campaigns: toolInput.campaigns,
        topKeywords: toolInput.topKeywords,
        audienceData: toolInput.audienceData,
        analysis: toolInput.analysis,
        recommendations: toolInput.recommendations,
        folderId,
        clientId: client?.id,
      });
      if (!result) return { error: 'Failed to generate report. Check Google credentials.' };
      return { clientName: toolInput.clientName, docUrl: result.docUrl, pdfUrl: result.pdfUrl, message: `Report ready! Doc: ${result.docUrl} | PDF: ${result.pdfUrl}` };
    }
    case 'generate_competitor_pdf': {
      const client = getClient(toolInput.clientName);
      const folderId = client?.drive_competitor_research_folder_id || client?.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      const result = await reportBuilder.generateCompetitorReport({
        clientName: toolInput.clientName,
        competitors: toolInput.competitors,
        keywordGap: toolInput.keywordGap,
        competitorAds: toolInput.competitorAds,
        summary: toolInput.summary,
        recommendations: toolInput.recommendations,
        folderId,
      });
      if (!result) return { error: 'Failed to generate competitor report. Check Google credentials.' };
      return { clientName: toolInput.clientName, docUrl: result.docUrl, pdfUrl: result.pdfUrl, message: `Competitor report ready! Doc: ${result.docUrl} | PDF: ${result.pdfUrl}` };
    }

    // --- Charts ---
    case 'create_chart_presentation': {
      const client = getClient(toolInput.clientName);
      const folderId = client?.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      const result = await chartBuilderService.buildChartPresentation({
        clientName: toolInput.clientName,
        title: toolInput.title,
        charts: toolInput.charts,
        folderId,
      });
      if (!result) return { error: 'Failed to create chart presentation. Check Google credentials.' };
      return { clientName: toolInput.clientName, presentationUrl: result.url, presentationId: result.presentationId, message: `Chart presentation ready: ${result.url}` };
    }
    case 'create_single_chart': {
      const result = await chartBuilderService.createChart({
        title: toolInput.title,
        chartType: toolInput.chartType,
        labels: toolInput.labels,
        series: toolInput.series,
      });
      return { chartId: result.chartId, sheetUrl: result.sheetUrl, spreadsheetId: result.spreadsheetId, message: `Chart created! View: ${result.sheetUrl}` };
    }

    // --- Diagnostics ---
    case 'check_credentials': {
      const fs = (await import('fs')).default;
      const credPath = config.GOOGLE_APPLICATION_CREDENTIALS || '(not set in .env)';
      const credFileExists = config.GOOGLE_APPLICATION_CREDENTIALS ? fs.existsSync(config.GOOGLE_APPLICATION_CREDENTIALS) : false;

      const checks = {
        google_service_account: {
          envVar: 'GOOGLE_APPLICATION_CREDENTIALS',
          value: credPath,
          fileExists: credFileExists,
          status: credFileExists ? 'OK' : 'MISSING',
          fix: credFileExists ? null : `The file "${credPath}" does not exist. To fix: 1) Go to console.cloud.google.com → IAM & Admin → Service Accounts, 2) Create a service account (or use existing), 3) Click the account → Keys → Add Key → JSON, 4) Download and save the JSON file to "${credPath}". Then enable these APIs in the GCP project: Google Slides API, Google Sheets API, Google Drive API, Google Docs API.`,
          affects: ['Google Slides (presentations, charts)', 'Google Sheets (charts, calendars, reports)', 'Google Drive (file storage, folders)', 'Google Docs (PDF reports)', 'Google Analytics (if using service account)'],
        },
        google_ads: {
          status: config.GOOGLE_ADS_DEVELOPER_TOKEN ? 'CONFIGURED' : 'NOT SET',
          hasDevToken: !!config.GOOGLE_ADS_DEVELOPER_TOKEN,
          hasClientId: !!config.GOOGLE_ADS_CLIENT_ID,
          hasRefreshToken: !!config.GOOGLE_ADS_REFRESH_TOKEN,
          hasManagerId: !!config.GOOGLE_ADS_MANAGER_ACCOUNT_ID,
          affects: ['Google Ads campaigns/performance', 'Keyword Planner'],
        },
        meta: {
          status: config.META_USER_ACCESS_TOKEN ? 'CONFIGURED' : 'NOT SET',
          hasUserToken: !!config.META_USER_ACCESS_TOKEN,
          hasAppId: !!config.META_APP_ID,
          affects: ['Meta Ad Library (competitor ads)', 'Meta Ads (campaign management)'],
        },
        dataforseo: {
          status: config.DATAFORSEO_LOGIN ? 'CONFIGURED' : 'NOT SET',
          affects: ['SERP analysis', 'SEO competitors', 'Keyword gap', 'On-page audits'],
        },
        ga4: {
          propertyId: config.GA4_PROPERTY_ID || '(not set)',
          status: config.GA4_PROPERTY_ID ? 'CONFIGURED' : 'NOT SET',
          affects: ['Google Analytics metrics, pages, traffic, audience'],
        },
      };

      const issues = [];
      if (!credFileExists) issues.push('CRITICAL: Google service account JSON file is missing — Slides, Sheets, Drive, Docs will NOT work');
      if (!config.GOOGLE_ADS_DEVELOPER_TOKEN) issues.push('Google Ads not configured — campaigns and Keyword Planner unavailable');
      if (!config.META_USER_ACCESS_TOKEN) issues.push('Meta user access token not set — Ad Library unavailable');
      if (!config.GA4_PROPERTY_ID) issues.push('GA4 property ID not set — Analytics unavailable');

      return {
        checks,
        issues,
        summary: issues.length === 0 ? 'All credentials configured!' : `${issues.length} issue(s) found — see details above`,
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
  } catch (err) {
    log.error(`Tool ${toolName} failed`, { error: err.message });
    return { error: err.message };
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

    if (!message) return;

    const from = message.from; // e.g. "1234567890"

    // Handle file uploads (images, documents, video, audio)
    if (['image', 'document', 'video', 'audio'].includes(message.type)) {
      const media = message[message.type];
      const caption = media?.caption || message.caption || '';
      log.info('WhatsApp media received', { from, type: message.type, mimeType: media?.mime_type });

      const normalizePhone = (p) => p?.replace(/[^0-9]/g, '');
      const isOwner = normalizePhone(from) === normalizePhone(config.WHATSAPP_OWNER_PHONE);
      if (isOwner) {
        await handleMediaUpload(from, message.type, media, caption);
      }
      return;
    }

    if (message.type !== 'text') return;

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
    if (!message) return;

    const chatId = String(message.chat?.id);
    const isOwner = chatId === config.TELEGRAM_OWNER_CHAT_ID;

    // Handle file uploads (photos, documents, video, audio)
    const fileObj = message.document || message.photo?.slice(-1)?.[0] || message.video || message.audio;
    if (fileObj && isOwner) {
      const caption = message.caption || '';
      const mediaType = message.document ? 'document' : message.photo ? 'image' : message.video ? 'video' : 'audio';
      log.info('Telegram file received', { chatId, mediaType, fileId: fileObj.file_id });
      await handleTelegramMediaUpload(chatId, mediaType, fileObj, caption);
      return;
    }

    if (!message.text) return;
    const body = message.text.trim();
    if (!body) return;

    log.info('Telegram message received', { chatId, body: body.substring(0, 100) });

    if (isOwner) {
      // Check if owner has an active onboarding session (e.g., testing client flow)
      if (hasActiveOnboarding(chatId)) {
        log.info('Owner has active onboarding — routing to onboarding flow', { chatId });
        addToHistory(chatId, 'user', body, 'telegram');
        const result = await handleOnboardingMessage(chatId, body, 'telegram');
        if (Array.isArray(result)) {
          for (const msg of result) {
            addToHistory(chatId, 'assistant', msg, 'telegram');
            await sendTelegram(msg, chatId);
          }
        } else if (result) {
          addToHistory(chatId, 'assistant', result, 'telegram');
          await sendTelegram(result, chatId);
        }
        return;
      }

      // Check if this is a /start TOKEN deep link — owner may be testing as a client
      const ownerStartMatch = body.match(TOKEN_RE_START);
      if (ownerStartMatch) {
        const pending = await getPendingClientWithFallback(ownerStartMatch[1]);
        if (pending) {
          log.info('Owner triggered client onboarding via /start token', { chatId, token: pending.token });
          await handleTelegramClientMessage(chatId, body);
          return;
        }
      }

      // Bare /start (no token) — route to client handler to start/resume onboarding
      if (/^\/start$/i.test(body.trim())) {
        log.info('Owner sent bare /start, routing to client onboarding handler', { chatId });
        await handleTelegramClientMessage(chatId, body);
        return;
      }

      // Normal owner command access
      await handleTelegramCommand(body, chatId);
    } else {
      // Non-owner messages get AI-powered responses via Telegram
      await handleTelegramClientMessage(chatId, body);
    }
  } catch (error) {
    log.error('Telegram command handling failed', { error: error.message, stack: error.stack });
    try {
      await sendTelegram(`Error: ${error.message}`);
    } catch (e) { /* best effort */ }
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
- NEVER assume a tool is broken or credentials are unavailable based on past failures. ALWAYS call the tool again — credentials and configurations can change at any time. Never tell the user that "credentials are unavailable" without actually calling the tool first to verify.
- When asked to create presentations, charts, graphs, reports, or any Google Slides/Sheets/Drive/Docs content, you MUST call the appropriate tool (build_media_plan_deck, build_competitor_deck, build_performance_deck, create_chart_presentation, create_single_chart, generate_performance_pdf, generate_competitor_pdf). NEVER substitute with text-based tables, ASCII art, or emoji-based charts. The tools create REAL Google Slides with interactive charts.
- If a Google tool fails, use check_credentials to diagnose the issue and report the specific error — do not give up or offer text alternatives.

CREATIVE GENERATION PROCESS — FOLLOW THIS STRICTLY:
When the user asks you to create ads, visuals, creatives, or mockups, DO NOT generate immediately. Instead, follow this process:

1. <b>Gather the Creative Brief</b> — Before generating anything, ask the user these questions (adapt naturally, don't list them robotically — ask the most relevant 3-5 based on context):
   - What's the campaign objective? (brand awareness, leads, conversions, traffic?)
   - Who is the target audience? (demographics, interests, pain points)
   - What's the offer or value proposition? (discount, free trial, unique benefit?)
   - Any visual references or inspiration? (competitor ads they like, mood boards, websites they admire, style preferences)
   - Brand guidelines? (colors, fonts, tone — or suggest they send a brand guide via file upload)
   - What platforms? (Meta, Google, TikTok, Instagram?)
   - What creative style? (photorealistic product shot, lifestyle photography, flat/minimal design, bold/vibrant graphic, editorial, cinematic?)
   - Any competitors to reference or differentiate from?
   - Specific products/services to feature?
   - What emotion should the ad evoke? (urgency, trust, excitement, aspiration, exclusivity?)

2. <b>Research First</b> — Before generating, use your tools:
   - Browse the client's website (browse_website) to understand brand, colors, visual style, messaging
   - Search competitor ads (search_ad_library) to see what's working in the space
   - Check brand files if they have a Drive folder (list_client_files)

3. <b>Generate with Full Context</b> — Only after gathering info, generate creatives. Pass ALL context (brand colors, audience, references, style, mood, competitive landscape) to the generation tools. The more detail you provide in the prompt, the better the result.

4. <b>Present & Iterate</b> — Show results and ask: "What do you think? Want me to adjust the style, colors, mood, or try a completely different angle?"

EXCEPTION: If the user gives ALL context upfront (audience, offer, style, platform), skip questions and generate.
EXCEPTION: If the user says "just do it" or "surprise me", generate with available context but mention your assumptions.

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

  try {
    // Conversational loop with tool use (using shared CSA_TOOLS)
    let response = await askClaude({
      systemPrompt: TELEGRAM_CSA_PROMPT + clientContext,
      messages,
      tools: CSA_TOOLS,
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 4096,
      workflow: 'telegram-csa',
    });

    // Handle tool use loop (max 10 rounds to allow multi-step tasks)
    let rounds = 0;
    const toolsSummary = [];
    const allToolResults = []; // Collect all tool results for persistent history
    while (response.stopReason === 'tool_use' && rounds < 10) {
      rounds++;

      // Send a natural "working on it" message on first tool call
      if (rounds === 1 && response.text) {
        await reply(response.text);
      }

      // Execute all tool calls
      const toolResults = [];
      for (const tool of response.toolUse) {
        log.info('Executing tool', { tool: tool.name, round: rounds });
        toolsSummary.push(tool.name);

        // Send thinking message before expensive tools
        if (tool.name === 'generate_ad_images') await sendThinkingIndicator('telegram', chatId, 'Generating your ad images... This might take a minute.');
        if (tool.name === 'generate_ad_video') await sendThinkingIndicator('telegram', chatId, 'Creating your video with Sora 2... This will take a few minutes. I\'ll send it as soon as it\'s ready!');
        if (tool.name === 'generate_creative_package') await sendThinkingIndicator('telegram', chatId, 'Building your full creative package... Give me a few minutes!');

        try {
          const result = await executeCSATool(tool.name, tool.input);
          const resultJson = JSON.stringify(result);
          toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: resultJson });
          allToolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: resultJson });
          // Deliver generated media inline (images, videos)
          await deliverMediaInline(tool.name, result, 'telegram', chatId);
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
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 4096,
        workflow: 'telegram-csa',
      });
    }

    // Send final response and save rich context to history
    const tgFinalText = response.text || `I ran ${rounds} tool steps (${toolsSummary.join(', ')}) but couldn't produce a final answer. Please try again or ask me to summarize what I found.`;

    if (rounds > 0 && toolsSummary.length > 0) {
      const toolNames = `[Used tools: ${[...new Set(toolsSummary)].join(', ')}]`;
      const deliverables = summarizeToolDeliverables(allToolResults);
      const contextBlock = deliverables ? `${toolNames}\n${deliverables}` : toolNames;
      addToHistory(chatId, 'assistant', `${contextBlock}\n${tgFinalText}`);
    } else {
      addToHistory(chatId, 'assistant', tgFinalText);
    }
    await reply(tgFinalText);
  } catch (error) {
    log.error('Telegram command loop failed', { error: error.message, stack: error.stack });
    const isRateLimit = error.status === 429 || error.message?.includes('rate_limit');
    const errorMsg = isRateLimit
      ? 'I\'m currently experiencing high demand. Please wait a minute and try again.'
      : 'Something went wrong while processing your request. Please try again.';
    addToHistory(chatId, 'assistant', errorMsg);
    await reply(errorMsg);
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
    // Handle /start TOKEN from Telegram deep link
    let actualMessage = message;
    let pendingData = null;
    let crossLinked = false;
    const startMatch = message.match(TOKEN_RE_START);
    if (startMatch) {
      const pending = await getPendingClientWithFallback(startMatch[1]);
      if (pending) {
        activatePendingClient(pending.token, chatId, 'telegram');
        pendingData = pending;
        log.info('Activated pending client from Telegram /start', { token: pending.token, chatId });
      } else {
        // Token already activated on another channel — try cross-channel link
        const linked = tryLinkCrossChannel(startMatch[1], chatId, 'telegram');
        if (linked) {
          crossLinked = true;
          log.info('Cross-channel link via Telegram /start', { chatId });
          await sendTelegram(
            `Hey${linked.contactName ? ` <b>${linked.contactName}</b>` : ''}! I see you've already been onboarded on another channel. Great to connect with you here on Telegram too! How can I help you today?`,
            chatId,
          );
          return;
        }
      }
    }

    // Bare /start (no token) — look up the most recent unactivated pending client
    if (!startMatch && /^\/start$/i.test(message.trim())) {
      const latestPending = getLatestPendingClient();
      if (latestPending) {
        activatePendingClient(latestPending.token, chatId, 'telegram');
        pendingData = latestPending;
        log.info('Activated latest pending client from bare /start', { token: latestPending.token, chatId });
      } else {
        // No local pending client — try Supabase for recent submissions
        try {
          // Query Supabase without a specific UUID is not supported via REST,
          // so just log and continue to generic onboarding
          log.info('No pending client found for bare /start', { chatId });
        } catch (e) { /* best effort */ }
      }
    }

    // Build the formatted "Hi Sofia, I am..." message from pending data
    if (pendingData) {
      actualMessage = `Hi Sofia, I am ${pendingData.name || 'a new client'}${pendingData.business_name ? `, representing ${pendingData.business_name}` : ''}${pendingData.website ? ` (${pendingData.website})` : ''}. My Unique Client Code is ${pendingData.token}.`;

      // Cancel stale onboarding sessions so fresh signups get the personalized welcome
      const staleSession = getOnboardingSession(chatId);
      if (staleSession) {
        updateOnboardingSession(staleSession.id, { status: 'cancelled' });
        log.info('Cancelled stale Telegram onboarding session for fresh signup', { chatId, sessionId: staleSession.id });
      }
    }

    // Check for active onboarding via Telegram (uses chatId as identifier)
    if (hasActiveOnboarding(chatId)) {
      log.info('Routing Telegram to onboarding flow', { chatId });
      addToHistory(chatId, 'user', actualMessage, 'telegram');
      const result = await handleOnboardingMessage(chatId, actualMessage, 'telegram');
      if (Array.isArray(result)) {
        for (const msg of result) {
          addToHistory(chatId, 'assistant', msg, 'telegram');
          await sendTelegram(msg, chatId);
        }
      } else if (result) {
        addToHistory(chatId, 'assistant', result, 'telegram');
        await sendTelegram(result, chatId);
      }
      return;
    }

    // Check if this is a NEW person
    let clientContext = getClientContextByPhone(chatId);
    if (!clientContext) {
      // Check for token in message (non /start format)
      if (!startMatch && !pendingData) {
        const tokenMatch = message.match(TOKEN_RE_INLINE);
        if (tokenMatch) {
          const found = await getPendingClientWithFallback(tokenMatch[1]);
          if (found) {
            activatePendingClient(found.token, chatId, 'telegram');
            pendingData = found;
            log.info('Activated pending client from token (Telegram)', { token: found.token, chatId });
          } else {
            // Token already activated — try cross-channel link
            const linked = tryLinkCrossChannel(tokenMatch[1], chatId, 'telegram');
            if (linked) {
              crossLinked = true;
              log.info('Cross-channel link via Telegram inline token', { chatId });
              await sendTelegram(
                `Hey${linked.contactName ? ` <b>${linked.contactName}</b>` : ''}! I see you've already been onboarded on another channel. Great to connect with you here on Telegram too! How can I help you today?`,
                chatId,
              );
              return;
            }
          }
        }
      }

      const lang = pendingData?.language || 'en';
      log.info('New Telegram contact, auto-starting onboarding', { chatId, language: lang });

      if (pendingData && pendingData.name) {
        // Client came from website — personalized welcome + confirmation
        try {
          createContact({ phone: chatId, name: pendingData.name, email: pendingData.email, channel: 'telegram', language: lang });
        } catch (e) { /* might already exist */ }

        const prefillAnswers = {};
        if (pendingData.name) prefillAnswers.name = pendingData.name;
        if (pendingData.website) prefillAnswers.website = pendingData.website;
        if (pendingData.business_name) prefillAnswers.business_name = pendingData.business_name;
        if (pendingData.business_description) prefillAnswers.business_description = pendingData.business_description;
        if (pendingData.product_service) prefillAnswers.product_service = pendingData.product_service;
        if (pendingData.email) prefillAnswers.email = pendingData.email;

        const session = createOnboardingSession(chatId, 'telegram', lang, prefillAnswers);
        const hasFormData = Object.keys(prefillAnswers).length > 1;
        if (hasFormData) {
          updateOnboardingSession(session.id, { currentStep: 'confirm_details' });
        }

        const welcome = buildPersonalizedWelcome(pendingData, lang, 'telegram');
        addToHistory(chatId, 'user', actualMessage, 'telegram');
        addToHistory(chatId, 'assistant', welcome, 'telegram');
        await sendTelegram(welcome, chatId);
      } else {
        createOnboardingSession(chatId, 'telegram', lang);
        addToHistory(chatId, 'user', actualMessage, 'telegram');
        const result = await handleOnboardingMessage(chatId, actualMessage, 'telegram');
        if (Array.isArray(result)) {
          for (const msg of result) {
            addToHistory(chatId, 'assistant', msg, 'telegram');
            await sendTelegram(msg, chatId);
          }
        } else if (result) {
          addToHistory(chatId, 'assistant', result, 'telegram');
          await sendTelegram(result, chatId);
        }
      }

      // Notify owner
      try {
        await sendWhatsApp(`📥 *New client started onboarding via Telegram*\nChat ID: ${chatId}${pendingData?.name ? `\nName: ${pendingData.name}` : ''}${pendingData?.plan ? `\nPlan: ${pendingData.plan}` : ''}\nFirst message: "${message.substring(0, 100)}"`);
      } catch (e) { /* best effort */ }
      return;
    }

    // Check daily message limit based on plan
    const limitCheck = checkClientMessageLimit(chatId);
    if (!limitCheck.allowed) {
      await sendTelegram(
        `Hey ${clientContext.contactName || 'there'}! You've reached your daily message limit (${limitCheck.limit} messages on the <b>${limitCheck.plan.toUpperCase()}</b> plan). Your limit resets tomorrow.\n\nNeed more? Ask us about upgrading your plan!`,
        chatId,
      );
      return;
    }

    // Known client — greet by name and use context with full conversation history
    const contactName = clientContext?.contactName;

    // Build rich client context for Sofia
    const contextParts = [];
    if (contactName) contextParts.push(`<b>Name:</b> ${contactName}`);
    if (clientContext.clientName) contextParts.push(`<b>Business:</b> ${clientContext.clientName}`);
    if (clientContext.industry) contextParts.push(`<b>Industry:</b> ${clientContext.industry}`);
    if (clientContext.website) contextParts.push(`<b>Website:</b> ${clientContext.website}`);
    if (clientContext.productService) contextParts.push(`<b>Product/Service:</b> ${clientContext.productService}`);
    if (clientContext.targetAudience) contextParts.push(`<b>Target Audience:</b> ${clientContext.targetAudience}`);
    if (clientContext.location) contextParts.push(`<b>Location:</b> ${clientContext.location}`);
    if (clientContext.competitors?.length) contextParts.push(`<b>Competitors:</b> ${Array.isArray(clientContext.competitors) ? clientContext.competitors.join(', ') : clientContext.competitors}`);
    if (clientContext.channelsHave) contextParts.push(`<b>Active Channels:</b> ${clientContext.channelsHave}`);
    if (clientContext.channelsNeed) contextParts.push(`<b>Channels Interested In:</b> ${clientContext.channelsNeed}`);
    if (clientContext.brandVoice) contextParts.push(`<b>Brand Voice:</b> ${clientContext.brandVoice}`);

    // Check for cross-channel contacts
    let crossChannelNote = '';
    if (clientContext.clientId) {
      const contacts = getContactsByClientId(clientContext.clientId);
      if (contacts.length > 1) {
        const channels = contacts.map(c => c.channel || 'whatsapp');
        crossChannelNote = `\n\nNOTE: This client is connected on multiple channels: ${channels.join(', ')}. You may reference conversations from other channels if relevant. Current channel: Telegram.`;
      }
    }

    const memoryContext = contextParts.length > 0
      ? `\nCLIENT PROFILE:\n${contextParts.join('\n')}`
      : '';

    const systemPrompt = `You are Sofia, a warm and professional Customer Success Agent for a PPC/digital marketing agency. You're chatting with a client via Telegram.
${memoryContext}${crossChannelNote}

Your role:
- You REMEMBER this client — greet them by name (${contactName}) naturally, like a real human.
- Reference their business context when relevant (their audience, competitors, channels, etc.)
- Answer questions about their campaigns, performance, and strategy
- When they ask for creatives, images, or videos — USE YOUR TOOLS to generate them. Never just describe what you would create.
- When they ask for keyword research, SEO analysis, competitor ads, or market research — USE YOUR TOOLS immediately.
- Be professional, friendly, and concise — like a trusted team member
- If they ask about specific metrics you don't have, offer to pull a report or have the account manager follow up
- Never share other clients' data or internal cost information
- Keep responses under 500 words
- Use Telegram HTML formatting: <b>bold</b>, <i>italic</i>

CRITICAL RULES — FOLLOW THESE ABOVE ALL ELSE:
- ALWAYS follow through and complete the task. When the client asks you to do something, DO IT using your tools. Deliver actual results.
- NEVER abandon a task to show a generic menu or list of capabilities. If you were working on something, FINISH IT.
- If a follow-up message arrives (like "any success?" or "how's it going?"), CONTINUE the task you were working on — do not restart or change topic.
- NEVER tell the client you don't have clients set up or need configuration. You have tools — use them.
- If a tool fails, explain the issue simply and try an alternative approach. Never give up.

CREATIVE GENERATION PROCESS — FOLLOW THIS STRICTLY:
When the client asks for ads, visuals, creatives, or mockups:
1. Gather a brief — ask the most relevant 2-3 questions based on context (objective, audience, style/mood, references)
2. Once you have enough context, call the generate_ad_images or generate_creative_package tool
3. ALWAYS deliver real images/videos — never substitute with text descriptions`;

    // Client-facing tools — creative generation + research/analysis (no campaign management or cost reports)
    const CLIENT_TOOLS = CSA_TOOLS.filter(t => [
      'generate_ad_images', 'generate_ad_video', 'generate_creative_package',
      'generate_text_ads', 'browse_website',
      'search_ad_library', 'search_facebook_pages', 'get_page_ads',
      'get_search_volume', 'get_keyword_ideas',
      'get_keyword_planner_volume', 'get_keyword_planner_ideas',
      'get_domain_overview', 'analyze_serp', 'find_seo_competitors',
      'get_keyword_gap', 'audit_landing_page', 'audit_seo_page',
      'search_google_ads_transparency',
      'full_seo_audit', 'generate_blog_post', 'fix_meta_tags',
      'plan_content_calendar', 'list_wp_content', 'generate_schema_markup',
    ].includes(t.name));

    // Load conversation history (cross-channel if available, otherwise single-channel)
    let history;
    if (clientContext.clientId) {
      const contacts = getContactsByClientId(clientContext.clientId);
      if (contacts.length > 1) {
        history = getCrossChannelHistory(clientContext.clientId, MAX_HISTORY_MESSAGES * 2);
      } else {
        history = getHistory(chatId);
      }
    } else {
      history = getHistory(chatId);
    }
    addToHistory(chatId, 'user', message, 'telegram');

    const messages = [...history, { role: 'user', content: message }];

    // Send thinking indicator so client knows Sofia is working
    await sendThinkingIndicator('telegram', chatId, 'Give me a moment...');

    let response = await askClaude({
      systemPrompt,
      messages,
      tools: CLIENT_TOOLS,
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 4096,
      workflow: 'client-chat',
    });

    // Tool-use loop (max 10 rounds to allow multi-step tasks like keyword research)
    let rounds = 0;
    const toolsSummary = [];
    const allToolResults = []; // Collect all tool results for persistent history
    while (response.stopReason === 'tool_use' && rounds < 10) {
      rounds++;

      if (rounds === 1 && response.text) {
        await sendTelegram(response.text, chatId);
      }

      const toolResults = [];
      for (const tool of response.toolUse) {
        log.info('Client tool execution (Telegram)', { tool: tool.name, client: contactName, round: rounds });
        toolsSummary.push(tool.name);

        if (tool.name === 'generate_ad_images') await sendThinkingIndicator('telegram', chatId, 'Generating your ad images... This might take a minute.');
        if (tool.name === 'generate_ad_video') await sendThinkingIndicator('telegram', chatId, 'Creating your video... This will take a few minutes.');
        if (tool.name === 'generate_creative_package') await sendThinkingIndicator('telegram', chatId, 'Building your full creative package... Give me a few minutes!');
        if (['get_search_volume', 'get_keyword_ideas', 'get_keyword_planner_volume', 'get_keyword_planner_ideas'].includes(tool.name)) {
          await sendThinkingIndicator('telegram', chatId, 'Researching keywords... This might take a minute.');
        }
        if (['analyze_serp', 'get_domain_overview', 'find_seo_competitors', 'audit_landing_page', 'audit_seo_page'].includes(tool.name)) {
          await sendThinkingIndicator('telegram', chatId, 'Running analysis... Give me a moment.');
        }

        try {
          if (clientContext.clientId && tool.input) {
            tool.input.clientName = tool.input.clientName || clientContext.clientName || contactName;
          }
          const result = await executeCSATool(tool.name, tool.input);
          const resultJson = JSON.stringify(result);
          toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: resultJson });
          allToolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: resultJson });
          await deliverMediaInline(tool.name, result, 'telegram', chatId);
        } catch (e) {
          log.error('Client tool failed (Telegram)', { tool: tool.name, error: e.message });
          toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify({ error: e.message }), is_error: true });
        }
      }

      messages.push({ role: 'assistant', content: response.raw.content });
      messages.push({ role: 'user', content: toolResults });

      response = await askClaude({
        systemPrompt,
        messages,
        tools: CLIENT_TOOLS,
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 4096,
        workflow: 'client-chat',
      });
    }

    const finalText = response.text || (rounds > 0
      ? `I ran ${toolsSummary.length} steps (${[...new Set(toolsSummary)].join(', ')}). Let me know if you'd like me to go deeper on anything!`
      : 'I\'m here to help! What would you like to work on?');

    // Save rich tool context to history so Sofia remembers what she generated across messages
    if (rounds > 0 && toolsSummary.length > 0) {
      const toolNames = `[Used tools: ${[...new Set(toolsSummary)].join(', ')}]`;
      const deliverables = summarizeToolDeliverables(allToolResults);
      const contextBlock = deliverables ? `${toolNames}\n${deliverables}` : toolNames;
      addToHistory(chatId, 'assistant', `${contextBlock}\n${finalText}`, 'telegram');
    } else {
      addToHistory(chatId, 'assistant', finalText, 'telegram');
    }
    await sendTelegram(finalText, chatId);

    // Append to live conversation log on Google Drive (best effort, non-blocking)
    if (clientContext.clientId) {
      const client = getClient(clientContext.clientId);
      if (client?.conversation_log_doc_id) {
        const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
        const logEntry = `\n[${timestamp}] ${contactName || 'Client'}: ${message}\n[${timestamp}] Sofia: ${finalText}\n`;
        googleDrive.appendToDocument(client.conversation_log_doc_id, logEntry).catch(e =>
          log.warn('Failed to append to conversation log', { error: e.message })
        );
      }
    }
  } catch (error) {
    log.error('Telegram client message handling failed', { chatId, error: error.message, stack: error.stack });
    try {
      // Include error hint so we can diagnose from Telegram logs
      const isApiError = error.message?.includes('401') || error.message?.includes('api_key') || error.message?.includes('authentication');
      const hint = isApiError
        ? ' (API authentication issue — check ANTHROPIC_API_KEY)'
        : ` (${error.message?.substring(0, 80)})`;
      await sendTelegram(`Sorry, I ran into a temporary issue${hint}. Please try again in a moment.`, chatId);
    } catch (e) { /* best effort */ }
  }
}

// --- Leadsie Webhook (completion callback) ---
app.post('/webhook/leadsie', async (req, res) => {
  res.sendStatus(200);

  try {
    const secret = config.LEADSIE_WEBHOOK_SECRET;
    if (secret && req.headers['x-leadsie-secret'] !== secret) {
      log.warn('Leadsie webhook: invalid secret');
      return;
    }

    const { invite_id, status, client_name, granted_accounts } = req.body || {};
    if (!invite_id || status !== 'completed') return;

    log.info('Leadsie onboarding completed', { inviteId: invite_id, clientName: client_name });

    // Find the client linked to this Leadsie invite
    const { default: Database } = await import('better-sqlite3');
    const DB_PATH = process.env.KB_DB_PATH || 'data/knowledge.db';
    const db = new Database(DB_PATH);
    const session = db.prepare('SELECT * FROM onboarding_sessions WHERE leadsie_invite_id = ?').get(invite_id);

    if (session?.client_id) {
      // Update client with granted account credentials (ad accounts, CMS, DNS, CRM)
      const updates = {};
      const grantedPlatforms = [];
      for (const account of (granted_accounts || [])) {
        grantedPlatforms.push(account.platform);

        // Ad accounts
        if (account.platform === 'facebook' && account.account_id) {
          updates.meta_ad_account_id = account.account_id;
        } else if (account.platform === 'google' && account.account_id) {
          updates.google_ads_customer_id = account.account_id;
        } else if (account.platform === 'tiktok' && account.account_id) {
          updates.tiktok_advertiser_id = account.account_id;

        // CMS platforms
        } else if (account.platform === 'wordpress') {
          if (account.site_url) updates.wordpress_url = account.site_url;
          if (account.username) updates.wordpress_username = account.username;
          if (account.access_token || account.app_password) updates.wordpress_app_password = account.access_token || account.app_password;
          updates.cms_platform = 'wordpress';
        } else if (account.platform === 'shopify') {
          if (account.store_url || account.site_url) updates.shopify_store_url = account.store_url || account.site_url;
          if (account.access_token) updates.shopify_access_token = account.access_token;
          updates.cms_platform = 'shopify';

        // DNS
        } else if (account.platform === 'godaddy') {
          if (account.domain) updates.godaddy_domain = account.domain;
          if (account.api_key || account.access_token) updates.godaddy_api_key = account.api_key || account.access_token;

        // CRM
        } else if (account.platform === 'hubspot') {
          if (account.access_token) updates.hubspot_access_token = account.access_token;
        }
      }
      if (Object.keys(updates).length > 0) {
        const { updateClient: updateClientKb } = await import('../services/knowledge-base.js');
        updateClientKb(session.client_id, updates);
      }

      // Notify owner with categorized platform list
      const adPlatforms = grantedPlatforms.filter(p => ['facebook', 'google', 'tiktok'].includes(p));
      const cmsPlatforms = grantedPlatforms.filter(p => ['wordpress', 'shopify'].includes(p));
      const otherPlatforms = grantedPlatforms.filter(p => ['godaddy', 'hubspot', 'mailchimp'].includes(p));

      let notifyMsg = `✅ *${client_name || 'Client'}* completed Leadsie onboarding!\n`;
      if (adPlatforms.length) notifyMsg += `\n📊 *Ad accounts:* ${adPlatforms.join(', ')}`;
      if (cmsPlatforms.length) notifyMsg += `\n🌐 *CMS access:* ${cmsPlatforms.join(', ')} — Sofia can now manage website content & SEO`;
      if (otherPlatforms.length) notifyMsg += `\n🔧 *Other:* ${otherPlatforms.join(', ')}`;
      notifyMsg += '\n\nAll credentials have been saved automatically.';
      await sendWhatsApp(notifyMsg);
    }

    db.close();
  } catch (error) {
    log.error('Leadsie webhook handling failed', { error: error.message });
  }
});

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

  try {
    // Conversational tool-use loop (same architecture as Telegram)
    let response = await askClaude({
      systemPrompt: WHATSAPP_CSA_PROMPT + clientContext,
      messages,
      tools: CSA_TOOLS,
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 4096,
      workflow: 'whatsapp-csa',
    });

    // Handle tool use loop (max 10 rounds to allow multi-step tasks)
    let rounds = 0;
    const toolsSummary = []; // track what tools ran for history context
    const allToolResults = []; // Collect all tool results for persistent history
    while (response.stopReason === 'tool_use' && rounds < 10) {
      rounds++;

      // Send a natural "working on it" message on first tool call
      if (rounds === 1 && response.text) {
        await sendWhatsApp(response.text);
      }

      // Execute all tool calls
      const toolResults = [];
      for (const tool of response.toolUse) {
        log.info('Executing tool', { tool: tool.name, round: rounds });
        toolsSummary.push(tool.name);

        // Send thinking message before expensive tools
        if (tool.name === 'generate_ad_images') await sendThinkingIndicator('whatsapp', ownerChatId, 'Generating your ad images... This might take a minute.');
        if (tool.name === 'generate_ad_video') await sendThinkingIndicator('whatsapp', ownerChatId, 'Creating your video with Sora 2... This will take a few minutes. I\'ll send it as soon as it\'s ready!');
        if (tool.name === 'generate_creative_package') await sendThinkingIndicator('whatsapp', ownerChatId, 'Building your full creative package... Give me a few minutes!');

        try {
          const result = await executeCSATool(tool.name, tool.input);
          const resultJson = JSON.stringify(result);
          toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: resultJson });
          allToolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: resultJson });
          // Deliver generated media inline (images, videos)
          await deliverMediaInline(tool.name, result, 'whatsapp', ownerChatId);
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
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 4096,
        workflow: 'whatsapp-csa',
      });
    }

    // Send final response and save rich context to history
    const ownerFinalText = response.text || `I ran ${rounds} tool steps (${toolsSummary.join(', ')}) but couldn't produce a final answer. Please try again or ask me to summarize what I found.`;

    if (rounds > 0 && toolsSummary.length > 0) {
      const toolNames = `[Used tools: ${[...new Set(toolsSummary)].join(', ')}]`;
      const deliverables = summarizeToolDeliverables(allToolResults);
      const contextBlock = deliverables ? `${toolNames}\n${deliverables}` : toolNames;
      addToHistory(ownerChatId, 'assistant', `${contextBlock}\n${ownerFinalText}`);
    } else {
      addToHistory(ownerChatId, 'assistant', ownerFinalText);
    }
    await sendWhatsApp(ownerFinalText);
  } catch (error) {
    log.error('WhatsApp command loop failed', { error: error.message, stack: error.stack });
    const isRateLimit = error.status === 429 || error.message?.includes('rate_limit');
    const errorMsg = isRateLimit
      ? 'I\'m currently experiencing high demand. Please wait a minute and try again.'
      : 'Something went wrong while processing your request. Please try again.';
    addToHistory(ownerChatId, 'assistant', errorMsg);
    await sendWhatsApp(errorMsg);
  }
}

// --- Client Message Handler (non-owner contacts) ---
async function handleClientMessage(from, message) {
  try {
    // 0. Pre-check for signup token — cancel stale sessions so fresh signups aren't blocked
    const preTokenMatch = message.match(TOKEN_RE_INLINE);
    if (preTokenMatch) {
      const preCheck = await getPendingClientWithFallback(preTokenMatch[1]);
      if (preCheck) {
        // Valid pending signup found — cancel any stale onboarding sessions
        const staleSession = getOnboardingSession(from);
        if (staleSession) {
          updateOnboardingSession(staleSession.id, { status: 'cancelled' });
          log.info('Cancelled stale onboarding session for fresh signup', { from, sessionId: staleSession.id });
        }
      }
    }

    // 1. Check if client has an active onboarding session
    if (hasActiveOnboarding(from)) {
      log.info('Routing to onboarding flow', { from });
      addToHistory(from, 'user', message, 'whatsapp');
      const result = await handleOnboardingMessage(from, message, 'whatsapp');
      if (Array.isArray(result)) {
        for (const msg of result) {
          addToHistory(from, 'assistant', msg, 'whatsapp');
          await sendWhatsApp(msg, from);
        }
      } else if (result) {
        addToHistory(from, 'assistant', result, 'whatsapp');
        await sendWhatsApp(result, from);
      }
      return;
    }

    // 2. Check if this is a NEW person (not a known contact and no completed onboarding)
    let clientContext = getClientContextByPhone(from);
    if (!clientContext) {
      // New person — check for a sign-up token in the message
      let pendingData = null;
      const tokenMatch = message.match(TOKEN_RE_INLINE);
      if (tokenMatch) {
        const found = await getPendingClientWithFallback(tokenMatch[1]);
        if (found) {
          activatePendingClient(found.token, from, 'whatsapp');
          pendingData = found;
          log.info('Activated pending client from token', { token: found.token, from });
        } else {
          // Token already activated on another channel — try cross-channel link
          const linked = tryLinkCrossChannel(tokenMatch[1], from, 'whatsapp');
          if (linked) {
            clientContext = linked;
            log.info('Cross-channel link: client already onboarded on another channel', { from });
            await sendWhatsApp(
              `Hey${linked.contactName ? ` *${linked.contactName}*` : ''}! I see you've already been onboarded on another channel. Great to connect with you here on WhatsApp too! How can I help you today?`,
              from,
            );
            return;
          }
        }
      }

      const lang = pendingData?.language || 'en';
      log.info('New contact detected, auto-starting onboarding via WhatsApp', { from, language: lang });

      if (pendingData && pendingData.name) {
        // Client came from website with form data — personalized welcome + confirmation
        try {
          createContact({ phone: from, name: pendingData.name, email: pendingData.email, channel: 'whatsapp', language: lang });
        } catch (e) { /* might already exist */ }

        // Pre-populate answers with all known form data
        const prefillAnswers = {};
        if (pendingData.name) prefillAnswers.name = pendingData.name;
        if (pendingData.website) prefillAnswers.website = pendingData.website;
        if (pendingData.business_name) prefillAnswers.business_name = pendingData.business_name;
        if (pendingData.business_description) prefillAnswers.business_description = pendingData.business_description;
        if (pendingData.product_service) prefillAnswers.product_service = pendingData.product_service;
        if (pendingData.email) prefillAnswers.email = pendingData.email;

        // Create session with pre-populated data, then override to confirm_details step
        const session = createOnboardingSession(from, 'whatsapp', lang, prefillAnswers);
        const hasFormData = Object.keys(prefillAnswers).length > 1;
        if (hasFormData) {
          updateOnboardingSession(session.id, { currentStep: 'confirm_details' });
        }

        // Send personalized welcome with all form data for confirmation
        const welcome = buildPersonalizedWelcome(pendingData, lang);
        addToHistory(from, 'user', message, 'whatsapp');
        addToHistory(from, 'assistant', welcome, 'whatsapp');
        await sendWhatsApp(welcome, from);
      } else {
        // No pending data — generic onboarding flow
        createOnboardingSession(from, 'whatsapp', lang);
        addToHistory(from, 'user', message, 'whatsapp');
        const result = await handleOnboardingMessage(from, message, 'whatsapp');
        if (Array.isArray(result)) {
          for (const msg of result) {
            addToHistory(from, 'assistant', msg, 'whatsapp');
            await sendWhatsApp(msg, from);
          }
        } else if (result) {
          addToHistory(from, 'assistant', result, 'whatsapp');
          await sendWhatsApp(result, from);
        }
      }

      // Notify owner
      try {
        await sendWhatsApp(`📥 *New client started onboarding via WhatsApp*\nPhone: ${from}${pendingData?.name ? `\nName: ${pendingData.name}` : ''}${pendingData?.plan ? `\nPlan: ${pendingData.plan}` : ''}\nFirst message: "${message.substring(0, 100)}"`);
      } catch (e) { /* best effort */ }
      return;
    }

    // 3. Check daily message limit based on plan
    const limitCheck = checkClientMessageLimit(from);
    if (!limitCheck.allowed) {
      await sendWhatsApp(
        `Hey ${clientContext.contactName || 'there'}! You've reached your daily message limit (${limitCheck.limit} messages on the *${limitCheck.plan.toUpperCase()}* plan). Your limit resets tomorrow.\n\nNeed more? Ask us about upgrading your plan!`,
        from,
      );
      return;
    }

    // 4. Known client — greet by name and use context with full conversation history
    const contactName = clientContext?.contactName;

    // Build rich client context for Sofia
    const contextParts = [];
    if (contactName) contextParts.push(`*Name:* ${contactName}`);
    if (clientContext.clientName) contextParts.push(`*Business:* ${clientContext.clientName}`);
    if (clientContext.industry) contextParts.push(`*Industry:* ${clientContext.industry}`);
    if (clientContext.website) contextParts.push(`*Website:* ${clientContext.website}`);
    if (clientContext.productService) contextParts.push(`*Product/Service:* ${clientContext.productService}`);
    if (clientContext.targetAudience) contextParts.push(`*Target Audience:* ${clientContext.targetAudience}`);
    if (clientContext.location) contextParts.push(`*Location:* ${clientContext.location}`);
    if (clientContext.competitors?.length) contextParts.push(`*Competitors:* ${Array.isArray(clientContext.competitors) ? clientContext.competitors.join(', ') : clientContext.competitors}`);
    if (clientContext.channelsHave) contextParts.push(`*Active Channels:* ${clientContext.channelsHave}`);
    if (clientContext.channelsNeed) contextParts.push(`*Channels Interested In:* ${clientContext.channelsNeed}`);
    if (clientContext.brandVoice) contextParts.push(`*Brand Voice:* ${clientContext.brandVoice}`);

    // Check for cross-channel contacts
    let crossChannelNote = '';
    if (clientContext.clientId) {
      const contacts = getContactsByClientId(clientContext.clientId);
      if (contacts.length > 1) {
        const channels = contacts.map(c => c.channel || 'whatsapp');
        crossChannelNote = `\n\nNOTE: This client is connected on multiple channels: ${channels.join(', ')}. You may reference conversations from other channels if relevant. Current channel: WhatsApp.`;
      }
    }

    const memoryContext = contextParts.length > 0
      ? `\nCLIENT PROFILE:\n${contextParts.join('\n')}`
      : '';

    const systemPrompt = `You are Sofia, a warm and professional Customer Success Agent for a PPC/digital marketing agency. You're chatting with a client via WhatsApp.
${memoryContext}${crossChannelNote}

Your role:
- You REMEMBER this client — greet them by name (${contactName}) naturally, like a real human.
- Reference their business context when relevant (their audience, competitors, channels, etc.)
- Answer questions about their campaigns, performance, and strategy
- When they ask for creatives, images, or videos — USE YOUR TOOLS to generate them. Never just describe what you would create.
- When they ask for keyword research, SEO analysis, competitor ads, or market research — USE YOUR TOOLS immediately.
- Be professional, friendly, and concise — like a trusted team member
- If they ask about specific metrics you don't have, offer to pull a report or have the account manager follow up
- Never share other clients' data or internal cost information
- Keep responses under 500 words
- Use WhatsApp formatting: *bold*, _italic_

CRITICAL RULES — FOLLOW THESE ABOVE ALL ELSE:
- ALWAYS follow through and complete the task. When the client asks you to do something, DO IT using your tools. Deliver actual results.
- NEVER abandon a task to show a generic menu or list of capabilities. If you were working on something, FINISH IT.
- If a follow-up message arrives (like "any success?" or "how's it going?"), CONTINUE the task you were working on — do not restart or change topic.
- NEVER tell the client you don't have clients set up or need configuration. You have tools — use them.
- If a tool fails, explain the issue simply and try an alternative approach. Never give up.

CREATIVE GENERATION PROCESS — FOLLOW THIS STRICTLY:
When the client asks for ads, visuals, creatives, or mockups:
1. Gather a brief — ask the most relevant 2-3 questions based on context (objective, audience, style/mood, references)
2. Once you have enough context, call the generate_ad_images or generate_creative_package tool
3. ALWAYS deliver real images/videos — never substitute with text descriptions`;

    // Client-facing tools — creative generation + research/analysis (no campaign management or cost reports)
    const CLIENT_TOOLS = CSA_TOOLS.filter(t => [
      'generate_ad_images', 'generate_ad_video', 'generate_creative_package',
      'generate_text_ads', 'browse_website',
      'search_ad_library', 'search_facebook_pages', 'get_page_ads',
      'get_search_volume', 'get_keyword_ideas',
      'get_keyword_planner_volume', 'get_keyword_planner_ideas',
      'get_domain_overview', 'analyze_serp', 'find_seo_competitors',
      'get_keyword_gap', 'audit_landing_page', 'audit_seo_page',
      'search_google_ads_transparency',
      'full_seo_audit', 'generate_blog_post', 'fix_meta_tags',
      'plan_content_calendar', 'list_wp_content', 'generate_schema_markup',
    ].includes(t.name));

    // Load conversation history (cross-channel if available, otherwise single-channel)
    let history;
    if (clientContext.clientId) {
      const contacts = getContactsByClientId(clientContext.clientId);
      if (contacts.length > 1) {
        history = getCrossChannelHistory(clientContext.clientId, MAX_HISTORY_MESSAGES * 2);
      } else {
        history = getHistory(from);
      }
    } else {
      history = getHistory(from);
    }
    addToHistory(from, 'user', message, 'whatsapp');

    const messages = [...history, { role: 'user', content: message }];

    // Send thinking indicator so client knows Sofia is working
    await sendThinkingIndicator('whatsapp', from, 'Give me a moment...');

    let response = await askClaude({
      systemPrompt,
      messages,
      tools: CLIENT_TOOLS,
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 4096,
      workflow: 'client-chat',
    });

    // Tool-use loop (max 10 rounds to allow multi-step tasks like keyword research)
    let rounds = 0;
    const toolsSummary = [];
    const allToolResults = []; // Collect all tool results for persistent history
    while (response.stopReason === 'tool_use' && rounds < 10) {
      rounds++;

      if (rounds === 1 && response.text) {
        await sendWhatsApp(response.text, from);
      }

      const toolResults = [];
      for (const tool of response.toolUse) {
        log.info('Client tool execution', { tool: tool.name, client: contactName, round: rounds });
        toolsSummary.push(tool.name);

        // Send thinking messages for slow tools
        if (tool.name === 'generate_ad_images') await sendThinkingIndicator('whatsapp', from, 'Generating your ad images... This might take a minute.');
        if (tool.name === 'generate_ad_video') await sendThinkingIndicator('whatsapp', from, 'Creating your video... This will take a few minutes. I\'ll send it as soon as it\'s ready!');
        if (tool.name === 'generate_creative_package') await sendThinkingIndicator('whatsapp', from, 'Building your full creative package... Give me a few minutes!');
        if (['get_search_volume', 'get_keyword_ideas', 'get_keyword_planner_volume', 'get_keyword_planner_ideas'].includes(tool.name)) {
          await sendThinkingIndicator('whatsapp', from, 'Researching keywords... This might take a minute.');
        }
        if (['analyze_serp', 'get_domain_overview', 'find_seo_competitors', 'audit_landing_page', 'audit_seo_page'].includes(tool.name)) {
          await sendThinkingIndicator('whatsapp', from, 'Running analysis... Give me a moment.');
        }

        try {
          // Inject clientId for cost tracking
          if (clientContext.clientId && tool.input) {
            tool.input.clientName = tool.input.clientName || clientContext.clientName || contactName;
          }
          const result = await executeCSATool(tool.name, tool.input);
          const resultJson = JSON.stringify(result);
          toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: resultJson });
          allToolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: resultJson });
          // Deliver generated media (images/videos) inline
          await deliverMediaInline(tool.name, result, 'whatsapp', from);
        } catch (e) {
          log.error('Client tool failed', { tool: tool.name, error: e.message });
          toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify({ error: e.message }), is_error: true });
        }
      }

      messages.push({ role: 'assistant', content: response.raw.content });
      messages.push({ role: 'user', content: toolResults });

      response = await askClaude({
        systemPrompt,
        messages,
        tools: CLIENT_TOOLS,
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 4096,
        workflow: 'client-chat',
      });
    }

    // Send final response
    const finalText = response.text || (rounds > 0
      ? `I ran ${toolsSummary.length} steps (${[...new Set(toolsSummary)].join(', ')}). Let me know if you'd like me to go deeper on anything!`
      : 'I\'m here to help! What would you like to work on?');

    // Save rich tool context to history so Sofia remembers what she generated across messages
    if (rounds > 0 && toolsSummary.length > 0) {
      const toolNames = `[Used tools: ${[...new Set(toolsSummary)].join(', ')}]`;
      const deliverables = summarizeToolDeliverables(allToolResults);
      const contextBlock = deliverables ? `${toolNames}\n${deliverables}` : toolNames;
      addToHistory(from, 'assistant', `${contextBlock}\n${finalText}`, 'whatsapp');
    } else {
      addToHistory(from, 'assistant', finalText, 'whatsapp');
    }
    await sendWhatsApp(finalText, from);

    // Append to live conversation log on Google Drive (best effort, non-blocking)
    if (clientContext.clientId) {
      const client = getClient(clientContext.clientId);
      if (client?.conversation_log_doc_id) {
        const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
        const logEntry = `\n[${timestamp}] ${contactName || 'Client'}: ${message}\n[${timestamp}] Sofia: ${finalText}\n`;
        googleDrive.appendToDocument(client.conversation_log_doc_id, logEntry).catch(e =>
          log.warn('Failed to append to conversation log', { error: e.message })
        );
      }
    }
  } catch (error) {
    log.error('Client message handling failed', { from, error: error.message, stack: error.stack });
    try {
      await sendWhatsApp('Thank you for your message. Our team will get back to you shortly.', from);
    } catch (e) { /* best effort */ }
  }
}

// --- WhatsApp Media Upload Handler ---
async function handleMediaUpload(from, mediaType, media, caption) {
  try {
    // Download media from WhatsApp servers
    const mediaId = media.id;
    const mediaUrl = await getWhatsAppMediaUrl(mediaId);
    if (!mediaUrl) {
      return sendWhatsApp('Could not retrieve the file. Please try again.');
    }

    const mediaData = await downloadWhatsAppMedia(mediaUrl);
    if (!mediaData) {
      return sendWhatsApp('Could not download the file. Please try again.');
    }

    // Determine the client from caption (e.g. "for ClientName" or "ClientName brand guide")
    let clientName = null;
    let folderType = 'brand_assets'; // default folder
    if (caption) {
      const forMatch = caption.match(/(?:for|para|cliente?)\s+["']?([^"'\n,]+)/i);
      if (forMatch) clientName = forMatch[1].trim();

      if (/brand|marca|logo|guideline|identidade/i.test(caption)) folderType = 'brand_assets';
      else if (/creative|criativo|mockup|ad/i.test(caption)) folderType = 'creatives';
      else if (/report|relatório/i.test(caption)) folderType = 'reports';
      else if (/competitor|concorr/i.test(caption)) folderType = 'competitor_research';
    }

    const client = clientName ? getClient(clientName) : null;
    const folderId = client?.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;

    if (!folderId) {
      return sendWhatsApp('Google Drive not configured. Set GOOGLE_DRIVE_ROOT_FOLDER_ID in .env to enable file storage.');
    }

    // Determine file name
    const ext = getExtFromMime(media.mime_type);
    const fileName = media.filename || `${mediaType}_${Date.now()}${ext}`;

    // Upload to Google Drive
    const { Readable } = await import('stream');
    const stream = new Readable();
    stream.push(Buffer.from(mediaData));
    stream.push(null);

    const uploaded = await googleDrive.uploadFile(
      fileName,
      stream,
      media.mime_type,
      folderId,
    );

    if (uploaded) {
      const msg = [
        `✅ *File saved to Google Drive*`,
        `📁 ${fileName}`,
        client ? `📋 Client: ${client.name}` : '',
        uploaded.webViewLink ? `🔗 ${uploaded.webViewLink}` : '',
      ].filter(Boolean).join('\n');
      await sendWhatsApp(msg);
    } else {
      await sendWhatsApp('File received but Google Drive upload failed. Check Drive configuration.');
    }
  } catch (error) {
    log.error('Media upload failed', { error: error.message, mediaType });
    await sendWhatsApp(`Could not save file: ${error.message}`);
  }
}

async function getWhatsAppMediaUrl(mediaId) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` } }
    );
    return res.data?.url;
  } catch (e) {
    log.error('Failed to get media URL', { error: e.message });
    return null;
  }
}

async function downloadWhatsAppMedia(url) {
  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` },
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    return res.data;
  } catch (e) {
    log.error('Failed to download media', { error: e.message });
    return null;
  }
}

function getExtFromMime(mimeType) {
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/3gpp': '.3gp',
    'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/aac': '.aac',
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  };
  return map[mimeType] || '';
}

async function handleTelegramMediaUpload(chatId, mediaType, fileObj, caption) {
  try {
    const botToken = config.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return sendTelegram('Telegram bot token not configured.', chatId);
    }

    // Get file path from Telegram
    const fileRes = await axios.get(`https://api.telegram.org/bot${botToken}/getFile`, {
      params: { file_id: fileObj.file_id },
    });
    const filePath = fileRes.data?.result?.file_path;
    if (!filePath) {
      return sendTelegram('Could not retrieve the file. Please try again.', chatId);
    }

    // Download the file
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    const fileData = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 });
    if (!fileData.data) {
      return sendTelegram('Could not download the file. Please try again.', chatId);
    }

    // Determine client and folder from caption
    let clientName = null;
    let folderType = 'brand_assets';
    if (caption) {
      const forMatch = caption.match(/(?:for|para|cliente?)\s+["']?([^"'\n,]+)/i);
      if (forMatch) clientName = forMatch[1].trim();

      if (/brand|marca|logo|guideline|identidade/i.test(caption)) folderType = 'brand_assets';
      else if (/creative|criativo|mockup|ad/i.test(caption)) folderType = 'creatives';
      else if (/report|relatório/i.test(caption)) folderType = 'reports';
      else if (/competitor|concorr/i.test(caption)) folderType = 'competitor_research';
    }

    const client = clientName ? getClient(clientName) : null;
    const folderId = client?.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;

    if (!folderId) {
      return sendTelegram('Google Drive not configured. Set GOOGLE_DRIVE_ROOT_FOLDER_ID in .env.', chatId);
    }

    const mimeType = fileObj.mime_type || 'application/octet-stream';
    const ext = getExtFromMime(mimeType);
    const fileName = fileObj.file_name || `${mediaType}_${Date.now()}${ext}`;

    const { Readable } = await import('stream');
    const stream = new Readable();
    stream.push(Buffer.from(fileData.data));
    stream.push(null);

    const uploaded = await googleDrive.uploadFile(fileName, stream, mimeType, folderId);

    if (uploaded) {
      const msg = [
        `✅ <b>File saved to Google Drive</b>`,
        `📁 ${fileName}`,
        client ? `📋 Client: ${client.name}` : '',
        uploaded.webViewLink ? `🔗 ${uploaded.webViewLink}` : '',
      ].filter(Boolean).join('\n');
      await sendTelegram(msg, chatId);
    } else {
      await sendTelegram('File received but Google Drive upload failed. Check Drive configuration.', chatId);
    }
  } catch (error) {
    log.error('Telegram media upload failed', { error: error.message, mediaType });
    await sendTelegram(`Could not save file: ${error.message}`, chatId);
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
  app.listen(p, async () => {
    log.info(`WhatsApp server listening on port ${p}`);
    console.log(`Webhook server running on port ${p}`);
    console.log(`WhatsApp webhook: http://your-server:${p}/webhook/whatsapp`);
    console.log(`Telegram webhook: http://your-server:${p}/webhook/telegram`);
    console.log(`Leadsie webhook: http://your-server:${p}/webhook/leadsie`);
    console.log(`Client init API: http://your-server:${p}/api/client-init`);
    console.log(`Health check: http://your-server:${p}/health`);

    // Fetch Telegram bot username if not configured
    if (!telegramBotUsername && config.TELEGRAM_BOT_TOKEN) {
      try {
        const me = await getTelegramMe();
        telegramBotUsername = me.username;
        log.info('Telegram bot username fetched', { username: telegramBotUsername });
        console.log(`Telegram bot: @${telegramBotUsername}`);
      } catch (e) {
        log.warn('Could not fetch Telegram bot username', { error: e.message });
      }
    }
  });
  return app;
}

// CLI entry point
if (process.argv[1]?.endsWith('whatsapp-server.js')) {
  startServer();
}

export default { startServer, app };
