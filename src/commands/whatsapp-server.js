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
import * as pagespeed from '../api/pagespeed.js';
import * as googleSheets from '../api/google-sheets.js';
import * as keywordPlanner from '../api/google-keyword-planner.js';
import * as dataforseo from '../api/dataforseo.js';
import * as openaiMedia from '../api/openai-media.js';
import * as googleSlides from '../api/google-slides.js';
import * as creativeEngine from '../services/creative-engine.js';
import * as webScraper from '../api/web-scraper.js';
import * as leadsie from '../api/leadsie.js';
import * as googleDrive from '../api/google-drive.js';
import { SYSTEM_PROMPTS } from '../prompts/templates.js';
import axios from 'axios';
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
    description: 'Generate ad creative images using DALL-E 3 in platform-specific dimensions (feed, square, story formats). Creates professional advertising visuals tailored to the brand and concept.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, platform: { type: 'string', enum: ['meta', 'instagram', 'google', 'tiktok'], description: 'Platform for proper sizing' }, concept: { type: 'string', description: 'What the image should show or convey' }, product: { type: 'string', description: 'Product or service being advertised' }, mood: { type: 'string', description: 'Mood/tone (e.g. professional, fun, luxury)' }, formats: { type: 'string', description: 'Comma-separated format keys: meta_feed, meta_square, meta_story, instagram_feed, instagram_story, google_display, tiktok (optional, uses platform defaults)' } }, required: ['clientName', 'platform', 'concept'] },
  },
  {
    name: 'generate_ad_video',
    description: 'Generate a short ad video using Sora 2 AI. Creates a professional advertising video clip (4-12 seconds) in the right aspect ratio for the platform.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, concept: { type: 'string', description: 'Video concept — what should happen in the video' }, platform: { type: 'string', enum: ['meta_feed', 'meta_story', 'instagram_feed', 'instagram_story', 'tiktok', 'youtube', 'google_display'], description: 'Platform/format for aspect ratio' }, duration: { type: 'number', description: 'Duration in seconds (4, 8, or 12)' }, offer: { type: 'string', description: 'Product/offer to feature (optional)' } }, required: ['clientName', 'concept'] },
  },
  {
    name: 'generate_creative_package',
    description: 'Generate a FULL creative package: text ads + ad images + optional video, all assembled into a beautiful Google Slides presentation deck for client approval. This is the all-in-one creative tool — use it when the user wants a complete set of creatives ready for review.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, platform: { type: 'string', enum: ['meta', 'instagram', 'google', 'tiktok'], description: 'Primary platform' }, campaignName: { type: 'string', description: 'Campaign name for the deck' }, objective: { type: 'string', description: 'Campaign objective' }, audience: { type: 'string', description: 'Target audience' }, offer: { type: 'string', description: 'Offer/promotion' }, concept: { type: 'string', description: 'Creative concept/theme' }, textVariations: { type: 'number', description: 'Number of text ad variations (default: 5)' }, generateImages: { type: 'boolean', description: 'Generate images with DALL-E 3 (default: true)' }, generateVideo: { type: 'boolean', description: 'Generate video with Sora 2 (default: false)' } }, required: ['clientName', 'platform'] },
  },
  // --- Web Browsing ---
  {
    name: 'browse_website',
    description: 'Visit a website and extract its content, headings, images, brand colors, and metadata. Perfect for researching competitor websites, getting creative inspiration, analyzing landing pages, or understanding a brand before creating ads. Works on any public URL.',
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'URL to visit (e.g. "https://example.com" or "example.com")' }, purpose: { type: 'string', description: 'Why you\'re visiting: "creative_inspiration", "competitor_research", "brand_analysis", or "general"' } }, required: ['url'] },
  },
  // --- Client Onboarding (Leadsie) ---
  {
    name: 'create_onboarding_link',
    description: 'Create a Leadsie invite link to send to a new client so they can grant access to their ad accounts (Meta, Google Ads, TikTok) in one click. Sofia will send the link directly via chat.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client business name' }, clientEmail: { type: 'string', description: 'Client email (optional)' }, platforms: { type: 'string', description: 'Comma-separated platforms: facebook, google, tiktok (default: facebook,google)' } }, required: ['clientName'] },
  },
  {
    name: 'check_onboarding_status',
    description: 'Check whether a client has completed their Leadsie onboarding (granted ad account access).',
    input_schema: { type: 'object', properties: { inviteId: { type: 'string', description: 'Leadsie invite ID to check' } }, required: ['inviteId'] },
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
        model: 'claude-sonnet-4-5-20250929',
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
      return { clientName: toolInput.clientName, platform: toolInput.platform, ads, totalVariations: ads.length };
    }
    case 'generate_ad_images': {
      if (!config.OPENAI_API_KEY) return { error: 'OPENAI_API_KEY not configured. Set it in .env to enable image generation.' };
      const client = getClient(toolInput.clientName);

      // Generate the image prompt using AI
      const imagePrompt = await creativeEngine.generateImagePrompt({
        clientName: toolInput.clientName,
        platform: toolInput.platform,
        product: toolInput.product,
        concept: toolInput.concept,
        audience: client?.target_audience,
        mood: toolInput.mood,
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

      return {
        clientName: toolInput.clientName,
        platform: toolInput.platform,
        concept: toolInput.concept,
        imagePrompt,
        images: images.map(img => ({
          format: img.format,
          label: img.dimensions?.label || img.format,
          url: img.url,
          error: img.error,
        })),
        totalGenerated: images.filter(i => !i.error).length,
      };
    }
    case 'generate_ad_video': {
      if (!config.OPENAI_API_KEY) return { error: 'OPENAI_API_KEY not configured. Set it in .env to enable video generation.' };
      const client = getClient(toolInput.clientName);

      const videoPrompt = `Professional advertising video for ${toolInput.clientName}. ${toolInput.concept}. ${toolInput.offer ? `Featuring: ${toolInput.offer}.` : ''} High production quality, smooth camera movement, cinematic lighting. No text overlays.`;

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
        textVariations: toolInput.textVariations,
        generateImages: toolInput.generateImages !== false,
        generateVideo: toolInput.generateVideo || false,
        buildDeck: true,
      });

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
        status: 'awaiting_approval',
        message: pkg.presentation?.url
          ? `Creative deck ready for review: ${pkg.presentation.url}`
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

    // --- Leadsie Onboarding ---
    case 'create_onboarding_link': {
      const platforms = toolInput.platforms
        ? toolInput.platforms.split(',').map(p => p.trim())
        : ['facebook', 'google'];
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

  try {
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
    const toolsSummary = [];
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
    } else {
      const msg = `I ran ${rounds} tool steps (${toolsSummary.join(', ')}) but couldn't produce a final answer. Please try again or ask me to summarize what I found.`;
      addToHistory(chatId, 'assistant', msg);
      await reply(msg);
    }
  } catch (error) {
    log.error('Telegram command loop failed', { error: error.message, stack: error.stack });
    const errorMsg = `Something went wrong while processing your request: ${error.message}. Please try again.`;
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

  try {
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
    const toolsSummary = []; // track what tools ran for history context
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
    } else {
      // If no final text (e.g. hit max rounds), let user know
      const msg = `I ran ${rounds} tool steps (${toolsSummary.join(', ')}) but couldn't produce a final answer. Please try again or ask me to summarize what I found.`;
      addToHistory(ownerChatId, 'assistant', msg);
      await sendWhatsApp(msg);
    }
  } catch (error) {
    log.error('WhatsApp command loop failed', { error: error.message, stack: error.stack });
    const errorMsg = `Something went wrong while processing your request: ${error.message}. Please try again.`;
    addToHistory(ownerChatId, 'assistant', errorMsg);
    await sendWhatsApp(errorMsg);
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
