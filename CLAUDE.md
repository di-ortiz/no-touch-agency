# No-Touch Agency

AI-powered PPC agency automation platform. Sofia (Claude-based) is a 24/7 Customer Success Agent managing ad campaigns, client onboarding, and reporting across WhatsApp and Telegram.

## Tech Stack

- **Runtime:** Node.js >=20, ESM modules, Express.js
- **Database:** SQLite (better-sqlite3) — `data/costs.db`, `data/knowledge.db`
- **AI:** Anthropic Claude (claude-haiku-4-5-20251001), OpenAI GPT-4o / DALL-E 3 / Sora 2
- **Channels:** WhatsApp Cloud API (Meta), Telegram Bot API
- **Ad Platforms:** Meta Ads (v22.0), Google Ads (v17 GAQL), TikTok Ads, Twitter/X Ads
- **Google Suite:** Drive, Sheets, Slides, Analytics 4
- **Other:** ClickUp, HubSpot, Leadsie, DataForSEO, PageSpeed Insights, AgencyAnalytics

## Commands

```bash
npm start                # Production server
npm run dev              # Development (watch mode)
npm test                 # Run all tests (node --test)
npm run lint             # ESLint
npm run whatsapp         # WhatsApp server only
npm run morning-briefing # Run morning briefing manually
npm run monitor          # Run daily monitor
npm run cost-report      # Print cost report
```

## Project Structure

```
src/
  index.js                  # Entry point — starts Express, scheduler, startup notification
  config.js                 # Zod-validated env config
  commands/
    whatsapp-server.js      # Main server (2600+ lines) — webhooks, 60+ CSA tools, Claude routing
  api/                      # 22 external API modules
    anthropic.js            # Claude API (askClaude, quickAnalysis, deepAnalysis)
    whatsapp.js             # WhatsApp Cloud API (sendWhatsApp, sendWhatsAppImage, sendWhatsAppVideo)
    telegram.js             # Telegram Bot API (sendTelegram, sendTelegramPhoto, sendTelegramVideo)
    meta-ads.js             # Meta Ads campaigns/insights
    google-ads.js           # Google Ads via GAQL
    openai-media.js         # DALL-E 3 images + Sora 2 videos
    dataforseo.js           # Keyword research, SERP, SEO audits
    [+15 more integrations]
  services/
    knowledge-base.js       # SQLite client DB — clients, contacts, campaigns, creatives, conversations
    client-onboarding-flow.js # 20-step conversational onboarding, multi-language welcome
    cost-tracker.js         # API cost logging and audit trail
    scheduler.js            # node-cron job manager
    safety.js               # Budget approval, auto-pause thresholds, action validation
    creative-engine.js      # Ad copy generation, platform specs
    brand-ingestion.js      # Brand guideline extraction
    report-builder.js       # Client report formatting
    presentation-builder.js # Google Slides generation
    chart-builder.js        # Google Sheets charts
  workflows/                # 15+ scheduled automations
    morning-briefing.js     # 8 AM — agency-wide intelligence briefing
    client-morning-briefing.js # 8:30 AM — personalized client briefings
    daily-monitor.js        # 9 AM, 3 PM, 8 PM — anomaly detection, auto-pause
    budget-pacing.js        # 2 PM — budget pacing adjustments
    weekly-report.js        # Friday 4 PM — performance reports w/ Slides
    monthly-review.js       # Last Friday — strategic reviews
    competitor-monitor.js   # Wednesday 9 AM — competitor tracking
    creative-fatigue.js     # 11 AM — creative fatigue detection
    client-check-in.js      # 9 AM — proactive follow-ups
    [+6 more workflows]
  utils/
    logger.js               # Winston: console + file (error.log, combined.log)
    rate-limiter.js         # p-queue per platform
    retry.js                # Exponential backoff
  prompts/                  # AI prompt templates
data/                       # SQLite databases
config/                     # Google service account JSON
```

## Architecture

### Message Flow
1. Webhook receives WhatsApp/Telegram message
2. Lookup contact → check onboarding session → check message limits (plan-based)
3. Build client context + conversation history (last 20 exchanges)
4. Send to Claude with 60+ tool definitions
5. Execute tool calls → deliver results + media inline
6. Save exchange to conversation_history

### Key Patterns
- **Single client, multi-channel:** contacts linked by client_id across WhatsApp/Telegram
- **Plan-based limits:** SMB (20 msgs/day), Medium (50), Enterprise (200) — counted across all channels
- **Safety system:** auto-approve small changes, require approval for launches, auto-pause failing campaigns
- **Cost tracking:** every AI call recorded with tokens/cost, daily budget enforcement
- **Rate limiting:** p-queue per platform (Anthropic 5/s, Meta 3/s, WhatsApp 1/s)
- **Error handling:** try/catch per client in workflows, retries for network errors, graceful fallbacks

### Database Tables (knowledge.db)
- `clients` — profiles, ad account IDs, budgets, brand info, Drive folders
- `client_contacts` — phone, name, email, role, channel, language
- `pending_clients` — pre-activation from website with token
- `onboarding_sessions` — conversational onboarding state machine
- `conversation_history` — chat_id + channel + role + content
- `campaign_history` — historical campaign performance
- `creative_library` — ad creatives with performance metrics
- `test_results` — A/B test tracking
- `competitor_intel` — competitor ad analysis
- `benchmarks` — industry benchmarks

### Sofia's Languages
Sofia supports EN, ES, PT. Language is detected from website conversion source and stored in client_contacts.language.

## Code Style
- ESM imports (`import`/`export`)
- Async/await throughout
- Winston structured logging with child loggers
- Zod for config validation
- UUID for IDs
- Consistent error handling: try/catch with log.error + graceful fallback
