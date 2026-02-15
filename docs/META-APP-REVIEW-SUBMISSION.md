# Meta App Review Submission Guide

## Overview

App Name: **No-Touch**
App ID: **760261177146243**
Business ID: **412107959434423**

---

## Use Cases to Submit

Your app has **two use cases** that need App Review:

### Use Case 1: Connect with customers through WhatsApp
### Use Case 2: Create and manage ads (Marketing API)

---

## USE CASE 1: Connect with customers through WhatsApp

### Permissions Required

#### 1. whatsapp_business_manage_events
**What it does:** Allows the app to manage WhatsApp Business phone numbers and read their details.

**How your app uses it:**
> Our platform reads WhatsApp Business phone number details (verified name, quality rating, messaging tier) to monitor the health of our WhatsApp Business integration. This ensures messages are being delivered reliably to agency owners who receive daily campaign briefings, performance alerts, and approval requests via WhatsApp.

**API calls made:**
- `GET /{phone_number_id}?fields=verified_name,display_phone_number,quality_rating,messaging_limit_tier`

---

#### 2. whatsapp_business_messaging
**What it does:** Allows the app to send and receive WhatsApp messages.

**How your app uses it:**
> Our AI-powered PPC agency platform uses WhatsApp as the primary communication channel between the system and the agency owner. The app sends:
> - **Daily morning briefings** summarizing campaign performance across all clients
> - **Performance alerts** when campaigns underperform or budgets need attention
> - **Approval requests** before making significant campaign changes (pausing campaigns, adjusting budgets)
> - **Responses to owner commands** — the owner can ask questions like "How is Client X performing?" and receive AI-generated answers with real data
>
> The app also receives incoming WhatsApp messages from the owner to process commands and approval responses.

**API calls made:**
- `POST /{phone_number_id}/messages` — Send text messages
- Webhook: `POST /webhook/whatsapp` — Receive incoming messages
- Webhook: `GET /webhook/whatsapp` — Webhook verification

---

#### 3. manage_app_solution
**What it does:** Allows management of the WhatsApp Business Solution.

**How your app uses it:**
> Required for managing our WhatsApp Business API integration as part of the Tech Provider solution. This allows us to maintain and configure the WhatsApp Business connection that powers our agency communication system.

---

#### 4. business_management (WhatsApp section)
**What it does:** Allows the app to read and manage the business account.

**How your app uses it:**
> We read business account information to verify the business identity and retrieve business users. This is used during app initialization to confirm the correct business account is connected and to identify authorized users.

**API calls made:**
- `GET /{business_id}?fields=name,id,primary_page,timezone_id,vertical`
- `GET /{business_id}/business_users?fields=name,role`

---

## USE CASE 2: Create and manage ads (Marketing API)

### Permissions Required

#### 1. business_management
**What it does:** Allows the app to access Business Manager owned assets.

**How your app uses it:**
> Our platform manages multiple client ad accounts through a single Business Manager. We use this permission to:
> - Retrieve all owned ad accounts for multi-client campaign management
> - List owned Facebook Pages for ad creation and management
> - Access system users for API authentication
> - Read business profile information for dashboard display

**API calls made:**
- `GET /{business_id}/owned_ad_accounts?fields=name,account_id,account_status,currency,timezone_name,amount_spent`
- `GET /{business_id}/owned_pages?fields=name,id,fan_count,category`
- `GET /{business_id}/system_users?fields=name,role`
- `GET /{business_id}?fields=name,id,primary_page`

---

#### 2. ads_read
**What it does:** Allows the app to read ad account data.

**How your app uses it:**
> This is the core permission for our campaign monitoring system. We read campaign, ad set, and ad data to:
> - **Morning Briefings:** Pull yesterday's performance (spend, conversions, ROAS, CPA) for each client
> - **Daily Monitoring (3x/day):** Check campaign health, identify underperformers
> - **Weekly Reports:** Generate 7-day performance summaries for clients
> - **Budget Pacing:** Track daily spend against monthly budgets
> - **On-demand queries:** When the agency owner asks "How is [client] doing?" via WhatsApp

**API calls made:**
- `GET /act_{account_id}/campaigns?fields=name,status,objective,daily_budget`
- `GET /act_{account_id}/adsets?fields=name,status,daily_budget,optimization_goal`
- `GET /act_{account_id}/ads?fields=name,status`
- `GET /act_{account_id}/insights?fields=spend,impressions,clicks,cpc,cpm,ctr,reach&date_preset=last_30d`
- `GET /{campaign_id}/insights?fields=spend,impressions,clicks,actions,cost_per_action_type,conversions,conversion_values`

---

#### 3. ads_management
**What it does:** Allows the app to create and modify ads.

**How your app uses it:**
> Our platform automates campaign optimization with human-in-the-loop approval:
> - **Auto-pause underperformers:** When a campaign exceeds CPA thresholds, the system requests owner approval via WhatsApp, then pauses the campaign
> - **Budget adjustments:** Reallocate daily budgets based on pacing analysis
> - **Campaign status management:** Pause/resume campaigns based on owner commands
> - **Custom audience management:** Read audience data for targeting analysis
> - **Creative management:** Read ad creatives for performance analysis
>
> All modifications require owner approval via WhatsApp before execution. The system has safety rails including spending limits and an audit trail.

**API calls made:**
- `POST /{campaign_id}` — Update campaign status (pause/enable)
- `POST /{ad_set_id}` — Update ad set budget
- `GET /act_{account_id}/customaudiences?fields=name,subtype`
- `GET /act_{account_id}/adcreatives?fields=name,title,body`

---

#### 4. pages_show_list
**What it does:** Allows the app to list Pages the user manages.

**How your app uses it:**
> We list pages the user manages to identify which Facebook Pages are available for ad creation, lead form management, and engagement tracking. This is used during client onboarding and when generating ads that link to client Pages.

**API calls made:**
- `GET /me/accounts?fields=name,id,category,access_token`

---

#### 5. pages_read_engagement
**What it does:** Allows the app to read Page engagement data.

**How your app uses it:**
> We read Page engagement data (fan count, post engagement, talking-about count) to:
> - Include organic performance in client reports alongside paid metrics
> - Monitor Page health as part of the overall marketing dashboard
> - Track post performance for content strategy recommendations

**API calls made:**
- `GET /{page_id}?fields=name,fan_count,new_like_count,talking_about_count`
- `GET /{page_id}/posts?fields=message,created_time`

---

#### 6. pages_manage_ads
**What it does:** Allows the app to manage ads on Pages.

**How your app uses it:**
> We use this permission to manage lead generation forms on client Pages. Our platform monitors existing leadgen forms and their status as part of the lead generation campaign workflow.

**API calls made:**
- `GET /{page_id}/leadgen_forms?fields=name,status`

---

#### 7. catalog_management
**What it does:** Allows the app to manage product catalogs.

**How your app uses it:**
> We read product catalog data for e-commerce clients who run dynamic product ads. This allows us to monitor catalog health (product count, catalog status) and ensure dynamic ads have the correct product feed connected.

**API calls made:**
- `GET /{business_id}/owned_product_catalogs?fields=name,id,product_count`

---

#### 8. Ads Management Standard Access
**What it does:** Elevated access level for the Marketing API.

**How your app uses it:**
> Standard Access is required because our platform manages multiple client ad accounts through a single Business Manager. We need higher rate limits and the ability to manage campaigns across multiple accounts programmatically. Our platform performs automated monitoring (3x daily), generates reports, and optimizes campaigns for multiple clients.

---

## STEP-BY-STEP SUBMISSION INSTRUCTIONS

### Step 1: Go to App Review
1. Go to https://developers.facebook.com/apps/760261177146243/review/
2. Or navigate: App Dashboard → App Review → Permissions and Features

### Step 2: Submit Use Case 1 (WhatsApp)
1. Click **"Start a Request"** or find the WhatsApp use case
2. For each permission listed above:
   - Click **"Request"** next to the permission
   - Fill in the description using the text provided above
   - Upload a **screencast** showing the feature in action (see Screencast Guide below)

### Step 3: Submit Use Case 2 (Marketing API)
1. Click **"Start a Request"** or find the Marketing API use case
2. For each permission listed above:
   - Click **"Request"** next to the permission
   - Fill in the description using the text provided above
   - Upload a **screencast** showing the feature in action

### Step 4: Provide App Verification Details
Meta may ask for:
- **Privacy Policy URL** — Must be publicly accessible
- **Terms of Service URL** — Must be publicly accessible
- **App Icon** — 1024x1024 PNG
- **Business Verification** — Your business must be verified in Business Manager

---

## SCREENCAST GUIDE

Meta requires short screencasts (video recordings) showing how each permission is used. Here's what to record:

### For WhatsApp permissions:
Record your phone showing:
1. Receiving a morning briefing message from the bot
2. Sending a command like "How is CanadianSim doing?"
3. Receiving the AI-generated response with real campaign data
4. Receiving an approval request and responding "approve"

### For Marketing API permissions:
Record your screen showing:
1. The app starting up and connecting to Meta APIs
2. Terminal/logs showing campaign data being pulled
3. A WhatsApp message with a performance report
4. The approval flow for pausing a campaign

### Recording Tips:
- Keep each video under **2 minutes**
- Show the **actual API responses** (terminal output is fine)
- Narrate or add captions explaining what's happening
- Use **OBS Studio** (free) or **Loom** to record
- Upload as MP4, under 50MB

---

## COMMON REJECTION REASONS & HOW TO AVOID

1. **"We couldn't verify how the permission is used"**
   - Make sure your screencast clearly shows the feature working
   - Show real API responses, not mock data

2. **"The app doesn't appear to be live"**
   - Make sure your Railway deployment is running
   - The webhook URL must be accessible: `https://your-app.up.railway.app/webhook/whatsapp`

3. **"Privacy policy is missing or incomplete"**
   - Must mention data collection, storage, and deletion
   - Must be on a publicly accessible URL

4. **"Business verification incomplete"**
   - Go to Business Manager → Settings → Business Verification
   - Submit business documents if not already verified

---

## CURRENT TOKEN STATUS (from test run Feb 15, 2026)

| Permission | Status | Notes |
|---|---|---|
| whatsapp_business_manage_events | ✅ PASS | Phone details retrieved |
| manage_app_solution | ✅ PASS | App details retrieved |
| business_management | ✅ PASS | Business info, users, ad accounts, pages, system users |
| pages_show_list | ✅ PASS | Pages listed with tokens |
| pages_read_engagement | ✅ PASS | Page info and posts retrieved |
| pages_manage_ads | ✅ PASS | Leadgen forms retrieved |
| ads_read | ✅ PASS | Campaigns, insights, ad sets, ads |
| ads_management | ✅ PASS | Creatives retrieved |
| catalog_management | ✅ PASS | Product catalogs retrieved |
| threads_business_basic | ✅ PASS | User profile retrieved |

**All 19/20 tests passed.** The one failure was a script bug (wrong field name), not a permission issue.
