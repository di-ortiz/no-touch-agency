/**
 * CSA Tool Executor — executes Sofia's 60+ tools.
 * Extracted from whatsapp-server.js for maintainability.
 */
import { getAllClients, getClient, buildClientContext, updateClient } from '../services/knowledge-base.js';
import { initiateOnboarding } from '../services/client-onboarding-flow.js';
import { getCostSummary, getAuditLog } from '../services/cost-tracker.js';
import { runMorningBriefing } from '../workflows/morning-briefing.js';
import { runDailyMonitor } from '../workflows/daily-monitor.js';
import { runTaskMonitor, generateDailyStandup } from '../workflows/clickup-monitor.js';
import * as clickup from '../api/clickup.js';
import { generateCampaignBrief } from '../workflows/campaign-brief.js';
import { generateCreatives } from '../workflows/creative-generation.js';
import { generateWeeklyReport } from '../workflows/weekly-report.js';
import { generateMonthlyReview } from '../workflows/monthly-review.js';
import { analyzeCompetitors } from '../workflows/competitor-monitor.js';
import { pullCompetitorCreatives } from '../workflows/competitor-creatives.js';
import { generateMediaPlan } from '../workflows/media-plan.js';
import * as metaAds from '../api/meta-ads.js';
import * as metaAdLibrary from '../api/meta-ad-library.js';
import * as googleAds from '../api/google-ads.js';
import * as pagespeed from '../api/pagespeed.js';
import * as googleSheets from '../api/google-sheets.js';
import * as keywordPlanner from '../api/google-keyword-planner.js';
import * as dataforseo from '../api/dataforseo.js';
import * as openaiMedia from '../api/openai-media.js';
import * as imageRouter from '../api/image-router.js';
import * as geminiApi from '../api/gemini.js';
import * as creativeEngine from '../services/creative-engine.js';
import * as webScraper from '../api/web-scraper.js';
import * as leadsie from '../api/leadsie.js';
import * as firecrawlApi from '../api/firecrawl.js';
import * as seoEngine from '../services/seo-engine.js';
import * as googleDrive from '../api/google-drive.js';
import * as googleAnalytics from '../api/google-analytics.js';
import * as googleSearchConsole from '../api/google-search-console.js';
import * as googleTransparency from '../api/google-transparency.js';
import * as presentationBuilder from '../services/presentation-builder.js';
import * as reportBuilder from '../services/report-builder.js';
import * as chartBuilderService from '../services/chart-builder.js';
import * as campaignRecord from '../services/campaign-record.js';
import * as agencyAnalytics from '../api/agency-analytics.js';
import * as brandDNA from '../brand-dna.js';
import * as klingApi from '../api/kling.js';
import * as falApi from '../api/fal.js';
import * as creativeRenderer from '../creative-renderer.js';
import { pendingApprovals, landingPageStore, getPublicUrl, SLOW_TOOLS, SLOW_TOOL_TIMEOUT_MS, DEFAULT_TOOL_TIMEOUT_MS } from './helpers.js';
import crypto from 'crypto';
import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';

const log = logger.child({ module: 'csa-tool-executor' });

export async function executeCSAToolWithTimeout(toolName, toolInput) {
  const timeoutMs = SLOW_TOOLS.has(toolName) ? SLOW_TOOL_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS;
  return Promise.race([
    executeCSATool(toolName, toolInput),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${timeoutMs / 1000}s`)), timeoutMs)
    ),
  ]);
}

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
      try {
        const spaceId = config.CLICKUP_PPC_SPACE_ID;
        let tasksData;
        if (spaceId) {
          tasksData = await clickup.getOverdueTasks(spaceId);
        } else {
          // Fall back to team-level query (all spaces) when no space ID configured
          const result = await clickup.getTeamTasks({ includeClosed: false });
          const now = Date.now();
          const filtered = (result.tasks || []).filter(t => t.due_date && parseInt(t.due_date) < now);
          tasksData = { tasks: filtered };
        }
        const overdueTasks = tasksData.tasks || [];
        const now = Date.now();
        return {
          overdue: overdueTasks.length,
          tasks: overdueTasks.map(t => ({
            id: t.id,
            name: t.name,
            status: t.status?.status,
            assignees: (t.assignees || []).map(a => a.username || a.email),
            dueDate: t.due_date ? new Date(parseInt(t.due_date)).toISOString().split('T')[0] : null,
            daysOverdue: t.due_date ? Math.floor((now - parseInt(t.due_date)) / (1000 * 60 * 60 * 24)) : 0,
            url: t.url,
          })),
        };
      } catch (e) {
        const is401 = e.message?.includes('401') || e.response?.status === 401;
        return { error: is401
          ? 'ClickUp API authentication failed (401). The API token may be expired or invalid. Tell the owner to update the CLICKUP_API_TOKEN in Railway environment variables.'
          : `ClickUp API error: ${e.message}` };
      }
    }
    case 'get_clickup_tasks': {
      try {
        const queryOpts = {
          includeClosed: toolInput.includeClosed || false,
        };
        if (toolInput.statuses) queryOpts.statuses = toolInput.statuses;
        if (toolInput.tags) queryOpts.tags = toolInput.tags;
        if (toolInput.listId) queryOpts.listIds = [toolInput.listId];

        if (toolInput.assigneeName) {
          const members = await clickup.getMembers();
          const needle = toolInput.assigneeName.toLowerCase();
          const match = members.find(m =>
            (m.username || '').toLowerCase().includes(needle) ||
            (m.email || '').toLowerCase().includes(needle) ||
            (m.initials || '').toLowerCase().includes(needle)
          );
          if (match) {
            queryOpts.assignees = [match.id];
          } else {
            return { error: `No team member found matching "${toolInput.assigneeName}". Available members: ${members.map(m => m.username || m.email).join(', ')}` };
          }
        }

        const result = await clickup.getTeamTasks(queryOpts);
        const tasks = (result.tasks || []).map(t => ({
          id: t.id,
          name: t.name,
          status: t.status?.status,
          priority: t.priority?.priority,
          assignees: (t.assignees || []).map(a => a.username || a.email),
          dueDate: t.due_date ? new Date(parseInt(t.due_date)).toISOString().split('T')[0] : null,
          tags: (t.tags || []).map(tag => tag.name),
          list: t.list?.name,
          folder: t.folder?.name,
          url: t.url,
        }));
        return { totalTasks: tasks.length, tasks, ...(toolInput.assigneeName && { filteredBy: toolInput.assigneeName }) };
      } catch (e) {
        const is401 = e.message?.includes('401') || e.response?.status === 401;
        return { error: is401
          ? 'ClickUp API authentication failed (401). The API token may be expired or invalid. Tell the owner to update the CLICKUP_API_TOKEN in Railway environment variables.'
          : `ClickUp API error: ${e.message}` };
      }
    }
    case 'get_clickup_task': {
      try {
        const task = await clickup.getTask(toolInput.taskId);
        return {
          id: task.id,
          name: task.name,
          description: task.description ? task.description.slice(0, 3000) : null,
          status: task.status?.status,
          priority: task.priority?.priority,
          assignees: (task.assignees || []).map(a => ({ name: a.username, email: a.email })),
          creator: task.creator?.username,
          dueDate: task.due_date ? new Date(parseInt(task.due_date)).toISOString().split('T')[0] : null,
          startDate: task.start_date ? new Date(parseInt(task.start_date)).toISOString().split('T')[0] : null,
          timeEstimate: task.time_estimate,
          tags: (task.tags || []).map(tag => tag.name),
          list: task.list?.name,
          folder: task.folder?.name,
          space: task.space?.id,
          url: task.url,
          subtasks: (task.subtasks || []).map(s => ({ id: s.id, name: s.name, status: s.status?.status })),
          customFields: (task.custom_fields || []).filter(f => f.value).map(f => ({ name: f.name, value: f.value })),
        };
      } catch (e) {
        const is401 = e.message?.includes('401') || e.response?.status === 401;
        return { error: is401
          ? 'ClickUp API authentication failed (401). The API token may be expired or invalid. Tell the owner to update the CLICKUP_API_TOKEN in Railway environment variables.'
          : `ClickUp API error: ${e.message}` };
      }
    }
    case 'get_clickup_workspace': {
      try {
        if (toolInput.folderId) {
          const result = await clickup.getLists(toolInput.folderId);
          return { folderId: toolInput.folderId, lists: (result.lists || []).map(l => ({ id: l.id, name: l.name, taskCount: l.task_count })) };
        }
        if (toolInput.spaceId) {
          const result = await clickup.getFolders(toolInput.spaceId);
          return { spaceId: toolInput.spaceId, folders: (result.folders || []).map(f => ({ id: f.id, name: f.name, lists: (f.lists || []).map(l => ({ id: l.id, name: l.name, taskCount: l.task_count })) })) };
        }
        const result = await clickup.getSpaces();
        return { spaces: (result.spaces || []).map(s => ({ id: s.id, name: s.name, memberCount: s.members?.length || 0 })) };
      } catch (e) {
        const is401 = e.message?.includes('401') || e.response?.status === 401;
        return { error: is401
          ? 'ClickUp API authentication failed (401). The API token may be expired or invalid. Tell the owner to update the CLICKUP_API_TOKEN in Railway environment variables.'
          : `ClickUp API error: ${e.message}` };
      }
    }
    case 'create_clickup_task': {
      try {
        const taskData = { name: toolInput.name };
        if (toolInput.description) taskData.markdown_description = toolInput.description;
        if (toolInput.priority) taskData.priority = toolInput.priority;
        if (toolInput.tags) taskData.tags = toolInput.tags;
        if (toolInput.dueDate) taskData.due_date = new Date(toolInput.dueDate).getTime();

        if (toolInput.assigneeName) {
          const members = await clickup.getMembers();
          const needle = toolInput.assigneeName.toLowerCase();
          const match = members.find(m =>
            (m.username || '').toLowerCase().includes(needle) ||
            (m.email || '').toLowerCase().includes(needle)
          );
          if (match) taskData.assignees = [match.id];
        }

        const created = await clickup.createTask(toolInput.listId, taskData);
        return { id: created.id, name: created.name, url: created.url, status: 'created', message: `Task "${created.name}" created in ClickUp.` };
      } catch (e) {
        const is401 = e.message?.includes('401') || e.response?.status === 401;
        return { error: is401
          ? 'ClickUp API authentication failed (401). The API token may be expired or invalid. Tell the owner to update the CLICKUP_API_TOKEN in Railway environment variables.'
          : `ClickUp API error: ${e.message}` };
      }
    }
    case 'update_clickup_task': {
      try {
        const updates = {};
        if (toolInput.name) updates.name = toolInput.name;
        if (toolInput.status) updates.status = toolInput.status;
        if (toolInput.priority) updates.priority = toolInput.priority;
        if (toolInput.dueDate) updates.due_date = new Date(toolInput.dueDate).getTime();

        if (toolInput.assigneeName) {
          const members = await clickup.getMembers();
          const needle = toolInput.assigneeName.toLowerCase();
          const match = members.find(m =>
            (m.username || '').toLowerCase().includes(needle) ||
            (m.email || '').toLowerCase().includes(needle)
          );
          if (match) updates.assignees = { add: [match.id] };
        }

        if (Object.keys(updates).length > 0) {
          await clickup.updateTask(toolInput.taskId, updates);
        }

        if (toolInput.comment) {
          await clickup.addComment(toolInput.taskId, toolInput.comment);
        }

        return { taskId: toolInput.taskId, updated: Object.keys(updates), commentAdded: !!toolInput.comment, message: `Task ${toolInput.taskId} updated.` };
      } catch (e) {
        const is401 = e.message?.includes('401') || e.response?.status === 401;
        return { error: is401
          ? 'ClickUp API authentication failed (401). The API token may be expired or invalid. Tell the owner to update the CLICKUP_API_TOKEN in Railway environment variables.'
          : `ClickUp API error: ${e.message}` };
      }
    }
    case 'run_morning_briefing': {
      await runMorningBriefing();
      return { status: 'briefing_generated' };
    }
    case 'get_daily_standup': {
      try {
        const standup = await generateDailyStandup();
        return standup || { status: 'standup_generated' };
      } catch (e) {
        const is401 = e.message?.includes('401') || e.response?.status === 401;
        return { error: is401
          ? 'ClickUp API authentication failed (401). The API token may be expired or invalid. Tell the owner to update the CLICKUP_API_TOKEN in Railway environment variables.'
          : `ClickUp standup error: ${e.message}` };
      }
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
      const folderId = client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;

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

      let spreadsheetUrl = null;
      let spreadsheetId = null;
      try {
        const result = await googleSheets.createContentCalendar({
          clientName: toolInput.clientName,
          month,
          posts,
          folderId,
        });
        spreadsheetUrl = result.url;
        spreadsheetId = result.spreadsheetId;
      } catch (sheetErr) {
        log.warn('Google Sheets calendar creation failed, returning data inline', { error: sheetErr.message });
      }

      return { clientName: toolInput.clientName, month, totalPosts: posts.length, platforms, posts, spreadsheetUrl, spreadsheetId, ...((!spreadsheetUrl) && { note: 'Calendar data generated successfully. Google Sheets export was unavailable — present the calendar data directly to the user in a formatted message.' }) };
    }
    // --- PDF Report Generator ---
    case 'generate_pdf_report': {
      const { generatePdfReport } = await import('../generators/pdf-report.js');
      const client = getClient(toolInput.clientName);

      // Parse data — accept both JSON string and plain text
      let reportData = toolInput.data;
      try {
        reportData = JSON.parse(toolInput.data);
      } catch {
        // Not JSON — pass as string, Claude will handle it
      }

      // Parse imageUrls — accept comma-separated string or array
      const imageUrls = toolInput.imageUrls
        ? (typeof toolInput.imageUrls === 'string' ? toolInput.imageUrls.split(',').map(u => u.trim()).filter(Boolean) : toolInput.imageUrls)
        : [];

      const result = await generatePdfReport({
        type: toolInput.type,
        data: reportData,
        clientName: toolInput.clientName,
        imageUrls,
        customPrompt: toolInput.customPrompt,
        clientId: client?.id,
      });

      return result;
    }

    // --- Report Export ---
    case 'export_report_to_sheet': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found.` };
      const folderId = client.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;

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

      // Google Sheets now throws on errors instead of returning null
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
      let sheetError = null;
      try {
        const client = getClient(toolInput.clientName);
        const folderId = client?.drive_creatives_folder_id || client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
        const sheet = await campaignRecord.createTextAdsRecord({
          clientName: toolInput.clientName,
          platform: toolInput.platform,
          ads,
          folderId,
        });
        sheetUrl = sheet?.url || null;
      } catch (e) {
        log.error('Failed to create text ads record sheet', { error: e.message });
        sheetError = e.message;
      }

      return { clientName: toolInput.clientName, platform: toolInput.platform, ads, totalVariations: ads.length, sheetUrl, ...(sheetError && { sheetError }) };
    }
    case 'generate_ad_images': {
      const providerStatus = imageRouter.getProviderStatus();
      const anyConfigured = providerStatus.dalle.configured || providerStatus.fal.configured || providerStatus.gemini.configured || providerStatus.kimi.configured;
      if (!anyConfigured) return { error: 'No image generation providers configured. Set at least one of OPENAI_API_KEY, FAL_API_KEY, GEMINI_API_KEY, or KIMI_API_KEY in .env.' };
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

      // Quality mode: 'multi' fires all providers + Claude Vision scoring, 'single' uses sequential fallback
      const qualityMode = toolInput.qualityMode || 'multi';
      let images;

      if (qualityMode === 'multi') {
        // Multi-candidate: generate from all providers, score with Claude Vision, pick best
        const { generateAndValidate } = await import('../services/creative-quality-validator.js');
        const { loadBrandDNA } = await import('../brand-dna.js');
        const brandDNA = client ? loadBrandDNA(client.id) : null;
        const brandGuidelines = {
          name: toolInput.clientName,
          colors: toolInput.brandColors || client?.brand_colors || brandDNA?.primary_colors,
          voice: client?.brand_voice || brandDNA?.brand_voice,
          industry: client?.industry || brandDNA?.industry,
        };

        const platformSpecs = creativeEngine.PLATFORM_SPECS || creativeEngine.default?.PLATFORM_SPECS || {};
        const targetFormats = formats || (platformSpecs[toolInput.platform]?.imageFormats) || ['general'];
        const qualityResults = await Promise.allSettled(
          targetFormats.map(format =>
            generateAndValidate({
              prompt: `${imagePrompt}. Professional advertising quality for ${format.replace(/_/g, ' ')} format. CRITICAL: No text, no words, no letters, no numbers, no typography, no captions, no screens, no monitors, no dashboards, no charts, no UI elements. Pure visual scene only — clean background with space for text overlay.`,
              format,
              clientId: client?.id,
              brandGuidelines,
              qualityThreshold: 70,
              maxRetries: 1,
              workflow: 'ad-image-generation',
              quality: 'hd',
              style: 'natural',
            })
          )
        );

        images = qualityResults.map((outcome, i) => {
          if (outcome.status === 'fulfilled') {
            const r = outcome.value;
            return {
              ...r,
              format: targetFormats[i],
              qualityScore: r.qualityScore,
              allScores: r.allScores,
            };
          }
          return { format: targetFormats[i], error: outcome.reason?.message, provider: 'none' };
        });
      } else {
        // Standard sequential fallback mode
        images = await imageRouter.generateAdImages({
          prompt: imagePrompt,
          platform: toolInput.platform,
          formats,
          quality: 'hd',
          style: 'natural',
          mode: 'standard',
          preferred: toolInput.preferredProvider,
          workflow: 'ad-image-generation',
          clientId: client?.id,
        });
      }

      // Download + persist images to Google Drive (permanent URLs) and keep buffers for WhatsApp direct upload
      // Run all uploads in PARALLEL to avoid sequential 10-30s per image adding up
      const imgFolderId = client?.drive_creatives_folder_id || client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      const driveErrors = [];
      const driveResults = await Promise.allSettled(
        images.map(async (img) => {
          if (!img.url || img.error) return null;
          try {
            const result = await googleDrive.uploadImageFromUrl(img.url, `${toolInput.clientName || 'ad'}-${img.format}-${Date.now()}.png`, imgFolderId);
            if (result?.driveError) driveErrors.push(`${img.format}: ${result.driveError}`);
            return result;
          } catch (e) {
            log.error('Failed to persist ad image to Drive', { error: e.message, format: img.format });
            driveErrors.push(`${img.format}: ${e.message}`);
            return null;
          }
        })
      );

      const mappedImages = [];
      const _imageBuffers = []; // kept in-memory for deliverMediaInline, not serialized to JSON
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const driveResult = driveResults[i].status === 'fulfilled' ? driveResults[i].value : null;
        const mapped = {
          format: img.format,
          label: img.dimensions?.label || img.format,
          url: img.url,           // original provider URL (temp but fetchable by WhatsApp)
          deliveryUrl: img.url,   // always the raw provider URL for WhatsApp delivery
          provider: img.provider,
          error: img.error,
        };
        let imgBuffer = null;
        if (driveResult) {
          if (driveResult.webContentLink) {
            mapped.driveUrl = driveResult.webContentLink;
            mapped.driveId = driveResult.id;
            mapped.deliveryUrl = driveResult.webContentLink;
          }
          imgBuffer = { buffer: driveResult.imageBuffer, mimeType: driveResult.mimeType };
        }
        // Fallback: if Drive returned null but image has a URL, download bytes directly for WhatsApp upload
        if (!imgBuffer && img.url && !img.error) {
          try {
            if (img.url.startsWith('data:')) {
              // Gemini returns base64 data URIs — decode directly
              const match = img.url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                imgBuffer = { buffer: Buffer.from(match[2], 'base64'), mimeType: match[1] };
              }
            } else if (img.base64) {
              // Provider included raw base64 (Gemini)
              imgBuffer = { buffer: Buffer.from(img.base64, 'base64'), mimeType: img.mimeType || 'image/png' };
            } else {
              // HTTP URL — download directly (axios already imported at top of file)
              const resp = await axios.get(img.url, { responseType: 'arraybuffer', timeout: 15000 });
              imgBuffer = { buffer: Buffer.from(resp.data), mimeType: resp.headers['content-type'] || 'image/png' };
            }
          } catch (dlErr) {
            log.warn('Direct image buffer download failed', { error: dlErr.message, format: img.format });
          }
        }
        mappedImages.push(mapped);
        _imageBuffers.push(imgBuffer);
      }

      // Save companion Sheet to Drive — skip if ALL Drive uploads failed (quota/permissions)
      // to avoid hanging on the same Google API issue that blocked uploads
      let sheetUrl = null;
      let sheetError = null;
      const allDriveFailed = driveErrors.length > 0 && driveErrors.length >= images.filter(i => !i.error).length;
      if (allDriveFailed) {
        log.warn('Skipping sheet creation — all Drive uploads failed, Google API likely unavailable', { driveErrors });
        sheetError = 'Skipped — Google Drive unavailable';
      } else {
        try {
          const SHEET_TIMEOUT_MS = 30000; // 30s max for sheet creation
          const sheet = await Promise.race([
            campaignRecord.createAdImagesRecord({
              clientName: toolInput.clientName,
              platform: toolInput.platform,
              concept: toolInput.concept,
              imagePrompt,
              images: mappedImages,
              folderId: imgFolderId,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Sheet creation timed out after 30s')), SHEET_TIMEOUT_MS)),
          ]);
          sheetUrl = sheet?.url || null;
        } catch (e) {
          log.error('Failed to create ad images record sheet', { error: e.message });
          sheetError = e.message;
        }
      }

      const providers = [...new Set(images.filter(i => i.provider || i.providerName).map(i => i.providerName || i.provider))];
      const result = {
        clientName: toolInput.clientName,
        platform: toolInput.platform,
        concept: toolInput.concept,
        imagePrompt,
        images: mappedImages,
        totalGenerated: images.filter(i => !i.error).length,
        providers,
        qualityMode: qualityMode === 'multi' ? 'multi-candidate (all providers + Claude Vision scoring)' : 'sequential fallback',
        ...(qualityMode === 'multi' && {
          qualityScores: images.filter(i => i.qualityScore).map(i => ({
            format: i.format,
            score: i.qualityScore,
            provider: i.providerName || i.provider,
            allCandidateScores: i.allScores,
          })),
        }),
        sheetUrl,
        ...(sheetError && { sheetError }),
        ...(driveErrors.length > 0 && { driveErrors }),
      };
      // Attach image buffers for deliverMediaInline (not serialized to JSON for Claude)
      result._imageBuffers = _imageBuffers;
      return result;
    }
    case 'generate_ad_video': {
      if (!config.OPENAI_API_KEY) return { error: 'OPENAI_API_KEY not configured. Set it in .env to enable video generation.' };
      const client = getClient(toolInput.clientName);

      const videoPrompt = `Professional advertising video for ${toolInput.clientName}. ${toolInput.concept}. ${toolInput.offer ? `Featuring: ${toolInput.offer}.` : ''} High production quality, smooth camera movement, cinematic lighting.`;

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
        log.error('Sora video generation failed', { error: videoError.message, stack: videoError.stack, client: toolInput.clientName });
        const errMsg = videoError.message || 'Unknown error';
        const isRateLimit = errMsg.includes('429') || errMsg.includes('rate') || errMsg.includes('limit') || errMsg.includes('quota');
        const isContentPolicy = errMsg.includes('policy') || errMsg.includes('safety') || errMsg.includes('content');

        // Auto-fallback to Kling AI when Sora fails (rate limit, quota, or other transient errors)
        if (!isContentPolicy && klingApi.isConfigured()) {
          log.info('Falling back to Kling AI for video generation', { reason: errMsg.slice(0, 100), client: toolInput.clientName });
          try {
            const klingPrompt = `Professional advertising video for ${toolInput.clientName}. ${toolInput.concept}. ${toolInput.offer ? `Featuring: ${toolInput.offer}.` : ''} High production quality, smooth camera movement, cinematic lighting.`;
            const klingResult = await klingApi.generateVideoFromImage({
              imageUrl: toolInput.referenceImageUrl || toolInput.imageUrl,
              prompt: klingPrompt,
              duration: Math.min(toolInput.duration || 5, 10),
              aspectRatio: toolInput.platform === 'meta_stories' || toolInput.platform === 'tiktok' ? '9:16' : '16:9',
              workflow: 'ad-video-generation-kling-fallback',
              clientId: client?.id,
            });

            return {
              clientName: toolInput.clientName,
              concept: toolInput.concept,
              videoUrl: klingResult.videoUrl,
              duration: klingResult.duration,
              aspectRatio: klingResult.aspectRatio,
              status: klingResult.status,
              provider: 'kling',
              note: 'Generated via Kling AI (Sora was unavailable)',
            };
          } catch (klingError) {
            log.error('Kling AI fallback also failed', { error: klingError.message });
            // Fall through to return the original error with both providers mentioned
          }
        }

        let userMessage;
        if (isRateLimit) {
          userMessage = `Video generation failed — both Sora 2 and Kling AI were unavailable. Error: ${errMsg}`;
        } else if (isContentPolicy) {
          userMessage = `Video generation was blocked by content policy. Try a different concept. Error: ${errMsg}`;
        } else {
          userMessage = `Video generation failed: ${errMsg}. Try again with a simpler concept, or I can generate static images instead.`;
        }
        return {
          error: userMessage,
          suggestion: 'Try generate_ad_images as an alternative, or generate_video_from_image with a reference image and Kling AI',
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

      // Persist generated images to Google Drive + keep buffers for WhatsApp direct upload
      const client = getClient(toolInput.clientName);
      const pkgFolderId = client?.drive_creatives_folder_id || client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      const persistedImageUrls = [];   // original provider URLs for WhatsApp delivery
      const _pkgImageBuffers = [];
      const pkgDriveErrors = [];
      for (const img of pkg.images) {
        if (img.error || !img.url) continue;
        const originalUrl = img.url;   // keep original for delivery
        try {
          const driveResult = await googleDrive.uploadImageFromUrl(img.url, `${pkg.clientName || 'pkg'}-${img.format || 'image'}-${Date.now()}.png`, pkgFolderId);
          if (driveResult) {
            if (driveResult.driveError) pkgDriveErrors.push(`${img.format || 'image'}: ${driveResult.driveError}`);
            if (driveResult.webContentLink) {
              // Store Drive URL separately — don't replace original for delivery
              img.driveUrl = driveResult.webContentLink;
              img.driveId = driveResult.id;
            }
            _pkgImageBuffers.push({ buffer: driveResult.imageBuffer, mimeType: driveResult.mimeType });
          } else {
            _pkgImageBuffers.push(null);
          }
        } catch (e) {
          log.error('Failed to persist creative package image to Drive', { error: e.message });
          pkgDriveErrors.push(`${img.format || 'image'}: ${e.message}`);
          _pkgImageBuffers.push(null);
        }
        persistedImageUrls.push(originalUrl); // always use original provider URL
      }

      // Save companion Sheet to Drive — skip if ALL Drive uploads failed (quota/permissions)
      let sheetUrl = null;
      let sheetError = null;
      const allPkgDriveFailed = pkgDriveErrors.length > 0 && pkgDriveErrors.length >= pkg.images.filter(i => !i.error && i.url).length;
      if (allPkgDriveFailed) {
        log.warn('Skipping creative sheet creation — all Drive uploads failed', { pkgDriveErrors });
        sheetError = 'Skipped — Google Drive unavailable';
      } else {
        try {
          const SHEET_TIMEOUT_MS = 30000;
          const sheet = await Promise.race([
            campaignRecord.createCreativeRecord({
              clientName: pkg.clientName,
              platform: pkg.platform,
              campaignName: pkg.campaignName,
              textAds: pkg.textAds,
              images: pkg.images,
              videos: pkg.videos,
              summary: pkg.summary,
              presentationUrl: pkg.presentation?.url,
              folderId: pkgFolderId,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Sheet creation timed out after 30s')), SHEET_TIMEOUT_MS)),
          ]);
          sheetUrl = sheet?.url || null;
        } catch (e) {
          log.error('Failed to create creative record sheet', { error: e.message });
          sheetError = e.message;
        }
      }

      const pkgResult = {
        clientName: pkg.clientName,
        platform: pkg.platform,
        campaignName: pkg.campaignName,
        summary: pkg.summary,
        textAdsCount: pkg.textAds.length,
        textAdPreview: pkg.textAds.slice(0, 3).map(a => ({ headline: a.headline, cta: a.cta, angle: a.angle })),
        imagesCount: pkg.images.filter(i => !i.error).length,
        imageUrls: persistedImageUrls,
        videosCount: pkg.videos.filter(v => !v.error).length,
        presentationUrl: pkg.presentation?.url || null,
        sheetUrl,
        ...(sheetError && { sheetError }),
        ...(pkgDriveErrors.length > 0 && { driveErrors: pkgDriveErrors }),
        status: 'awaiting_approval',
        message: pkg.presentation?.url
          ? `Creative deck ready for review: ${pkg.presentation.url}` + (sheetUrl ? ` | Data sheet: ${sheetUrl}` : '')
          : 'Creative package generated (Google Slides not configured for deck)',
      };
      pkgResult._imageBuffers = _pkgImageBuffers;
      return pkgResult;
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
          logoUrl: analysis.brand.logoUrl,
          faviconUrl: analysis.brand.faviconUrl,
          brandFonts: analysis.brand.fonts,
          googleFontsUrl: analysis.brand.googleFontsUrl,
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
        logoUrl: page.logoUrl || null,
        faviconUrl: page.faviconUrl || null,
        brandFonts: page.fonts || [],
        googleFontsUrl: page.googleFontsUrl || null,
        wordCount: page.wordCount,
      };
    }

    case 'crawl_website': {
      if (!firecrawlApi.isConfigured()) {
        return { error: 'Website crawling is not available — Firecrawl API key is not configured.' };
      }
      const limit = Math.min(toolInput.limit || 10, 50);
      const crawlOpts = {
        limit,
        maxDepth: toolInput.maxDepth || 2,
      };
      if (toolInput.includePaths) crawlOpts.includePaths = toolInput.includePaths.split(',').map(p => p.trim());
      if (toolInput.excludePaths) crawlOpts.excludePaths = toolInput.excludePaths.split(',').map(p => p.trim());

      const result = await firecrawlApi.crawl(toolInput.url, crawlOpts);
      return {
        totalPages: result.totalPages,
        pages: result.pages.map(p => ({
          url: p.url,
          title: p.metadata?.title || '',
          description: p.metadata?.description || '',
          contentPreview: p.markdown?.slice(0, 2000) || '',
          wordCount: p.markdown ? p.markdown.split(/\s+/).length : 0,
        })),
      };
    }

    case 'search_web': {
      if (!firecrawlApi.isConfigured()) {
        return { error: 'Web search is not available — Firecrawl API key is not configured.' };
      }
      const searchResult = await firecrawlApi.search(toolInput.query, {
        limit: Math.min(toolInput.limit || 5, 10),
        lang: toolInput.lang || 'en',
        country: toolInput.country || 'us',
      });
      return {
        query: toolInput.query,
        totalResults: searchResult.totalResults,
        results: searchResult.results.map(r => ({
          url: r.url,
          title: r.title,
          description: r.description,
          contentPreview: r.markdown?.slice(0, 1500) || '',
        })),
      };
    }

    case 'map_website': {
      if (!firecrawlApi.isConfigured()) {
        return { error: 'Website mapping is not available — Firecrawl API key is not configured.' };
      }
      const mapResult = await firecrawlApi.map(toolInput.url, {
        limit: toolInput.limit || 100,
        search: toolInput.search || undefined,
      });
      return {
        url: toolInput.url,
        totalUrls: mapResult.totalUrls,
        urls: mapResult.urls,
      };
    }

    // --- Landing Page Preview ---
    case 'preview_landing_page': {
      const html = toolInput.html;
      if (!html || html.length < 50) {
        return { error: 'HTML content is too short — provide complete landing page HTML.' };
      }

      const id = crypto.randomUUID();
      landingPageStore.set(id, { html, createdAt: Date.now() });

      const baseUrl = getPublicUrl();
      const previewUrl = baseUrl ? `${baseUrl}/lp/${id}` : null;
      const lpName = toolInput.name || 'Landing Page';

      let screenshotBuffer = null;

      // Take screenshot via Firecrawl if available
      if (previewUrl && firecrawlApi.isConfigured()) {
        try {
          const screenshotResult = await firecrawlApi.scrape(previewUrl, {
            formats: ['screenshot'],
            onlyMainContent: false,
            waitFor: 2000,
            timeout: 30000,
          });
          if (screenshotResult.screenshot) {
            // Firecrawl returns screenshot as base64 data URL or http URL
            const ssData = screenshotResult.screenshot;
            if (ssData.startsWith('data:')) {
              screenshotBuffer = Buffer.from(ssData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
            } else if (ssData.startsWith('http')) {
              const imgResp = await axios.get(ssData, { responseType: 'arraybuffer', timeout: 15000 });
              screenshotBuffer = Buffer.from(imgResp.data);
            }
          }
        } catch (e) {
          log.warn('Landing page screenshot failed', { error: e.message, previewUrl });
        }
      }

      // Upload HTML to Google Drive
      let driveLink = null;
      try {
        const client = toolInput.clientName ? getClient(toolInput.clientName) : null;
        const folderId = client?.drive_creatives_folder_id || client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
        if (folderId) {
          const { Readable } = await import('stream');
          const stream = new Readable();
          stream.push(Buffer.from(html, 'utf-8'));
          stream.push(null);
          const driveFile = await googleDrive.uploadFile(`${lpName}.html`, stream, 'text/html', folderId);
          if (driveFile?.id) {
            await googleDrive.shareFolderWithAnyone(driveFile.id, 'reader');
            driveLink = driveFile.webViewLink;
          }
        }
      } catch (e) {
        log.warn('Landing page Drive upload failed', { error: e.message });
      }

      const result = {
        name: lpName,
        previewUrl,
        driveLink,
        hasScreenshot: !!screenshotBuffer,
        message: screenshotBuffer
          ? 'Landing page published! Screenshot preview sent as image.'
          : previewUrl
            ? 'Landing page published! Click the preview link to view it.'
            : 'Landing page HTML uploaded to Google Drive.',
      };

      if (screenshotBuffer) {
        result._screenshotBuffer = screenshotBuffer;
      }

      return result;
    }

    // --- Visual Analysis ---
    case 'analyze_visual_reference': {
      if (!geminiApi.isConfigured()) {
        return { error: 'Visual analysis requires GEMINI_API_KEY to be configured in .env.' };
      }
      const analysisPrompts = {
        competitor_ad: `You are a senior creative director analyzing a competitor's ad creative. Provide a detailed breakdown:

1. **Visual Composition**: Layout, focal point, use of space, visual hierarchy
2. **Color Palette**: Exact colors used, dominant vs accent, mood they create
3. **Style & Aesthetic**: Photography style, filters, design approach (minimalist, bold, lifestyle, etc.)
4. **Mood & Emotion**: What feelings does this evoke? What psychological triggers are used?
5. **Target Audience Signals**: Who is this ad targeting based on visual cues?
6. **Strengths**: What makes this ad effective? What would make someone stop scrolling?
7. **Weaknesses/Gaps**: What could be improved? Where is the opportunity to do better?
8. **Actionable Recommendations**: Specific directions for creating a BETTER version of this ad for our client.${toolInput.context ? `\n\nContext: ${toolInput.context}` : ''}`,

        style_reference: `Analyze this reference image for creative inspiration. Extract:
1. **Visual Style**: Exact style (photorealistic, illustrated, minimalist, editorial, etc.)
2. **Color Palette**: All colors with hex approximations
3. **Composition**: How elements are arranged, rule of thirds, symmetry, etc.
4. **Lighting**: Type (natural, studio, dramatic, soft), direction, quality
5. **Mood**: Overall feeling and atmosphere
6. **Textures & Materials**: Any notable textures or material qualities
7. **Key Elements to Replicate**: What specific techniques should we borrow for ad creatives?${toolInput.context ? `\n\nContext: ${toolInput.context}` : ''}`,

        brand_analysis: `Analyze this brand visual for brand identity extraction:
1. **Brand Colors**: Primary, secondary, accent colors with hex approximations
2. **Typography Approach**: Serif/sans-serif, weight, style
3. **Visual Identity**: Logo placement, brand elements, patterns
4. **Brand Personality**: What personality does the visual communicate?
5. **Target Market**: Who is this brand speaking to?
6. **Design System Cues**: Spacing, borders, shadows, rounded vs sharp corners
7. **Recommendations**: How to maintain this brand identity in ad creatives.${toolInput.context ? `\n\nContext: ${toolInput.context}` : ''}`,

        landing_page: `Analyze this landing page screenshot for conversion optimization insights:
1. **Above the Fold**: What's immediately visible? Hero image/video, headline, CTA
2. **Visual Hierarchy**: Where does the eye travel first?
3. **Color Psychology**: How are colors used to drive action?
4. **Trust Signals**: Testimonials, logos, badges visible?
5. **CTA Design**: Button colors, size, placement, copy
6. **Imagery**: Type (product, lifestyle, illustration), quality, relevance
7. **Recommendations**: How to create ads that match this landing page experience.${toolInput.context ? `\n\nContext: ${toolInput.context}` : ''}`,

        general: `Analyze this image in detail for creative inspiration:
1. **Composition & Layout**: How is the image composed?
2. **Color Palette**: Key colors used
3. **Style & Mood**: Overall aesthetic and emotional tone
4. **Lighting**: Quality and direction
5. **Key Takeaways**: What creative insights can be applied to ad design?${toolInput.context ? `\n\nContext: ${toolInput.context}` : ''}`,
      };

      const prompt = analysisPrompts[toolInput.analysisType] || analysisPrompts.general;
      const result = await geminiApi.analyzeImage({
        imageUrl: toolInput.imageUrl,
        prompt,
        workflow: 'visual-analysis',
        clientId: toolInput.clientName ? getClient(toolInput.clientName)?.id : undefined,
      });

      return {
        imageUrl: toolInput.imageUrl,
        analysisType: toolInput.analysisType || 'general',
        analysis: result.analysis,
        model: result.model,
        clientName: toolInput.clientName || null,
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

      // Always save to Google Doc for client review
      let docUrl = null;
      let docError = null;
      try {
        const folderId = client.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
        const docContent = `${post.title}\n\n` +
          `SEO Title: ${post.seoTitle || ''}\n` +
          `Meta Description: ${post.seoDescription || ''}\n` +
          `Focus Keyword: ${post.focusKeyword || ''}\n` +
          `Slug: ${post.slug || ''}\n` +
          `Tags: ${(post.suggestedTags || []).join(', ')}\n` +
          `Category: ${post.suggestedCategory || ''}\n` +
          `---\n\n` +
          (post.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const doc = await googleDrive.createDocument(
          `Blog Post — ${post.title}`,
          docContent,
          folderId,
        );
        if (doc) docUrl = doc.webViewLink;
      } catch (e) {
        log.error('Failed to save blog post to Google Doc', { error: e.message });
        docError = e.message;
      }

      // Create pending approval so client can approve publishing or self-post
      const approvalId = `blog-${Date.now()}`;
      const wpConnected = !!seoEngine.getWordPressClient(client);
      pendingApprovals.set(approvalId, {
        type: 'publish_blog',
        clientId: client.id,
        clientName: client.name,
        postData: {
          title: post.title,
          content: post.content,
          excerpt: post.excerpt,
          slug: post.slug,
          seoTitle: post.seoTitle,
          seoDescription: post.seoDescription,
          focusKeyword: post.focusKeyword,
          publishDate: toolInput.publishDate,
        },
        docUrl,
        wpConnected,
      });

      return {
        title: post.title,
        seoTitle: post.seoTitle,
        seoDescription: post.seoDescription,
        focusKeyword: post.focusKeyword,
        excerpt: post.excerpt,
        suggestedTags: post.suggestedTags,
        suggestedCategory: post.suggestedCategory,
        imagePrompt: post.imagePrompt,
        docUrl,
        ...(docError && { docError }),
        approvalId,
        wpConnected,
        status: 'pending_client_review',
        deliveryOptions: {
          option1: `I can publish this directly to your website — just reply APPROVE ${approvalId}`,
          option2: docUrl
            ? `Review and edit the Google Doc here: ${docUrl} — then either post it yourself or reply APPROVE ${approvalId} when ready`
            : 'I can send you the content to post yourself',
        },
        message: `Blog post "${post.title}" is ready for your review!${docUrl ? ` Google Doc: ${docUrl}` : ''}${docError ? ` (Google Doc creation failed: ${docError})` : ''}\n\nHow would you like to proceed?\n1. I publish it to your website — reply APPROVE ${approvalId}\n2. Review the Google Doc and post it yourself (or approve after review)`,
      };
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

        // Save proposed changes to Google Doc for review
        let docUrl = null;
        let docError = null;
        try {
          const folderId = client.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
          const docContent = `Meta Tag Changes — ${currentMeta.title || toolInput.url || 'Page'}\n\n` +
            `Page: ${toolInput.url || currentMeta.link || 'N/A'}\n` +
            `Page ID: ${toolInput.pageId || 'N/A'}\n\n` +
            `--- CURRENT ---\n` +
            `Title: ${currentMeta.seoTitle || '(missing)'}\n` +
            `Description: ${currentMeta.seoDescription || '(missing)'}\n` +
            `Focus Keyword: ${currentMeta.focusKeyword || '(none)'}\n\n` +
            `--- PROPOSED ---\n` +
            `Title: ${newMeta.seoTitle || ''}\n` +
            `Description: ${newMeta.seoDescription || ''}\n` +
            `Focus Keyword: ${newMeta.focusKeyword || ''}\n\n` +
            `Reasoning: ${newMeta.reasoning || ''}`;
          const doc = await googleDrive.createDocument(
            `Meta Tags — ${currentMeta.title || toolInput.url || client.name}`,
            docContent,
            folderId,
          );
          if (doc) docUrl = doc.webViewLink;
        } catch (e) {
          log.error('Failed to save meta tag changes to Google Doc', { error: e.message });
          docError = e.message;
        }

        // Create pending approval
        const approvalId = `meta-${Date.now()}`;
        pendingApprovals.set(approvalId, {
          type: 'apply_meta',
          clientId: client.id,
          clientName: client.name,
          pageId: toolInput.pageId,
          pageType: toolInput.pageType || 'posts',
          seoData: {
            seoTitle: newMeta.seoTitle,
            seoDescription: newMeta.seoDescription,
            focusKeyword: newMeta.focusKeyword,
          },
          docUrl,
          wpConnected: !!wp,
        });

        return {
          ...newMeta,
          currentTitle: currentMeta.seoTitle || '(missing)',
          currentDescription: currentMeta.seoDescription || '(missing)',
          docUrl,
          ...(docError && { docError }),
          approvalId,
          applied: false,
          status: 'pending_client_review',
          deliveryOptions: {
            option1: `I can apply these changes to your website — reply APPROVE ${approvalId}`,
            option2: docUrl
              ? `Review the proposed changes here: ${docUrl} — then approve or apply them yourself`
              : 'I can send you the proposed changes to apply yourself',
          },
          message: `Meta tag improvements generated!${docUrl ? ` Review: ${docUrl}` : ''}${docError ? ` (Google Doc failed: ${docError})` : ''}\n\nHow would you like to proceed?\n1. I apply the changes to your website — reply APPROVE ${approvalId}\n2. Review the Google Doc and apply them yourself (or approve after review)`,
        };
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

      // Build a summary of proposed changes for the client
      const changesList = [];
      if (toolInput.title) changesList.push(`Title → "${toolInput.title}"`);
      if (toolInput.content) changesList.push(`Content updated (${toolInput.content.length} chars)`);
      if (toolInput.status) changesList.push(`Status → ${toolInput.status}`);
      if (toolInput.seoTitle) changesList.push(`SEO Title → "${toolInput.seoTitle}"`);
      if (toolInput.seoDescription) changesList.push(`Meta Description → "${toolInput.seoDescription}"`);
      if (toolInput.focusKeyword) changesList.push(`Focus Keyword → "${toolInput.focusKeyword}"`);

      // Save proposed changes to Google Doc
      let docUrl = null;
      let docError = null;
      try {
        const folderId = client.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
        const docContent = `Proposed Changes — Post #${toolInput.postId}\n\n` +
          `Changes:\n${changesList.map(c => `• ${c}`).join('\n')}\n\n` +
          (toolInput.content ? `--- UPDATED CONTENT ---\n${toolInput.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}` : '');
        const doc = await googleDrive.createDocument(
          `Post Update — #${toolInput.postId} (${client.name})`,
          docContent,
          folderId,
        );
        if (doc) docUrl = doc.webViewLink;
      } catch (e) {
        log.error('Failed to save post update to Google Doc', { error: e.message });
        docError = e.message;
      }

      // Create pending approval — never push changes without client consent
      const approvalId = `update-${Date.now()}`;
      pendingApprovals.set(approvalId, {
        type: 'update_post',
        clientId: client.id,
        clientName: client.name,
        postId: toolInput.postId,
        updates: {
          title: toolInput.title,
          content: toolInput.content,
          status: toolInput.status,
        },
        seoUpdates: (toolInput.seoTitle || toolInput.seoDescription || toolInput.focusKeyword) ? {
          seoTitle: toolInput.seoTitle,
          seoDescription: toolInput.seoDescription,
          focusKeyword: toolInput.focusKeyword,
        } : null,
        docUrl,
      });

      return {
        postId: toolInput.postId,
        proposedChanges: changesList,
        docUrl,
        ...(docError && { docError }),
        approvalId,
        status: 'pending_client_review',
        deliveryOptions: {
          option1: `I can apply these changes to your website — reply APPROVE ${approvalId}`,
          option2: docUrl
            ? `Review the proposed changes here: ${docUrl} — then approve or apply them yourself`
            : 'I can send you the changes to apply yourself',
        },
        message: `Changes prepared for post #${toolInput.postId}!${docUrl ? ` Review: ${docUrl}` : ''}\n\nHow would you like to proceed?\n1. I apply the changes — reply APPROVE ${approvalId}\n2. Review the Google Doc and apply them yourself (or approve after review)`,
      };
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
      const folderId = client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;

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

    // --- Google Search Console ---
    case 'get_gsc_top_queries': {
      const client = getClient(toolInput.clientName);
      const siteUrl = client?.website;
      if (!siteUrl) return { error: 'No website configured for this client. Set the website field in client config.' };
      const queries = await googleSearchConsole.getTopQueries(siteUrl, { startDate: toolInput.startDate, endDate: toolInput.endDate, limit: toolInput.limit });
      return { clientName: toolInput.clientName, siteUrl, topQueries: queries };
    }
    case 'get_gsc_top_pages': {
      const client = getClient(toolInput.clientName);
      const siteUrl = client?.website;
      if (!siteUrl) return { error: 'No website configured for this client.' };
      const pages = await googleSearchConsole.getTopPages(siteUrl, { startDate: toolInput.startDate, endDate: toolInput.endDate, limit: toolInput.limit });
      return { clientName: toolInput.clientName, siteUrl, topPages: pages };
    }
    case 'get_gsc_page_queries': {
      const client = getClient(toolInput.clientName);
      const siteUrl = client?.website;
      if (!siteUrl) return { error: 'No website configured for this client.' };
      const queries = await googleSearchConsole.getPageQueries(siteUrl, toolInput.pageUrl, { startDate: toolInput.startDate, endDate: toolInput.endDate, limit: toolInput.limit });
      return { clientName: toolInput.clientName, siteUrl, pageUrl: toolInput.pageUrl, queries };
    }
    case 'get_gsc_daily_trend': {
      const client = getClient(toolInput.clientName);
      const siteUrl = client?.website;
      if (!siteUrl) return { error: 'No website configured for this client.' };
      const trend = await googleSearchConsole.getDailyTrend(siteUrl, { startDate: toolInput.startDate, endDate: toolInput.endDate });
      return { clientName: toolInput.clientName, siteUrl, dailyTrend: trend };
    }
    case 'get_gsc_device_breakdown': {
      const client = getClient(toolInput.clientName);
      const siteUrl = client?.website;
      if (!siteUrl) return { error: 'No website configured for this client.' };
      const devices = await googleSearchConsole.getDeviceBreakdown(siteUrl, { startDate: toolInput.startDate, endDate: toolInput.endDate });
      return { clientName: toolInput.clientName, siteUrl, devices };
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
      const folderId = client?.drive_plans_folder_id || client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      const result = await presentationBuilder.buildMediaPlanDeck({
        clientName: toolInput.clientName,
        campaignName: toolInput.campaignName,
        mediaPlan: toolInput.mediaPlan,
        creatives: toolInput.creatives,
        charts: toolInput.charts,
        folderId,
      });
      // Save companion Sheet to Drive
      let sheetUrl = null;
      let sheetError = null;
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
        sheetError = e.message;
      }

      const mediaPlanResult = {
        clientName: toolInput.clientName,
        presentationUrl: result.url,
        presentationId: result.presentationId,
        sheetUrl,
        ...(sheetError && { sheetError }),
        message: `Media plan deck ready: ${result.url}` + (sheetUrl ? ` | Data sheet: ${sheetUrl}` : '') + (sheetError ? ` (Sheet save failed: ${sheetError})` : ''),
      };
      // Pre-download presentation as PDF for inline delivery
      try {
        const deckPdf = await googleDrive.exportDocumentAsBuffer(result.presentationId, 'application/pdf');
        if (deckPdf && deckPdf.length > 100) {
          mediaPlanResult._pdfBuffer = deckPdf;
          log.info('Media plan deck PDF buffer downloaded', { presentationId: result.presentationId, size: deckPdf.length });
        }
      } catch (e) {
        log.error('Failed to pre-download media plan deck PDF', { error: e.message });
        mediaPlanResult.pdfError = e.message;
      }
      return mediaPlanResult;
    }
    case 'build_competitor_deck': {
      const client = getClient(toolInput.clientName);
      const folderId = client?.drive_competitor_research_folder_id || client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
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
      // Save companion Sheet to Drive
      let sheetUrl = null;
      let sheetError = null;
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
        sheetError = e.message;
      }

      const competitorDeckResult = {
        clientName: toolInput.clientName,
        presentationUrl: result.url,
        presentationId: result.presentationId,
        sheetUrl,
        ...(sheetError && { sheetError }),
        message: `Competitor research deck ready: ${result.url}` + (sheetUrl ? ` | Data sheet: ${sheetUrl}` : '') + (sheetError ? ` (Sheet save failed: ${sheetError})` : ''),
      };
      try {
        const deckPdf = await googleDrive.exportDocumentAsBuffer(result.presentationId, 'application/pdf');
        if (deckPdf && deckPdf.length > 100) {
          competitorDeckResult._pdfBuffer = deckPdf;
          log.info('Competitor deck PDF buffer downloaded', { presentationId: result.presentationId, size: deckPdf.length });
        }
      } catch (e) {
        log.error('Failed to pre-download competitor deck PDF', { error: e.message });
        competitorDeckResult.pdfError = e.message;
      }
      return competitorDeckResult;
    }
    case 'build_performance_deck': {
      const client = getClient(toolInput.clientName);
      const folderId = client?.drive_reports_folder_id || client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
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
      // Save companion Sheet to Drive
      let sheetUrl = null;
      let sheetError = null;
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
        sheetError = e.message;
      }

      const performanceDeckResult = {
        clientName: toolInput.clientName,
        presentationUrl: result.url,
        presentationId: result.presentationId,
        sheetUrl,
        ...(sheetError && { sheetError }),
        message: `Performance report deck ready: ${result.url}` + (sheetUrl ? ` | Data sheet: ${sheetUrl}` : '') + (sheetError ? ` (Sheet save failed: ${sheetError})` : ''),
      };
      try {
        const deckPdf = await googleDrive.exportDocumentAsBuffer(result.presentationId, 'application/pdf');
        if (deckPdf && deckPdf.length > 100) {
          performanceDeckResult._pdfBuffer = deckPdf;
          log.info('Performance deck PDF buffer downloaded', { presentationId: result.presentationId, size: deckPdf.length });
        }
      } catch (e) {
        log.error('Failed to pre-download performance deck PDF', { error: e.message });
        performanceDeckResult.pdfError = e.message;
      }
      return performanceDeckResult;
    }

    // --- PDF Reports ---
    case 'generate_performance_pdf': {
      const client = getClient(toolInput.clientName);
      const folderId = client?.drive_reports_folder_id || client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
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
      // Pre-download PDF via Google Drive API for native delivery (don't rely on export URL)
      const toolResult = { clientName: toolInput.clientName, docUrl: result.docUrl, pdfUrl: result.pdfUrl, message: `Report ready! Doc: ${result.docUrl} | PDF: ${result.pdfUrl}` };
      try {
        const pdfBuffer = await googleDrive.exportDocumentAsBuffer(result.docId, 'application/pdf');
        if (pdfBuffer && pdfBuffer.length > 100) {
          toolResult._pdfBuffer = pdfBuffer;
          log.info('PDF buffer downloaded for inline delivery', { docId: result.docId, size: pdfBuffer.length });
        }
      } catch (e) {
        log.error('Failed to pre-download PDF buffer', { error: e.message, docId: result.docId });
        toolResult.pdfError = e.message;
      }
      return toolResult;
    }
    case 'generate_competitor_pdf': {
      const client = getClient(toolInput.clientName);
      const folderId = client?.drive_competitor_research_folder_id || client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      const result = await reportBuilder.generateCompetitorReport({
        clientName: toolInput.clientName,
        competitors: toolInput.competitors,
        keywordGap: toolInput.keywordGap,
        competitorAds: toolInput.competitorAds,
        summary: toolInput.summary,
        recommendations: toolInput.recommendations,
        folderId,
      });
      // Pre-download PDF via Google Drive API for native delivery
      const toolResult = { clientName: toolInput.clientName, docUrl: result.docUrl, pdfUrl: result.pdfUrl, message: `Competitor report ready! Doc: ${result.docUrl} | PDF: ${result.pdfUrl}` };
      try {
        const pdfBuffer = await googleDrive.exportDocumentAsBuffer(result.docId, 'application/pdf');
        if (pdfBuffer && pdfBuffer.length > 100) {
          toolResult._pdfBuffer = pdfBuffer;
          log.info('Competitor PDF buffer downloaded for inline delivery', { docId: result.docId, size: pdfBuffer.length });
        }
      } catch (e) {
        log.error('Failed to pre-download competitor PDF buffer', { error: e.message, docId: result.docId });
        toolResult.pdfError = e.message;
      }
      return toolResult;
    }

    // --- Charts ---
    case 'create_chart_presentation': {
      const client = getClient(toolInput.clientName);
      const folderId = client?.drive_root_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      const result = await chartBuilderService.buildChartPresentation({
        clientName: toolInput.clientName,
        title: toolInput.title,
        charts: toolInput.charts,
        folderId,
      });
      const chartResult = { clientName: toolInput.clientName, presentationUrl: result.url, presentationId: result.presentationId, message: `Chart presentation ready: ${result.url}` };
      try {
        const deckPdf = await googleDrive.exportDocumentAsBuffer(result.presentationId, 'application/pdf');
        if (deckPdf && deckPdf.length > 100) {
          chartResult._pdfBuffer = deckPdf;
          log.info('Chart presentation PDF buffer downloaded', { presentationId: result.presentationId, size: deckPdf.length });
        }
      } catch (e) {
        log.error('Failed to pre-download chart presentation PDF', { error: e.message });
        chartResult.pdfError = e.message;
      }
      return chartResult;
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
    // --- AgencyAnalytics ---
    case 'get_aa_campaigns': {
      try {
        const data = await agencyAnalytics.getCampaigns();
        const campaigns = (data.data || data.campaigns || data || []);
        return {
          totalCampaigns: Array.isArray(campaigns) ? campaigns.length : 0,
          campaigns: Array.isArray(campaigns) ? campaigns.map(c => ({
            id: c.id,
            name: c.name,
            status: c.status,
            website: c.website || c.url,
            createdAt: c.created_at,
          })) : campaigns,
        };
      } catch (e) {
        const is401 = e.message?.includes('401') || e.message?.includes('Unauthorized');
        return { error: is401
          ? 'AgencyAnalytics API authentication failed. Check that AGENCY_ANALYTICS_API_KEY is set correctly.'
          : `AgencyAnalytics API error: ${e.message}` };
      }
    }

    case 'get_aa_campaign': {
      try {
        const data = await agencyAnalytics.getCampaign(toolInput.campaignId);
        return { campaign: data.data || data };
      } catch (e) {
        return { error: `AgencyAnalytics API error: ${e.message}` };
      }
    }

    case 'get_aa_integrations': {
      try {
        const data = await agencyAnalytics.getIntegrations(toolInput.campaignId);
        const integrations = (data.data || data.integrations || data || []);
        return {
          campaignId: toolInput.campaignId,
          totalIntegrations: Array.isArray(integrations) ? integrations.length : 0,
          integrations: Array.isArray(integrations) ? integrations.map(i => ({
            id: i.id,
            type: i.type || i.integration_type || i.provider,
            name: i.name,
            status: i.status,
            lastSync: i.last_sync || i.last_synced_at,
          })) : integrations,
        };
      } catch (e) {
        return { error: `AgencyAnalytics API error: ${e.message}` };
      }
    }

    case 'get_aa_reports': {
      try {
        const data = await agencyAnalytics.getReports(toolInput.campaignId);
        const reports = (data.data || data.reports || data || []);
        return {
          campaignId: toolInput.campaignId,
          totalReports: Array.isArray(reports) ? reports.length : 0,
          reports: Array.isArray(reports) ? reports.map(r => ({
            id: r.id,
            name: r.name,
            type: r.type,
            schedule: r.schedule,
            recipients: r.recipients,
            lastSent: r.last_sent || r.last_sent_at,
          })) : reports,
        };
      } catch (e) {
        return { error: `AgencyAnalytics API error: ${e.message}` };
      }
    }

    // --- Brand DNA ---
    case 'extract_brand_dna': {
      const client = toolInput.clientName ? getClient(toolInput.clientName) : null;
      try {
        const result = await brandDNA.extractBrandDNA(toolInput.websiteUrl, client?.id);
        return {
          status: 'success',
          brandDNA: result,
          savedToClient: !!client,
          clientName: client?.name || null,
        };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'update_brand_dna': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found` };
      if (!client.website) return { error: `Client "${client.name}" has no website URL on file. Please provide one.` };
      try {
        const result = await brandDNA.extractBrandDNA(client.website, client.id);
        return {
          status: 'updated',
          clientName: client.name,
          brandDNA: result,
        };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'get_brand_dna': {
      const client = getClient(toolInput.clientName);
      if (!client) return { error: `Client "${toolInput.clientName}" not found` };
      const dna = brandDNA.loadBrandDNA(client.id);
      if (!dna) return { error: `No Brand DNA found for "${client.name}". Use extract_brand_dna with their website URL to create one.` };
      return {
        clientName: client.name,
        brandDNA: dna,
      };
    }

    // --- Image-to-Video (fal.ai Kling → direct Kling → Sora fallback) ---
    case 'generate_video_from_image': {
      if (!toolInput.imageUrl) return { error: 'imageUrl is required. When the user uploads a photo, the image URL is provided in a [SYSTEM: ...] tag in the message. Look for it and pass it as imageUrl.' };

      const client = toolInput.clientName ? getClient(toolInput.clientName) : null;
      const clientBrandDNA = client ? brandDNA.loadBrandDNA(client.id) : null;
      const brandName = clientBrandDNA?.business_name || toolInput.clientName || 'the brand';
      const motionPrompt = toolInput.prompt
        ? `${toolInput.prompt}. Smooth, professional motion. Keep movement natural.`
        : `Animate this image naturally for a professional ad for ${brandName}. Smooth camera movement, attractive motion.`;
      const ar = toolInput.aspectRatio || '9:16';
      const dur = toolInput.duration || 5;

      log.info('Video from image starting', { imageUrl: (toolInput.imageUrl || '').slice(0, 80), clientName: toolInput.clientName });

      // Provider 1: fal.ai Kling (most reliable, has credits)
      if (falApi.isConfigured()) {
        try {
          log.info('Trying fal.ai Kling for video generation');
          const result = await falApi.generateVideoFromImage({
            imageUrl: toolInput.imageUrl,
            prompt: motionPrompt,
            duration: dur,
            aspectRatio: ar,
            workflow: 'branded-video-generation',
            clientId: client?.id,
          });

          log.info('fal.ai Kling video completed', { videoUrl: result.videoUrl?.slice(0, 80), id: result.id });
          return {
            clientName: client?.name || toolInput.clientName || null,
            videoUrl: result.videoUrl,
            duration: result.duration,
            aspectRatio: result.aspectRatio,
            status: result.status,
            taskId: result.id,
            provider: 'fal-kling',
          };
        } catch (e) {
          log.warn('fal.ai Kling video failed, trying next provider', { error: e.message });
        }
      }

      // Provider 2: Direct Kling API
      if (klingApi.isConfigured()) {
        try {
          log.info('Trying direct Kling API for video generation');
          const result = await klingApi.generateBrandedVideo({
            imageUrl: toolInput.imageUrl,
            brandDNA: clientBrandDNA,
            userInstruction: toolInput.prompt || '',
            aspectRatio: ar,
            clientId: client?.id,
          });

          log.info('Direct Kling video completed', { videoUrl: result.videoUrl?.slice(0, 80), taskId: result.id });
          return {
            clientName: client?.name || toolInput.clientName || null,
            videoUrl: result.videoUrl,
            duration: result.duration,
            aspectRatio: result.aspectRatio,
            status: result.status,
            taskId: result.id,
            provider: 'kling-direct',
          };
        } catch (e) {
          log.warn('Direct Kling video failed', { error: e.message });
        }
      }

      // Provider 3: Sora 2 (text-to-video, cannot use user's photo directly)
      if (config.OPENAI_API_KEY) {
        try {
          log.info('Trying Sora 2 for video generation (text-to-video fallback)');
          const { generateVideo } = await import('../api/openai-media.js');
          const result = await generateVideo({
            prompt: `${motionPrompt} The video shows a person presenting a professional offer directly to camera.`,
            duration: Math.min(dur, 8),
            aspectRatio: ar,
            workflow: 'branded-video-sora-fallback',
            clientId: client?.id,
          });

          log.info('Sora 2 video completed', { videoUrl: result.videoUrl?.slice(0, 80), id: result.id });
          return {
            clientName: client?.name || toolInput.clientName || null,
            videoUrl: result.videoUrl,
            duration: result.duration,
            aspectRatio: result.aspectRatio || ar,
            status: result.status,
            taskId: result.id,
            provider: 'sora-2',
            note: 'Generated via Sora 2 (image-to-video providers were unavailable). The video may not use the exact uploaded photo.',
          };
        } catch (e) {
          log.warn('Sora 2 video also failed', { error: e.message });
        }
      }

      return { error: 'All video providers failed (fal.ai Kling, direct Kling, Sora 2). Please try again in a few minutes or check API credits.' };
    }

    // --- Template Overlay Creative ---
    case 'generate_ad_creative_with_text': {
      const client = getClient(toolInput.clientName);
      // Allow unregistered users — build brand DNA from tool input or defaults
      if (!client && !toolInput.uploadedImageUrl && !toolInput.brandColors && !toolInput.concept && !toolInput.product) {
        return { error: `Client "${toolInput.clientName}" not found. Pass brandColors, product, or uploadedImageUrl to create an ad without a registered client.` };
      }

      const clientBrandDNA = client ? brandDNA.loadBrandDNA(client.id) : null;
      const platform = toolInput.platform || 'meta';
      const imgFolderId = client ? (client.drive_creatives_folder_id || client.drive_root_folder_id) : null;

      // Build effective brand DNA: client DB > tool input > defaults
      // This lets Claude pass brand info from browse_website/extract_brand_dna directly
      const toolBrandColors = toolInput.brandColors
        ? toolInput.brandColors.split(',').map(c => c.trim()).filter(c => c.startsWith('#'))
        : [];
      const toolFonts = toolInput.brandFonts
        ? toolInput.brandFonts.split(',').map(f => f.trim()).filter(Boolean)
        : [];

      const effectiveBrandDNA = clientBrandDNA || {
        business_name: toolInput.clientName || 'Ad Creative',
        primary_colors: toolBrandColors.length > 0 ? toolBrandColors.slice(0, 3) : ['#2563EB', '#1E40AF'],
        secondary_colors: toolBrandColors.length > 3 ? toolBrandColors.slice(3, 5) : [],
        cta_style: 'direct',
        main_products_or_services: [toolInput.product || 'Professional Services'],
        logo_url: toolInput.logoUrl || null,
        favicon_url: toolInput.faviconUrl || null,
        fonts: toolFonts.length > 0 ? toolFonts : [],
        google_fonts_url: toolInput.googleFontsUrl || null,
        tone_of_voice: toolInput.mood || null,
        industry: toolInput.industry || null,
      };

      // Determine rendering mode: template-first (default) or photo-forward (AI image)
      const usePhotoForward = !toolInput.uploadedImageUrl && (toolInput.style === 'photo-forward' || toolInput.style === 'photorealistic');

      try {
        let result;

        if (usePhotoForward) {
          // Legacy path: AI-generated background + text overlay
          const imgPrompt = await creativeEngine.generateImagePrompt({
            clientName: toolInput.clientName,
            platform,
            product: toolInput.product,
            concept: toolInput.concept,
            mood: toolInput.mood,
            style: toolInput.style,
            brandColors: effectiveBrandDNA?.primary_colors?.join(', ') || client?.brand_colors,
            audience: effectiveBrandDNA?.target_audience || client?.target_audience,
          });

          result = await creativeRenderer.generateFullCreative({
            brandDNA: effectiveBrandDNA,
            product: toolInput.product || effectiveBrandDNA?.main_products_or_services?.[0],
            goal: toolInput.goal || 'conversion',
            generateImage: (opts) => imageRouter.generateImage({ ...opts, prompt: imgPrompt }),
            imagePrompt: imgPrompt,
            driveFolderId: imgFolderId,
            clientId: client?.id,
          });
        } else {
          // Template-first path: professional HTML/CSS design
          // If user uploaded a photo, use it as background for the template
          result = await creativeRenderer.generateTemplateCreative({
            brandDNA: effectiveBrandDNA,
            product: toolInput.product || effectiveBrandDNA?.main_products_or_services?.[0],
            goal: toolInput.goal || 'conversion',
            templateStyle: toolInput.templateStyle || (toolInput.uploadedImageUrl ? 'split-diagonal' : null),
            backgroundImageUrl: toolInput.uploadedImageUrl || null,
            driveFolderId: imgFolderId,
            clientId: client?.id,
          });
        }

        // Build response with image buffers for delivery
        const images = [];
        const _imageBuffers = [];

        if (result.feed && !result.feed.error) {
          images.push({ format: 'feed', label: 'Feed (1080x1080)', url: result.feed.url || '', driveId: result.feed.driveId, templateName: result.feed.templateName });
          _imageBuffers.push(result.feed._buffer ? { buffer: result.feed._buffer, mimeType: 'image/png' } : null);
        }
        if (result.story && !result.story.error) {
          images.push({ format: 'story', label: 'Stories (1080x1920)', url: result.story.url || '', driveId: result.story.driveId, templateName: result.story.templateName });
          _imageBuffers.push(result.story._buffer ? { buffer: result.story._buffer, mimeType: 'image/png' } : null);
        }

        const response = {
          clientName: client?.name || toolInput.clientName,
          adCopy: result.adCopy,
          templateBased: !!result.templateBased,
          templateName: result.templateName || null,
          backgroundUrl: result.backgroundUrl || null,
          images,
          totalGenerated: images.length,
          fallback: result.fallback,
        };

        if (result.fallback) {
          response.fallbackNote = 'Puppeteer render failed. Background image and ad copy delivered separately.';
        }

        response._imageBuffers = _imageBuffers;
        return response;
      } catch (e) {
        return { error: `Creative generation failed: ${e.message}` };
      }
    }

    case 'check_credentials': {
      const fs = (await import('fs')).default;
      // Use the same fallback path as getAuth() in google-slides/sheets/drive — config/google-service-account.json
      const credPath = config.GOOGLE_APPLICATION_CREDENTIALS || 'config/google-service-account.json';
      const credFileExists = fs.existsSync(credPath);
      let credValid = false;
      if (credFileExists) {
        try {
          const raw = fs.readFileSync(credPath, 'utf-8');
          const json = JSON.parse(raw);
          credValid = !!(json.client_email && json.private_key);
        } catch (_) { /* invalid JSON */ }
      }

      const checks = {
        google_service_account: {
          envVar: 'GOOGLE_APPLICATION_CREDENTIALS',
          value: credPath,
          fileExists: credFileExists,
          validServiceAccount: credValid,
          status: credValid ? 'OK' : credFileExists ? 'INVALID — file exists but is not a valid service account JSON' : 'MISSING',
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
        agency_analytics: {
          status: config.AGENCY_ANALYTICS_API_KEY ? 'CONFIGURED' : 'NOT SET',
          affects: ['AgencyAnalytics campaigns, reports, integrations, dashboards'],
        },
      };

      const issues = [];
      if (!credValid) issues.push(credFileExists
        ? 'CRITICAL: Google service account JSON file exists but is invalid — check the GOOGLE_SERVICE_ACCOUNT_JSON env var'
        : 'CRITICAL: Google service account JSON file is missing — Slides, Sheets, Drive, Docs will NOT work');
      if (!config.GOOGLE_ADS_DEVELOPER_TOKEN) issues.push('Google Ads not configured — campaigns and Keyword Planner unavailable');
      if (!config.META_USER_ACCESS_TOKEN) issues.push('Meta user access token not set — Ad Library unavailable');
      if (!config.GA4_PROPERTY_ID) issues.push('GA4 property ID not set — Analytics unavailable');
      if (!config.AGENCY_ANALYTICS_API_KEY) issues.push('AgencyAnalytics API key not set — dashboard and report queries unavailable');

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
    log.error(`Tool ${toolName} failed`, { error: err.message, stack: err.stack });
    return { error: err.message };
  }
}

export { executeCSATool };
