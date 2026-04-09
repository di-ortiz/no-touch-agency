/**
 * CSA Tool Definitions — all 60+ tool schemas for Sofia's Claude agent.
 * Extracted from whatsapp-server.js for maintainability.
 */

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
    description: 'Check for overdue tasks in ClickUp across all spaces. Returns tasks that are past their due date with assignee info and days overdue. Use this for "what\'s overdue?" or "late tasks" queries.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_clickup_tasks',
    description: 'Get tasks from ClickUp with optional filters — by assignee name, status, tags, or list. Use this when someone asks about a team member\'s tasks, workload, what\'s assigned to someone, or project progress. Can filter by person name (e.g. "Gabriel\'s tasks"), status (e.g. "in progress"), or tags.',
    input_schema: { type: 'object', properties: { assigneeName: { type: 'string', description: 'Filter by assignee name (e.g. "Gabriel", "Maria"). Matches partial names.' }, statuses: { type: 'array', items: { type: 'string' }, description: 'Filter by status(es): open, in progress, review, complete, closed' }, tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tag(s)' }, listId: { type: 'string', description: 'Filter by specific ClickUp list ID' }, includeClosed: { type: 'boolean', description: 'Include closed/completed tasks (default: false)' } } },
  },
  {
    name: 'get_clickup_task',
    description: 'Get detailed info about a specific ClickUp task by its ID. Shows description, comments, assignees, dates, status, subtasks, and custom fields.',
    input_schema: { type: 'object', properties: { taskId: { type: 'string', description: 'ClickUp task ID' } }, required: ['taskId'] },
  },
  {
    name: 'get_clickup_workspace',
    description: 'Browse the ClickUp workspace structure — spaces, folders, and lists. Use this to understand the project hierarchy or find the right list to query.',
    input_schema: { type: 'object', properties: { spaceId: { type: 'string', description: 'Get folders/lists for a specific space (optional — omit to list all spaces)' }, folderId: { type: 'string', description: 'Get lists within a specific folder (optional)' } } },
  },
  {
    name: 'create_clickup_task',
    description: 'Create a new task in ClickUp. Requires a list ID (use get_clickup_workspace to find the right list).',
    input_schema: { type: 'object', properties: { listId: { type: 'string', description: 'ClickUp list ID to create the task in' }, name: { type: 'string', description: 'Task name/title' }, description: { type: 'string', description: 'Task description (supports markdown)' }, assigneeName: { type: 'string', description: 'Name of person to assign (e.g. "Gabriel")' }, priority: { type: 'number', description: 'Priority: 1=urgent, 2=high, 3=normal, 4=low' }, dueDate: { type: 'string', description: 'Due date (ISO 8601 format)' }, tags: { type: 'array', items: { type: 'string' }, description: 'Tags to add' } }, required: ['listId', 'name'] },
  },
  {
    name: 'update_clickup_task',
    description: 'Update an existing ClickUp task — change status, assignee, priority, due date, or add a comment.',
    input_schema: { type: 'object', properties: { taskId: { type: 'string', description: 'ClickUp task ID to update' }, name: { type: 'string', description: 'New task name' }, status: { type: 'string', description: 'New status (e.g. "in progress", "review", "complete")' }, assigneeName: { type: 'string', description: 'New assignee name' }, priority: { type: 'number', description: 'New priority: 1=urgent, 2=high, 3=normal, 4=low' }, dueDate: { type: 'string', description: 'New due date (ISO 8601)' }, comment: { type: 'string', description: 'Add a comment to the task' } }, required: ['taskId'] },
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
    name: 'generate_pdf_report',
    description: 'Generate a beautifully designed PDF report using AI. Creates professional documents with brand colors, charts, tables, and visual layouts. Returns the PDF as a downloadable file sent directly in chat. Use this for: content calendars (visual weekly grid), social media strategies, competitor analyses, monthly performance reports, or any custom report. Works without a registered client — just pass a name.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client or brand name for the report header' }, type: { type: 'string', enum: ['social_strategy', 'content_calendar', 'competitor_analysis', 'monthly_report', 'custom'], description: 'Report type. content_calendar renders as a visual weekly grid. custom allows freeform instructions.' }, data: { type: 'string', description: 'Report data — can be structured JSON or natural language description of what to include. For content calendars: include month, platforms, posts per week, themes. For strategies: include goals, audience, content pillars. For competitor analysis: include competitor names and insights.' }, customPrompt: { type: 'string', description: 'Custom instructions for the report design/content (used with type "custom")' } }, required: ['clientName', 'type', 'data'] },
  },
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
    description: 'Generate ad creative VISUALS using AI. DEFAULT MODE (multi-candidate): Fires ALL available providers (DALL-E 3, Flux Pro, NanoBanana v2, Imagen 3, Kimi 2.5) in parallel, then uses Claude Vision to score each candidate against competitor ads and pick the BEST one. This ensures the highest quality output. Use qualityMode "single" only for speed-critical requests. Images are TEXT-FREE visual compositions — headlines/CTAs must be added via the ad platform or template overlay.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, platform: { type: 'string', enum: ['meta', 'instagram', 'google', 'tiktok'], description: 'Platform for proper sizing' }, concept: { type: 'string', description: 'Detailed creative concept — what the image should show, the scene, the mood, the story. Be very specific.' }, product: { type: 'string', description: 'Product or service being advertised' }, audience: { type: 'string', description: 'Target audience description (demographics, interests, pain points)' }, mood: { type: 'string', description: 'Mood/emotion to evoke (e.g. "premium and aspirational", "urgent and energetic", "calm and trustworthy")' }, style: { type: 'string', description: 'Creative style: photorealistic, lifestyle photography, minimalist, editorial, flat design, cinematic, product shot, etc.' }, brandColors: { type: 'string', description: 'Brand color palette (e.g. "#1a2b3c navy blue, #ff6b35 coral orange, white")' }, references: { type: 'string', description: 'Visual references or inspiration (e.g. "Like Apple product ads — clean, minimal, lots of white space")' }, websiteInsights: { type: 'string', description: 'Key insights from browsing the client website (brand feel, visual style, messaging tone)' }, competitorInsights: { type: 'string', description: 'Insights from competitor ad research (what competitors are doing, gaps to exploit)' }, formats: { type: 'string', description: 'Comma-separated format keys: meta_feed, meta_square, meta_story, instagram_feed, instagram_story, google_display, tiktok (optional, uses platform defaults)' }, qualityMode: { type: 'string', enum: ['multi', 'single'], description: 'multi (default): All providers + Claude Vision quality scoring. single: Sequential fallback, first success wins (faster but lower quality).' }, preferredProvider: { type: 'string', enum: ['dalle', 'fal', 'gemini', 'kimi'], description: 'Preferred AI image provider for single mode (optional). Use dalle for photorealism, fal for artistic/stylized, gemini for variety, kimi for Kimi 2.5.' } }, required: ['clientName', 'platform', 'concept'] },
  },
  {
    name: 'generate_ad_video',
    description: 'Generate a short ad video using Sora 2 AI (auto-falls back to Kling AI if Sora is rate-limited). Creates a professional advertising video clip (4-12 seconds). IMPORTANT: If the user sends a photo/image and wants a video from it, prefer generate_video_from_image instead — it uses Kling AI image-to-video which is more reliable and actually uses the photo.',
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
  {
    name: 'crawl_website',
    description: 'Crawl an entire website and extract clean content from multiple pages. Great for understanding a competitor\'s full site structure, analyzing all blog posts, or auditing a client\'s website content. Returns markdown content for each page found. Requires Firecrawl.',
    input_schema: { type: 'object', properties: {
      url: { type: 'string', description: 'Starting URL to crawl (e.g. "https://example.com")' },
      limit: { type: 'number', description: 'Max pages to crawl (default: 10, max: 50)' },
      maxDepth: { type: 'number', description: 'Max link depth to follow (default: 2)' },
      includePaths: { type: 'string', description: 'Comma-separated path patterns to include (e.g. "/blog/*,/products/*")' },
      excludePaths: { type: 'string', description: 'Comma-separated path patterns to exclude (e.g. "/admin/*,/login")' },
    }, required: ['url'] },
  },
  {
    name: 'search_web',
    description: 'Search the web and return full page content from top results. Like Google search but returns the actual scraped content of each result page as clean markdown. Great for market research, finding competitor info, industry trends, or any topic research.',
    input_schema: { type: 'object', properties: {
      query: { type: 'string', description: 'Search query (e.g. "best PPC strategies for e-commerce 2025")' },
      limit: { type: 'number', description: 'Max results to return (default: 5, max: 10)' },
      lang: { type: 'string', description: 'Language code (default: "en")' },
      country: { type: 'string', description: 'Country code (default: "us")' },
    }, required: ['query'] },
  },
  {
    name: 'map_website',
    description: 'Quickly discover all URLs on a website without scraping their content. Returns a list of every page/URL found on the domain. Useful for understanding site structure, finding specific pages, or planning a crawl. Much faster than crawl_website.',
    input_schema: { type: 'object', properties: {
      url: { type: 'string', description: 'Website URL to map (e.g. "https://example.com")' },
      search: { type: 'string', description: 'Optional: filter URLs by keyword (e.g. "blog" or "pricing")' },
      limit: { type: 'number', description: 'Max URLs to return (default: 100)' },
    }, required: ['url'] },
  },
  // --- Landing Page Preview ---
  {
    name: 'preview_landing_page',
    description: 'Publish a landing page and send a visual screenshot preview in chat. Takes the full HTML code you generated, hosts it at a live preview URL, captures a screenshot of the rendered page using Firecrawl, uploads the HTML file to Google Drive, and sends the screenshot image in WhatsApp/Telegram so the user can see exactly how the page looks. ALWAYS use this tool after generating landing page HTML — never paste raw HTML code in chat. First browse the client website with browse_website to extract brand colors, fonts, and style, then generate the HTML incorporating those brand elements, then call this tool to publish and preview it.',
    input_schema: { type: 'object', properties: {
      html: { type: 'string', description: 'Complete self-contained HTML code for the landing page. Must include all CSS inline or via CDN links (Google Fonts, Tailwind, etc). Should be a beautiful, responsive, conversion-optimized page.' },
      name: { type: 'string', description: 'Name for the landing page (e.g. "Acme Corp — Summer Sale Landing Page")' },
      clientName: { type: 'string', description: 'Client name (for organizing in their Google Drive folder)' },
    }, required: ['html'] },
  },
  // --- Visual Analysis ---
  {
    name: 'analyze_visual_reference',
    description: 'Analyze a competitor ad, reference image, or any visual using Gemini Vision AI. Extracts detailed creative insights: composition, color palette, style, mood, lighting, typography approach, and actionable recommendations for creating similar or better ads. Perfect for analyzing Meta Ad Library screenshots, competitor landing pages, or client reference images before generating creatives.',
    input_schema: { type: 'object', properties: {
      imageUrl: { type: 'string', description: 'URL of the image to analyze (competitor ad, reference creative, etc.)' },
      analysisType: { type: 'string', enum: ['competitor_ad', 'style_reference', 'brand_analysis', 'landing_page', 'general'], description: 'Type of analysis to perform (affects the depth and focus of insights)' },
      clientName: { type: 'string', description: 'Client name (for context — what brand should the insights inform?)' },
      context: { type: 'string', description: 'Additional context (e.g. "This is a competitor\'s top-performing Instagram ad for a SaaS product")' },
    }, required: ['imageUrl'] },
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
  // --- Google Search Console ---
  {
    name: 'get_gsc_top_queries',
    description: 'Get top search queries from Google Search Console. Shows what people search on Google to find the client\'s website — with clicks, impressions, CTR, and average position.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name (must have website configured)' }, startDate: { type: 'string', description: 'Start date (YYYY-MM-DD or "30daysAgo")' }, endDate: { type: 'string', description: 'End date (YYYY-MM-DD or "today")' }, limit: { type: 'number', description: 'Max results (default: 25)' } }, required: ['clientName'] },
  },
  {
    name: 'get_gsc_top_pages',
    description: 'Get top pages from Google Search Console by organic clicks. Shows which pages get the most search traffic, with impressions, CTR, and position.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, startDate: { type: 'string' }, endDate: { type: 'string' }, limit: { type: 'number', description: 'Max results (default: 25)' } }, required: ['clientName'] },
  },
  {
    name: 'get_gsc_page_queries',
    description: 'Get search queries for a specific page from Google Search Console. Useful for understanding what keywords drive traffic to a particular landing page.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, pageUrl: { type: 'string', description: 'Full URL of the page to analyze' }, startDate: { type: 'string' }, endDate: { type: 'string' }, limit: { type: 'number' } }, required: ['clientName', 'pageUrl'] },
  },
  {
    name: 'get_gsc_daily_trend',
    description: 'Get daily organic search performance trend from Google Search Console. Shows clicks, impressions, CTR, and position over time.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' }, startDate: { type: 'string' }, endDate: { type: 'string' } }, required: ['clientName'] },
  },
  {
    name: 'get_gsc_device_breakdown',
    description: 'Get search performance by device (desktop, mobile, tablet) from Google Search Console.',
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
  // --- AgencyAnalytics ---
  {
    name: 'get_aa_campaigns',
    description: 'List all campaigns (client accounts) on AgencyAnalytics. Shows campaign names, IDs, status, and connected integrations. Use this to see which clients have dashboards set up, or to get a campaign ID for deeper queries.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_aa_campaign',
    description: 'Get detailed info about a specific AgencyAnalytics campaign (client account) by ID. Shows campaign name, status, integrations, and configuration.',
    input_schema: { type: 'object', properties: { campaignId: { type: 'string', description: 'AgencyAnalytics campaign ID' } }, required: ['campaignId'] },
  },
  {
    name: 'get_aa_integrations',
    description: 'Get the list of connected integrations (data sources) for an AgencyAnalytics campaign. Shows which platforms are connected (Google Ads, Meta Ads, GA4, Search Console, etc.) and their sync status. Use this to verify dashboards are properly set up with the right data sources.',
    input_schema: { type: 'object', properties: { campaignId: { type: 'string', description: 'AgencyAnalytics campaign ID' } }, required: ['campaignId'] },
  },
  {
    name: 'get_aa_reports',
    description: 'Get all reports configured for an AgencyAnalytics campaign. Shows report names, types, schedules, and recipients. Use this to check if reporting is properly set up for a client.',
    input_schema: { type: 'object', properties: { campaignId: { type: 'string', description: 'AgencyAnalytics campaign ID' } }, required: ['campaignId'] },
  },
  // --- Brand DNA ---
  {
    name: 'extract_brand_dna',
    description: 'Extract Brand DNA from a client\'s website using Firecrawl + AI analysis. Returns a structured brand profile (colors, tone, audience, differentiators) that is automatically saved and used for all future creative generation. Also works for non-clients — just provide a URL.',
    input_schema: { type: 'object', properties: { websiteUrl: { type: 'string', description: 'Website URL to analyze (e.g. "https://example.com")' }, clientName: { type: 'string', description: 'Client name (optional — saves Brand DNA to their profile if provided)' } }, required: ['websiteUrl'] },
  },
  {
    name: 'update_brand_dna',
    description: 'Re-extract Brand DNA for an existing client by re-crawling their website. Use when the client says "atualizar marca", "update brand", or wants to refresh their brand profile.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name to update' } }, required: ['clientName'] },
  },
  {
    name: 'get_brand_dna',
    description: 'Get the stored Brand DNA for a client. Shows their brand colors, tone of voice, target audience, differentiators, and all brand identity data extracted from their website.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name' } }, required: ['clientName'] },
  },
  // --- Kling AI Video Generation ---
  {
    name: 'generate_video_from_image',
    description: 'Generate a short animated video from a static image. Tries fal.ai Kling → direct Kling → Sora 2 fallback. Transforms user photos into eye-catching video ads. Takes 30-90 seconds. Default format is Stories/Reels (9:16). Use when the user sends a photo and asks to "fazer vídeo", "animar foto", "criar vídeo do produto", "transforma em vídeo", or "video of me".',
    input_schema: { type: 'object', properties: { imageUrl: { type: 'string', description: 'URL of the source image to animate' }, prompt: { type: 'string', description: 'Motion prompt describing desired animation (e.g. "Camera slowly zooms in, product rotates gently")' }, clientName: { type: 'string', description: 'Client name (for brand-aware motion prompt)' }, aspectRatio: { type: 'string', enum: ['9:16', '16:9', '1:1'], description: 'Aspect ratio: 9:16 (Stories/Reels), 16:9 (Feed/Landscape), 1:1 (Square). Default: 9:16' }, duration: { type: 'number', description: 'Duration in seconds (5 or 10). Default: 5' } }, required: ['imageUrl'] },
  },
  // --- Template Overlay Creative ---
  {
    name: 'generate_ad_creative_with_text',
    description: 'Generate a professional ad creative with REAL readable text. DEFAULT MODE (template-based): Uses beautiful HTML/CSS templates with bold typography, brand colors, gradients, and geometric design. PHOTO MODE: Pass uploadedImageUrl to use the user\'s actual photo as the background with text overlay — ALWAYS use this when the user uploaded a photo. PHOTO-FORWARD MODE: Set style to "photo-forward" for AI-generated background. Returns both Feed (1080x1080) and Stories (1080x1920) formats.',
    input_schema: { type: 'object', properties: { clientName: { type: 'string', description: 'Client name (or brand name from website)' }, platform: { type: 'string', enum: ['meta', 'instagram', 'google', 'tiktok'], description: 'Target platform' }, product: { type: 'string', description: 'Product or service being advertised' }, goal: { type: 'string', description: 'Campaign goal: awareness, conversion, promotion, leads' }, concept: { type: 'string', description: 'Visual concept (used for photo-forward mode background image)' }, mood: { type: 'string', description: 'Mood/emotion (optional)' }, style: { type: 'string', description: 'Creative style. Default: template-based design. Set to "photo-forward" or "photorealistic" for AI-generated background image.' }, templateStyle: { type: 'string', description: 'Template design to use: bold-gradient, dark-premium, split-diagonal, floating-card, geometric-blocks, minimal-clean, text-hero, neon-glow, corner-accent, gradient-mesh, duotone, outline-bold, stacked-impact, glass-morphism, brutalist, side-stripe. Leave empty for random selection.' }, uploadedImageUrl: { type: 'string', description: 'URL of user-uploaded photo to use as background. ALWAYS pass this when the user sent a photo.' }, brandColors: { type: 'string', description: 'Comma-separated hex brand colors from website analysis (e.g. "#E63946, #1D3557, #F1FAEE"). Pass these from browse_website or extract_brand_dna results to create on-brand creatives.' }, brandFonts: { type: 'string', description: 'Comma-separated font names detected from website (e.g. "Inter, Montserrat"). Pass these from browse_website or extract_brand_dna results.' }, logoUrl: { type: 'string', description: 'URL of the brand logo detected from website. Pass this to overlay the logo on the ad creative.' }, faviconUrl: { type: 'string', description: 'URL of the brand favicon. Used as logo fallback if no logo URL available.' }, googleFontsUrl: { type: 'string', description: 'Google Fonts CSS URL detected from the website. Pass for exact font matching.' }, industry: { type: 'string', description: 'Brand industry (e.g. "digital marketing", "e-commerce", "SaaS")' } }, required: ['clientName', 'platform'] },
  },
  // --- Diagnostics ---
  {
    name: 'check_credentials',
    description: 'Check which API credentials are configured and working. Use this FIRST when any Google operation fails to diagnose the exact problem and give the user step-by-step instructions to fix it.',
    input_schema: { type: 'object', properties: {} },
  },
];

// Tools available to client-facing chat (no campaign management or cost reports)
export const CLIENT_TOOL_NAMES = [
  'generate_ad_images', 'generate_ad_video', 'generate_creative_package',
  'generate_text_ads', 'analyze_visual_reference', 'preview_landing_page',
  'generate_video_from_image', 'generate_ad_creative_with_text',
  'browse_website', 'crawl_website', 'search_web', 'map_website',
  'search_ad_library', 'search_facebook_pages', 'get_page_ads',
  'get_search_volume', 'get_keyword_ideas',
  'get_keyword_planner_volume', 'get_keyword_planner_ideas',
  'get_domain_overview', 'analyze_serp', 'find_seo_competitors',
  'get_keyword_gap', 'audit_landing_page', 'audit_seo_page',
  'search_google_ads_transparency',
  'full_seo_audit', 'generate_blog_post', 'fix_meta_tags',
  'plan_content_calendar', 'list_wp_content', 'generate_schema_markup',
];

export { CSA_TOOLS };
