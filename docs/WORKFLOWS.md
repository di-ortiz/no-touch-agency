# PPC Agency Automation -- Workflow Reference

This document describes all 15 automated workflows in the No-Touch Agency system. Each workflow operates on a defined trigger, executes a sequence of steps, produces specific outputs, and references concrete files in the codebase.

---

## Table of Contents

1. [Workflow 1: Morning Intelligence Briefing](#workflow-1-morning-intelligence-briefing)
2. [Workflow 2: New Client Onboarding](#workflow-2-new-client-onboarding)
3. [Workflow 3: Campaign Brief Intelligence](#workflow-3-campaign-brief-intelligence)
4. [Workflow 4: Creative Generation & Approval](#workflow-4-creative-generation--approval)
5. [Workflow 5: Campaign Launch Process](#workflow-5-campaign-launch-process)
6. [Workflow 6: Daily Performance Monitoring](#workflow-6-daily-performance-monitoring)
7. [Workflow 7: A/B Test Management](#workflow-7-ab-test-management)
8. [Workflow 8: Weekly Client Report](#workflow-8-weekly-client-report)
9. [Workflow 9: Monthly Strategic Review](#workflow-9-monthly-strategic-review)
10. [Workflow 10: WhatsApp Command Handler](#workflow-10-whatsapp-command-handler)
11. [Workflow 11: Competitor Monitoring](#workflow-11-competitor-monitoring)
12. [Workflow 12: Cross-Department Opportunity Detection](#workflow-12-cross-department-opportunity-detection)
13. [Workflow 13: Budget Pacing & Optimization](#workflow-13-budget-pacing--optimization)
14. [Workflow 14: Creative Fatigue Detection](#workflow-14-creative-fatigue-detection)
15. [Workflow 15: Landing Page Performance Integration](#workflow-15-landing-page-performance-integration)

---

## Workflow 1: Morning Intelligence Briefing

**Schedule:** Daily at 8:00 AM Eastern (`0 8 * * *`)

**Purpose:** Provide the agency owner with a single WhatsApp message summarizing everything that matters across all clients and platforms before the workday begins.

### Trigger

Cron schedule registered in `src/services/scheduler.js` under the name `morning-briefing`. Can also be triggered on demand via the WhatsApp command `morning briefing` (see Workflow 10).

### Process Steps

1. **Retrieve client roster** -- Load all active clients from the SQLite knowledge base (`data/knowledge.db`, `clients` table).
2. **Pull Meta Ads data** -- For each client with a `meta_ad_account_id`, call `getAccountInsights()` with `datePreset: 'yesterday'` via the Meta Marketing API (`src/api/meta-ads.js`). Extract spend, ROAS, CPA, conversions, and CTR through `extractConversions()`.
3. **Pull Google Ads data** -- For each client with a `google_ads_customer_id`, call `getAccountPerformance()` for yesterday's date via `src/api/google-ads.js`. Format with `formatGoogleAdsMetrics()`.
4. **Pull TikTok Ads data** -- For each client with a `tiktok_advertiser_id`, call `getReport()` via `src/api/tiktok-ads.js` for yesterday's date range.
5. **Check ClickUp tasks** -- Three parallel calls through `src/api/clickup.js`:
   - `getOverdueTasks()` -- tasks past their due date
   - `getTasksDueToday()` -- tasks due today
   - `getTasksDueSoon()` -- tasks due in the next 3 days
6. **Gather AI cost data** -- Call `getCostSummary('today')` from `src/services/cost-tracker.js` to include current day AI spend.
7. **Generate briefing with Claude** -- Send all collected data to Claude Sonnet using the `morningBriefing` system prompt and `morningBriefing` user prompt template from `src/prompts/templates.js`. Claude produces:
   - Overall health score (1-10) with color emoji
   - Top 3 urgent items requiring attention
   - Performance highlights
   - Issues needing attention
   - Budget summary
8. **Parse and structure** -- Extract health score, urgent items, highlights, and issues from Claude's response using keyword-based list extraction (`extractListItems()`).
9. **Send via WhatsApp** -- Call `sendMorningBriefing()` from `src/api/whatsapp.js`, which formats the structured briefing for WhatsApp delivery.

### Outputs

- WhatsApp message to the owner's number containing the formatted briefing
- Log entry in `logs/` with workflow execution details
- API cost records in `data/costs.db` for the Claude call

### Error Handling

Each platform data pull is wrapped in a try/catch so that a failure in one platform (e.g., Meta API down) does not block the entire briefing. Warnings are logged, and the briefing proceeds with available data.

### Related Files

| File | Role |
|------|------|
| `src/workflows/morning-briefing.js` | Main workflow implementation |
| `src/services/scheduler.js` | Cron registration (line 86) |
| `src/prompts/templates.js` | `SYSTEM_PROMPTS.morningBriefing`, `USER_PROMPTS.morningBriefing` |
| `src/api/meta-ads.js` | Meta data retrieval |
| `src/api/google-ads.js` | Google Ads data retrieval |
| `src/api/tiktok-ads.js` | TikTok data retrieval |
| `src/api/clickup.js` | Task data retrieval |
| `src/api/whatsapp.js` | WhatsApp delivery |
| `src/services/cost-tracker.js` | AI cost summary |
| `src/services/knowledge-base.js` | Client roster (`getAllClients()`) |

---

## Workflow 2: New Client Onboarding

**Trigger:** HubSpot deal stage change to "Closed Won" (webhook) or manual initiation

**Purpose:** Automate the complete onboarding of a new PPC client, from CRM data extraction through project setup to strategic planning.

### Trigger

HubSpot webhook fires when a deal reaches the "Closed Won" stage. The webhook hits the Express server endpoint. Alternatively, onboarding can be triggered manually through the system.

### Process Steps

1. **Extract client data from HubSpot** -- Pull deal and contact properties via `src/api/hubspot.js`: company name, website, industry, contact info, deal value (monthly retainer), and any custom properties for ad accounts.
2. **Create knowledge base entry** -- Call `createClient()` in `src/services/knowledge-base.js` with all extracted data. This inserts a row into the `clients` table with fields for:
   - Business info (industry, website, description, target audience)
   - Brand guidelines (voice, colors, fonts)
   - Goals and budgets (monthly budget, target ROAS, target CPA, primary KPI)
   - Ad platform account IDs (Meta, Google, TikTok, Twitter/X)
   - Google Drive folder IDs
   - ClickUp list ID
3. **Create ClickUp project** -- Via `src/api/clickup.js`, create a new list in the PPC space with standard task templates:
   - Account audit tasks (one per platform)
   - Conversion tracking setup
   - Audience research
   - Competitor analysis
   - Creative brief
   - Campaign structure planning
   - Launch checklist
4. **Create Google Drive folder structure** -- Via `src/api/google-drive.js`, create the client's folder hierarchy under the root agency folder:
   - `{Client Name}/Reports/`
   - `{Client Name}/Creatives/`
   - `{Client Name}/Plans/`
   - `{Client Name}/Brand Assets/`
5. **Run account audit** -- For each linked ad platform, pull historical performance data (last 90 days). Store results in `campaign_history` table. Claude analyzes the data using the `performanceAnalysis` system prompt to identify:
   - Current campaign structure strengths/weaknesses
   - Budget allocation efficiency
   - Audience overlap issues
   - Creative performance patterns
6. **Generate 90-day plan** -- Claude uses the `strategicPlanning` system prompt with all gathered data to produce a phased plan:
   - Days 1-30: Quick wins and foundation
   - Days 31-60: Scaling and testing
   - Days 61-90: Optimization and expansion
7. **Store plan and notify** -- Save the 90-day plan to Google Drive and create corresponding ClickUp milestones. Send onboarding summary via WhatsApp.

### Outputs

- New client record in `data/knowledge.db`
- ClickUp project with templated task list
- Google Drive folder structure
- Account audit document (Google Drive)
- 90-day strategic plan (Google Drive)
- WhatsApp notification confirming onboarding completion

### Safety

This workflow has an approval level of `ALWAYS_REQUIRES_APPROVAL` in the safety system. The system sends a WhatsApp notification with onboarding details and waits for explicit `APPROVE` before proceeding with any ad account changes.

### Related Files

| File | Role |
|------|------|
| `src/api/hubspot.js` | CRM data extraction |
| `src/services/knowledge-base.js` | `createClient()`, `updateClient()` |
| `src/api/clickup.js` | Project/task creation |
| `src/api/google-drive.js` | Folder structure creation |
| `src/api/meta-ads.js` | Historical data pull for audit |
| `src/api/google-ads.js` | Historical data pull for audit |
| `src/api/anthropic.js` | `deepAnalysis()` for audit and plan |
| `src/prompts/templates.js` | `performanceAnalysis`, `strategicPlanning` prompts |
| `src/services/safety.js` | Approval gate |

---

## Workflow 3: Campaign Brief Intelligence

**Trigger:** ClickUp task status change to "Brief Required" or new task created in the Briefs list

**Purpose:** Pre-populate campaign briefs with intelligence from past campaign data, competitor research, and industry benchmarks so that brief creation takes minutes instead of hours.

### Trigger

ClickUp webhook monitored by `src/workflows/clickup-monitor.js`. Fires when a task in the campaign planning list transitions to "Brief Required" status.

### Process Steps

1. **Identify client and campaign type** -- Parse the ClickUp task name and description to determine which client and what kind of campaign (awareness, conversion, retargeting, etc.).
2. **Pull historical performance** -- Call `getClientCampaignHistory()` from the knowledge base to retrieve past campaign data for this client. Filter by platform and objective.
3. **Retrieve top creatives** -- Call `getTopCreatives()` to find the client's best-performing ad copy and visuals, sorted by CTR and conversion rate.
4. **Load competitor intelligence** -- Query the `competitor_intel` table for recent competitor data relevant to this client.
5. **Fetch industry benchmarks** -- Call `getBenchmark()` for the client's industry, platform, and relevant metrics (CTR, CPA, ROAS).
6. **Generate pre-filled brief** -- Send all context to Claude using the `creativeBrief` system prompt. Claude produces:
   - Recommended objective and KPIs
   - Suggested budget allocation based on historical performance
   - Target audience recommendations with refinements
   - Messaging angles based on top-performing past copy
   - Platform-specific recommendations
   - Testing hypotheses
7. **Update ClickUp task** -- Write the generated brief back to the ClickUp task description and move the task to "Brief Review" status.

### Outputs

- Pre-filled campaign brief in the ClickUp task
- Task moved to "Brief Review" status
- WhatsApp notification to the owner with a brief summary

### Related Files

| File | Role |
|------|------|
| `src/workflows/clickup-monitor.js` | Trigger detection |
| `src/services/knowledge-base.js` | `getClientCampaignHistory()`, `getTopCreatives()`, `getBenchmark()` |
| `src/api/clickup.js` | Task reading and updating |
| `src/api/anthropic.js` | `deepAnalysis()` for brief generation |
| `src/prompts/templates.js` | `creativeBrief` system prompt |

---

## Workflow 4: Creative Generation & Approval

**Trigger:** Campaign brief task moves to "Brief Approved" status in ClickUp

**Purpose:** Automatically generate ad copy variations, visual concepts, and platform-specific creative assets from an approved campaign brief.

### Trigger

ClickUp webhook detects the task status change to "Brief Approved."

### Process Steps

1. **Parse approved brief** -- Extract the campaign brief content from the ClickUp task: objective, target audience, messaging angles, brand guidelines, platform targets.
2. **Load brand context** -- Pull client brand guidelines from the knowledge base: brand voice, colors, fonts, logo Drive ID, brand book Drive ID.
3. **Generate ad copy** -- Send brief and brand context to Claude using the `adCopyWriter` system prompt and `generateAdCopy` user prompt. Claude produces:
   - 10 headline variations (platform-appropriate character limits: 30 chars for Google, 40 chars for Meta/TikTok)
   - 5 body copy variations (90 chars for Google, 125 chars for Meta/TikTok)
   - 5 CTA variations
   - Strategy notes for each variation
4. **Generate visual concepts** -- If DALL-E/Canva integration is configured, generate image concepts based on the brief. For DALL-E, each image costs approximately $0.04 (tracked in cost DB). For Canva, use template-based generation via `src/api/canva.js` (if `CANVA_API_KEY` is set).
5. **Store in creative library** -- Save all generated creatives to the `creative_library` table via `saveCreative()` in the knowledge base, with status `pending_approval`.
6. **Upload to Google Drive** -- Save generated assets to the client's `Creatives/` folder.
7. **Create approval task** -- Create a ClickUp task in the approval list with all generated creatives attached, and send a WhatsApp message to the owner with a preview and approval request.

### Outputs

- Generated ad copy (multiple variations per platform)
- Visual concepts or generated images
- Creative library entries in the knowledge base
- Assets in client's Google Drive Creatives folder
- ClickUp approval task
- WhatsApp approval request with preview

### Related Files

| File | Role |
|------|------|
| `src/api/clickup.js` | Brief reading, approval task creation |
| `src/services/knowledge-base.js` | `buildClientContext()`, `saveCreative()` |
| `src/api/anthropic.js` | `deepAnalysis()` for copy generation |
| `src/prompts/templates.js` | `adCopyWriter`, `generateAdCopy` prompts |
| `src/api/google-drive.js` | Asset upload |
| `src/api/whatsapp.js` | Approval notification |
| `src/services/cost-tracker.js` | DALL-E cost tracking |

---

## Workflow 5: Campaign Launch Process

**Trigger:** Creative approval task completed (ClickUp status "Approved") plus WhatsApp `APPROVE` confirmation

**Purpose:** Validate all prerequisites and launch campaigns via platform APIs with full safety checks.

### Trigger

Two-step trigger: (1) ClickUp task status changes to "Approved", and (2) the owner confirms via WhatsApp `APPROVE [id]`.

### Process Steps

1. **Validate prerequisites** -- Check that all required items are in place:
   - Brief approved (ClickUp tag: `brief-approved`)
   - Creative approved (ClickUp tag: `creative-approved`)
   - Tracking verified (ClickUp tag: `tracking-verified`)
   - Budget confirmed
   - Landing page live and loading
   If any prerequisite is missing, the system sends a WhatsApp warning listing what is missing (see `checkDependencies()` in `src/workflows/clickup-monitor.js`).
2. **Safety validation** -- Run the action through `validateAction()` in `src/services/safety.js` with `type: 'launch_campaign'`. Campaign launches always have approval level `ALWAYS_REQUIRES_APPROVAL`.
3. **Request human approval** -- Send a structured WhatsApp message with campaign details, budget, targeting summary, and creative preview. Wait for `APPROVE [id]` response.
4. **Create campaign via API** -- Upon approval, use the appropriate platform API:
   - **Meta:** Create campaign, ad sets, and ads via `src/api/meta-ads.js` (`updateCampaign()`, etc.)
   - **Google Ads:** Create campaign via `src/api/google-ads.js`
   - **TikTok:** Create campaign via `src/api/tiktok-ads.js`
5. **Record in knowledge base** -- Add the campaign to `campaign_history` via `recordCampaignPerformance()`.
6. **Update ClickUp** -- Move the task to "Live" status and add the campaign ID as a custom field.
7. **Audit log** -- Record the launch action in `data/costs.db` `audit_log` table with full details and rollback data (campaign ID for potential pause).
8. **Notify** -- Send WhatsApp confirmation with campaign ID and a link to the platform dashboard.

### Outputs

- Live campaign on the target platform
- Campaign history record in knowledge base
- ClickUp task updated to "Live"
- Audit log entry with rollback capability
- WhatsApp launch confirmation

### Safety

Campaign launches are **always blocked** until explicit human approval via WhatsApp. The `validateAction()` function returns `allowed: false` with level `ALWAYS_REQUIRES_APPROVAL` for any `launch_campaign` action type.

### Related Files

| File | Role |
|------|------|
| `src/workflows/clickup-monitor.js` | `checkDependencies()` |
| `src/services/safety.js` | `validateAction()`, `safeExecute()` |
| `src/api/meta-ads.js` | Campaign creation |
| `src/api/google-ads.js` | Campaign creation |
| `src/api/tiktok-ads.js` | Campaign creation |
| `src/services/knowledge-base.js` | `recordCampaignPerformance()` |
| `src/services/cost-tracker.js` | `auditLog()` |
| `src/commands/whatsapp-server.js` | `handleApproval()` |

---

## Workflow 6: Daily Performance Monitoring

**Schedule:** Three times daily -- 10:00 AM, 3:00 PM, 8:00 PM Eastern (`0 10 * * *`, `0 15 * * *`, `0 20 * * *`)

**Purpose:** Continuously monitor all active campaigns for anomalies, budget pacing issues, and performance problems. Automatically pause dangerous campaigns and alert on issues requiring human attention.

### Trigger

Three separate cron jobs registered in `src/services/scheduler.js` as `daily-monitor-10am`, `daily-monitor-3pm`, and `daily-monitor-8pm`.

### Process Steps

1. **Iterate all active clients** -- Load client list from knowledge base via `getAllClients()`.
2. **Monitor Meta campaigns** (`monitorClientMeta()`):
   - Fetch all active campaigns via `getCampaigns()` with `statusFilter: ['ACTIVE']`
   - For each campaign, pull today's insights via `getCampaignInsights()`
   - **Pacing check:** Compare current spend against daily budget. Flag if spend exceeds 120% of budget.
   - **Safety threshold check:** Run `shouldAutoPause()` from `src/services/safety.js`:
     - ROAS below 0.2x target for 3+ days: auto-pause
     - CPA above 3x target: auto-pause
     - Significant spend ($500+) with zero conversions: auto-pause
   - **CTR anomaly:** Flag if CTR < 0.5% with > 1,000 impressions
   - **Zero conversion alert:** Flag if spend > $50 with zero conversions
   - Auto-pause via `safeExecute()` which wraps the pause in safety checks and audit logging
3. **Monitor Google Ads campaigns** (`monitorClientGoogle()`):
   - Fetch campaigns with today's date range
   - Run the same pacing, safety, and anomaly checks
   - Note: Google Ads pauses are flagged for manual review rather than auto-executed
4. **Monitor TikTok campaigns** (`monitorClientTikTok()`):
   - Fetch today's report data
   - Check for zero-conversion spend alerts
5. **Consolidate and alert** -- Categorize all issues by severity:
   - **Critical:** Auto-pause triggers, ROAS collapse, massive overspend
   - **Warning:** Budget pacing issues, low CTR, zero conversions with moderate spend
6. **Send WhatsApp alert** -- Format a consolidated message grouping critical issues first, then warnings, then auto-actions taken. Send via `sendAlert()`.

### Outputs

- WhatsApp alert message (only if issues found; silent if all is well)
- Auto-pause actions on campaigns meeting safety thresholds
- Audit log entries for all auto-actions
- Cost records for any Claude analysis calls

### Error Handling

Each client and each platform is wrapped in its own try/catch. A failure monitoring one client's Meta account does not prevent monitoring of their Google Ads account or other clients.

### Related Files

| File | Role |
|------|------|
| `src/workflows/daily-monitor.js` | Main workflow implementation |
| `src/services/scheduler.js` | Cron registration (lines 89-93) |
| `src/services/safety.js` | `shouldAutoPause()`, `safeExecute()` |
| `src/api/meta-ads.js` | `getCampaigns()`, `getCampaignInsights()`, `pauseCampaign()` |
| `src/api/google-ads.js` | `getCampaigns()`, `formatGoogleAdsMetrics()` |
| `src/api/tiktok-ads.js` | `getReport()` |
| `src/api/whatsapp.js` | `sendAlert()` |
| `src/services/knowledge-base.js` | `getAllClients()` |
| `src/services/cost-tracker.js` | `auditLog()` |

---

## Workflow 7: A/B Test Management

**Schedule:** Weekly (aligned with the scheduler; typically runs alongside other weekly tasks)

**Purpose:** Systematically identify, manage, and conclude A/B tests across all campaigns, ensuring the agency always has active tests running and results are acted upon.

### Trigger

Scheduled weekly run. Also triggered by the daily monitor when it detects campaigns that have been running without active tests for more than 2 weeks.

### Process Steps

1. **Audit active tests** -- Query the `test_results` table in the knowledge base for tests with status `running`. Check if any have reached statistical significance.
2. **Evaluate running tests** -- For each running test:
   - Pull current metrics for variant A and variant B from the respective platform
   - Calculate statistical significance (confidence level)
   - If confidence >= 95%, mark test as `complete` and declare a winner
   - If test has run for > 4 weeks without significance, mark as `inconclusive`
3. **Apply winners** -- For completed tests, send recommendations via WhatsApp. If the winner is clear:
   - Recommend pausing the losing variant
   - Recommend scaling the winning variant's budget
   - Record the learnings in `test_results` with `improvement_pct`
4. **Identify new testing opportunities** -- Send current campaign structure and recent performance to Claude using the `testRecommendation` system prompt. Claude recommends tests prioritized by:
   - Potential impact (based on traffic volume and current performance gap)
   - Effort level (simple copy test vs. full landing page test)
   - Test type: creative, audience, placement, bid strategy
5. **Create test tasks** -- For each recommended test, create a ClickUp task with the hypothesis, expected duration, and success criteria.
6. **Update knowledge base** -- Record all test outcomes in the `test_results` table via `recordTestResult()`.

### Outputs

- Updated test results in knowledge base
- Winner/loser designations for concluded tests
- WhatsApp summary of test results and new recommendations
- ClickUp tasks for new tests
- Historical test data for future campaign intelligence (feeds into Workflow 3)

### Related Files

| File | Role |
|------|------|
| `src/services/knowledge-base.js` | `test_results` table, `recordTestResult()` |
| `src/api/meta-ads.js` | Variant performance data |
| `src/api/google-ads.js` | Variant performance data |
| `src/api/anthropic.js` | `deepAnalysis()` for test recommendations |
| `src/prompts/templates.js` | `testRecommendation` system prompt |
| `src/api/clickup.js` | Test task creation |
| `src/api/whatsapp.js` | Results notification |

---

## Workflow 8: Weekly Client Report

**Schedule:** Every Friday at 4:00 PM Eastern (`0 16 * * 5`)

**Purpose:** Generate comprehensive weekly performance reports for each client and deliver them automatically.

### Trigger

Cron job `weekly-report` registered in `src/services/scheduler.js`.

### Process Steps

1. **Pull this week's data** -- For each active client, pull 7-day performance data from all connected platforms (Meta, Google Ads, TikTok).
2. **Pull last week's data** -- Pull the previous 7-day period for week-over-week comparison.
3. **Pull same week last month** -- Pull the corresponding week from the previous month for monthly trend context.
4. **Load targets** -- Retrieve client targets from the knowledge base: target ROAS, target CPA, monthly budget.
5. **Load active tests** -- Query running tests from `test_results` table.
6. **Generate report with Claude** -- Use the `clientReport` system prompt and `weeklyReport` user prompt template. Claude generates:
   - Executive Summary (3-4 sentences)
   - Key Metrics Table with week-over-week changes
   - What Worked Well section
   - Areas for Improvement
   - Specific, prioritized recommendations
   - Next Week Focus
7. **Format report** -- Create a formatted document suitable for client delivery.
8. **Save to Google Drive** -- Upload the report to the client's `Reports/` folder via `src/api/google-drive.js`.
9. **Update Google Sheets** -- Append weekly metrics to the master reporting spreadsheet for trend tracking.
10. **Send to AgencyAnalytics** -- If configured, push data to AgencyAnalytics via `src/api/agency-analytics.js` for white-label dashboards.
11. **Notify owner** -- Send a WhatsApp summary listing all generated reports with key highlights and any clients requiring attention.

### Outputs

- Weekly performance report per client (Google Drive)
- Google Sheets data update
- AgencyAnalytics dashboard update (if configured)
- WhatsApp summary to owner

### Related Files

| File | Role |
|------|------|
| `src/services/scheduler.js` | Cron registration (line 102) |
| `src/api/meta-ads.js` | Performance data |
| `src/api/google-ads.js` | Performance data |
| `src/api/tiktok-ads.js` | Performance data |
| `src/api/anthropic.js` | `deepAnalysis()` for report generation |
| `src/prompts/templates.js` | `clientReport`, `weeklyReport` prompts |
| `src/api/google-drive.js` | Report storage |
| `src/api/agency-analytics.js` | Dashboard push |
| `src/services/knowledge-base.js` | Client data, targets |

---

## Workflow 9: Monthly Strategic Review

**Schedule:** Last Friday of each month at 2:00 PM Eastern (`0 14 * * 5` with last-Friday-of-month logic)

**Purpose:** Deliver a deep strategic analysis for each client covering the full month, with forward-looking recommendations and the next month's plan.

### Trigger

Cron job `monthly-review` registered in `src/services/scheduler.js`. The handler includes logic to skip non-final Fridays.

### Process Steps

1. **Pull full month data** -- Aggregate 30-day performance data across all platforms for each client.
2. **Pull previous month** -- Retrieve the prior month for month-over-month comparison.
3. **Pull quarter data** -- Retrieve 90-day data for trend analysis.
4. **Compile test results** -- Gather all completed A/B test results from the month.
5. **Compile creative performance** -- Pull creative library data to identify fatigue patterns and top performers.
6. **Competitor intelligence** -- Pull latest competitor data from the `competitor_intel` table.
7. **Generate strategic analysis with Claude** -- Using the `strategicPlanning` system prompt (Sonnet, high token limit), produce:
   - Monthly performance summary with MoM trends
   - Budget efficiency analysis (actual vs. target)
   - Channel mix analysis (which platforms delivered best ROI)
   - Audience insights and recommendations
   - Creative performance review
   - Competitive landscape update
   - Recommendations for next month (prioritized, with expected impact)
   - Updated 90-day rolling plan
8. **Create deliverable** -- Format the analysis as a professional document.
9. **Save and distribute** -- Upload to Google Drive, update ClickUp with next month's strategic tasks, send WhatsApp notification.

### Outputs

- Monthly strategic review document per client (Google Drive)
- Updated strategic tasks in ClickUp
- Rolling 90-day plan update
- WhatsApp summary with key strategic insights

### Related Files

| File | Role |
|------|------|
| `src/services/scheduler.js` | Cron registration (line 105) |
| `src/api/anthropic.js` | `deepAnalysis()` for strategic analysis |
| `src/prompts/templates.js` | `strategicPlanning` system prompt |
| `src/services/knowledge-base.js` | All data tables |
| `src/api/google-drive.js` | Document storage |
| `src/api/clickup.js` | Strategic task creation |

---

## Workflow 10: WhatsApp Command Handler

**Schedule:** Real-time (webhook-driven)

**Purpose:** Allow the agency owner to manage the entire system via natural language WhatsApp messages -- check performance, pause campaigns, generate reports, and get intelligence on demand.

### Trigger

Incoming WhatsApp message to the Twilio webhook at `POST /webhook/whatsapp`. Only messages from `OWNER_WHATSAPP_NUMBER` are processed; all others are rejected.

### Process Steps

1. **Receive and validate** -- Express server receives the Twilio webhook POST. Responds with `200` immediately to prevent Twilio timeouts. Validates that `From` matches the configured owner number.
2. **Check for approval responses** -- Regex match against `^(APPROVE|DENY|DETAILS)\s+([a-f0-9-]+)`. If matched, route to `handleApproval()`.
3. **Parse intent with Claude** -- Send the message to Claude Haiku (fast, cheap) using the `commandParser` system prompt. Claude returns a JSON object with `intent` and `params`. Supported intents:
   - `stats` -- Performance statistics
   - `pause` -- Pause a campaign
   - `resume` -- Resume a campaign
   - `report` -- Generate a report
   - `overdue` -- Get overdue tasks
   - `briefing` -- Trigger morning briefing
   - `competitor` -- Run competitor analysis
   - `budget` -- Check budget pacing
   - `cost` -- AI cost report
   - `audit` -- View audit log
   - `client_info` -- Get client profile
   - `help` -- Show available commands
   - `unknown` -- Unrecognized command
4. **Route to handler** -- Switch on parsed intent and call the appropriate handler function.
5. **Execute and respond** -- Each handler fetches data, performs actions, and sends a formatted WhatsApp response.

### Approval Flow

When an action requires approval (campaign pause, budget change, launch):
1. System generates a unique approval ID (e.g., `pause-1706123456789`)
2. Stores the pending action in an in-memory `pendingApprovals` Map
3. Sends a formatted WhatsApp message with action details and instructions
4. User replies with `APPROVE [id]`, `DENY [id]`, or `DETAILS [id]`
5. System executes or cancels the action accordingly

### Outputs

- WhatsApp responses formatted for readability (WhatsApp markdown: `*bold*`, `_italic_`)
- Platform data fetched on demand
- Actions executed via safety system
- Audit log entries for all actions

### Related Files

| File | Role |
|------|------|
| `src/commands/whatsapp-server.js` | Full implementation |
| `src/api/whatsapp.js` | Message sending |
| `src/api/anthropic.js` | `askClaude()` for intent parsing |
| `src/prompts/templates.js` | `commandParser` system prompt |
| `src/api/meta-ads.js` | On-demand performance data |
| `src/api/google-ads.js` | On-demand performance data |
| `src/services/knowledge-base.js` | Client data retrieval |
| `src/services/cost-tracker.js` | Cost and audit data |
| `src/workflows/morning-briefing.js` | On-demand briefing |
| `src/workflows/clickup-monitor.js` | Task monitoring |

---

## Workflow 11: Competitor Monitoring

**Schedule:** Every Wednesday at 9:00 AM Eastern (`0 9 * * 3`)

**Purpose:** Research and analyze competitor advertising strategies to inform client campaigns.

### Trigger

Cron job `competitor-monitor` registered in `src/services/scheduler.js`.

### Process Steps

1. **Load client competitors** -- For each active client, retrieve the `competitors` JSON array from the knowledge base.
2. **Web research** -- For each competitor:
   - Search for active ad campaigns (Facebook Ad Library, Google Ads Transparency)
   - Analyze landing pages
   - Note messaging themes, offers, and creative approaches
3. **AI analysis** -- Send gathered data to Claude using the `competitorAnalysis` system prompt to produce:
   - Competitor ad themes and messaging patterns
   - Offer and promotion analysis
   - Creative approach assessment
   - Gaps and opportunities for our client
4. **Store intelligence** -- Save results to the `competitor_intel` table via the knowledge base, including: competitor name, date collected, ad themes, offers, creative approach, landing page URLs, and notes.
5. **Generate actionable insights** -- Identify specific opportunities where our client can differentiate or capitalize on competitor weaknesses.
6. **Notify** -- Send a WhatsApp summary with the most important competitor insights and recommended actions.

### Outputs

- Competitor intelligence records in knowledge base
- WhatsApp summary of key findings
- Actionable recommendations for campaign adjustments
- Data feeds into Workflow 3 (Campaign Brief Intelligence) and Workflow 9 (Monthly Review)

### Related Files

| File | Role |
|------|------|
| `src/services/scheduler.js` | Cron registration (line 108) |
| `src/services/knowledge-base.js` | `competitor_intel` table, client data |
| `src/api/anthropic.js` | `deepAnalysis()` for competitor analysis |
| `src/prompts/templates.js` | `competitorAnalysis` system prompt |
| `src/api/whatsapp.js` | Notification |

---

## Workflow 12: Cross-Department Opportunity Detection

**Schedule:** Daily at 6:00 PM Eastern (`0 18 * * *`)

**Purpose:** Identify opportunities where insights from one client or industry vertical can benefit another client, and detect cross-sell or service expansion opportunities.

### Trigger

Cron job `cross-department` registered in `src/services/scheduler.js`.

### Process Steps

1. **Aggregate daily data** -- Pull today's performance data across all clients and platforms.
2. **Pattern analysis** -- Use Claude to analyze cross-client patterns:
   - Which industries are seeing rising/falling CPMs
   - Which ad formats are outperforming across multiple clients
   - Which audience segments are becoming more/less expensive
   - Seasonal trends affecting multiple clients
3. **Cross-pollination opportunities** -- Identify where a strategy working for Client A could benefit Client B:
   - Similar industries with different approaches
   - Shared audience segments
   - Creative concepts that translated across verticals
4. **Service expansion detection** -- Flag clients where:
   - They only use one platform but would benefit from others
   - Their organic social could benefit from paid amplification
   - SEO/PPC synergy opportunities exist
5. **Generate recommendations** -- Produce specific, actionable cross-client insights.
6. **Notify** -- Send a WhatsApp summary if any meaningful opportunities are detected.

### Outputs

- Cross-client opportunity reports
- WhatsApp notification for significant findings
- Data stored for monthly strategic reviews (Workflow 9)

### Related Files

| File | Role |
|------|------|
| `src/services/scheduler.js` | Cron registration (line 111) |
| `src/services/knowledge-base.js` | Multi-client data access |
| `src/api/anthropic.js` | Pattern analysis |
| `src/api/whatsapp.js` | Notification |

---

## Workflow 13: Budget Pacing & Optimization

**Schedule:** Daily at 2:00 PM Eastern (`0 14 * * *`)

**Purpose:** Ensure all client budgets are on track for the month, redistribute budget between campaigns based on performance, and alert on pacing issues.

### Trigger

Cron job `budget-pacing` registered in `src/services/scheduler.js`.

### Process Steps

1. **Calculate monthly pacing** -- For each client:
   - Determine the day of the month and percentage of month elapsed
   - Sum total spend across all platforms
   - Compare actual spend vs. expected spend (linear pacing)
2. **Identify pacing issues**:
   - **Underspending (< 85% of expected):** Budget is being underutilized. Recommend increasing bids or expanding audiences.
   - **Overspending (> 115% of expected):** Risk of exhausting budget early. Recommend reducing bids or pausing low-performers.
   - **On track (85-115%):** No action needed.
3. **Performance-based reallocation** -- Analyze campaign-level ROAS and CPA within each client:
   - Identify top performers (above-target ROAS)
   - Identify underperformers (below-target ROAS)
   - Recommend shifting budget from underperformers to top performers
4. **Safety check** -- Any budget change recommendations run through `getBudgetChangeApproval()` in `src/services/safety.js`:
   - Changes < $50/day: auto-approved
   - Changes > $50/day: requires WhatsApp approval
   - Changes > 20% of total client budget: always requires approval
5. **Execute auto-approved changes** -- Small budget adjustments are executed automatically via `safeExecute()`.
6. **Alert on manual actions** -- Larger changes are sent via WhatsApp with approval requests.
7. **End-of-month urgency** -- In the last 5 days of the month, pacing alerts escalate to critical severity.

### Outputs

- Budget pacing report per client
- Auto-approved budget adjustments (small changes)
- WhatsApp alerts for pacing issues and approval requests
- Audit log entries for all budget changes

### Related Files

| File | Role |
|------|------|
| `src/services/scheduler.js` | Cron registration (line 96) |
| `src/workflows/daily-monitor.js` | Shared monitoring logic |
| `src/services/safety.js` | `getBudgetChangeApproval()`, `safeExecute()` |
| `src/api/meta-ads.js` | Budget updates |
| `src/api/google-ads.js` | Budget updates |
| `src/services/knowledge-base.js` | Client budgets and targets |
| `src/api/whatsapp.js` | Alerts and approvals |

---

## Workflow 14: Creative Fatigue Detection

**Schedule:** Daily at 11:00 AM Eastern (`0 11 * * *`)

**Purpose:** Monitor ad creative performance for signs of fatigue (declining CTR, rising frequency) and proactively recommend creative refreshes before performance degrades significantly.

### Trigger

Cron job `creative-fatigue` registered in `src/services/scheduler.js`.

### Process Steps

1. **Pull creative-level data** -- For each active client and platform, fetch ad-level performance data including CTR, frequency, impressions, and days running.
2. **Detect fatigue signals**:
   - **CTR decline:** Compare current 3-day CTR against the creative's lifetime average. Flag if CTR has dropped > 20%.
   - **Frequency creep:** Flag if ad frequency exceeds 3.0 (audience seeing the ad too often).
   - **Days running:** Flag creatives running for > 14 days without refresh (platform-dependent thresholds).
   - **Conversion rate decline:** Flag if conversion rate has dropped > 25% from peak.
3. **Score fatigue severity** -- Rate each creative on a fatigue scale:
   - **Green:** Performing well, no action needed
   - **Yellow:** Early signs of fatigue, schedule refresh
   - **Red:** Significant fatigue, immediate refresh needed
4. **Generate refresh recommendations** -- For fatigued creatives, use Claude to suggest:
   - New angle variations based on the original concept
   - Updated copy that addresses the same audience differently
   - Visual refresh suggestions
5. **Update creative library** -- Mark fatigued creatives with status `fatigued` in the `creative_library` table. Increment `days_running`.
6. **Create ClickUp tasks** -- For red-severity creatives, create urgent creative refresh tasks.
7. **Notify** -- Send WhatsApp summary of fatigued creatives and recommended actions.

### Outputs

- Updated creative status in knowledge base (`creative_library` table)
- Creative refresh recommendations
- ClickUp tasks for urgent refreshes
- WhatsApp fatigue alert

### Related Files

| File | Role |
|------|------|
| `src/services/scheduler.js` | Cron registration (line 99) |
| `src/services/knowledge-base.js` | `creative_library` table, `saveCreative()`, `getTopCreatives()` |
| `src/api/meta-ads.js` | Ad-level performance data |
| `src/api/google-ads.js` | Ad-level performance data |
| `src/api/anthropic.js` | Refresh recommendations |
| `src/api/clickup.js` | Refresh task creation |
| `src/api/whatsapp.js` | Fatigue alerts |

---

## Workflow 15: Landing Page Performance Integration

**Schedule:** Every Monday at 10:00 AM Eastern (`0 10 * * 1`)

**Purpose:** Analyze landing page performance in the context of ad campaign data to identify post-click optimization opportunities.

### Trigger

Cron job `landing-page-analysis` registered in `src/services/scheduler.js`.

### Process Steps

1. **Collect landing page URLs** -- For each active client, identify the landing pages used in active campaigns from ad creative data (link URLs from Meta ads, final URLs from Google Ads).
2. **Pull conversion data** -- Correlate ad platform conversion data with landing page URLs:
   - Conversion rate by landing page
   - Bounce rate indicators (where available)
   - Time on page metrics (where available via Google Analytics integration)
3. **Analyze landing page-campaign alignment** -- Use Claude to evaluate:
   - Message match between ad copy and landing page content
   - CTA consistency
   - Audience-landing page fit
4. **Identify optimization opportunities**:
   - Landing pages with high traffic but low conversion rates
   - Pages where ad messaging does not match landing page content
   - Mobile vs. desktop performance gaps
   - Load speed issues affecting conversion
5. **Generate recommendations** -- Produce specific landing page optimization recommendations tied to expected conversion rate improvement.
6. **Create tasks** -- Add ClickUp tasks for landing page optimizations, categorized by expected impact.
7. **Notify** -- Send WhatsApp summary with top landing page issues and opportunities.

### Outputs

- Landing page performance analysis per client
- Optimization recommendations with expected impact
- ClickUp tasks for landing page improvements
- WhatsApp summary of findings

### Related Files

| File | Role |
|------|------|
| `src/services/scheduler.js` | Cron registration (line 114) |
| `src/api/meta-ads.js` | Ad creative URLs and performance |
| `src/api/google-ads.js` | Final URL performance |
| `src/api/anthropic.js` | Landing page analysis |
| `src/api/clickup.js` | Task creation |
| `src/api/whatsapp.js` | Notification |

---

## Workflow Schedule Summary

| Workflow | Schedule | Cron Expression | Job Name |
|----------|----------|-----------------|----------|
| 1. Morning Briefing | Daily 8 AM | `0 8 * * *` | `morning-briefing` |
| 6. Daily Monitor (AM) | Daily 10 AM | `0 10 * * *` | `daily-monitor-10am` |
| 14. Creative Fatigue | Daily 11 AM | `0 11 * * *` | `creative-fatigue` |
| 13. Budget Pacing | Daily 2 PM | `0 14 * * *` | `budget-pacing` |
| 6. Daily Monitor (PM) | Daily 3 PM | `0 15 * * *` | `daily-monitor-3pm` |
| 12. Cross-Department | Daily 6 PM | `0 18 * * *` | `cross-department` |
| 6. Daily Monitor (Eve) | Daily 8 PM | `0 20 * * *` | `daily-monitor-8pm` |
| 11. Competitor Monitor | Wednesday 9 AM | `0 9 * * 3` | `competitor-monitor` |
| 8. Weekly Report | Friday 4 PM | `0 16 * * 5` | `weekly-report` |
| 9. Monthly Review | Last Friday 2 PM | `0 14 * * 5` | `monthly-review` |
| 15. Landing Page | Monday 10 AM | `0 10 * * 1` | `landing-page-analysis` |
| 2. Client Onboarding | HubSpot webhook | -- | -- |
| 3. Brief Intelligence | ClickUp webhook | -- | -- |
| 4. Creative Generation | ClickUp webhook | -- | -- |
| 5. Campaign Launch | ClickUp + WhatsApp | -- | -- |
| 7. A/B Test Mgmt | Weekly (scheduler) | -- | -- |
| 10. WhatsApp Commands | Real-time webhook | -- | -- |

All scheduled workflows use the `America/New_York` timezone by default (configurable per job in `src/services/scheduler.js`).
