# PPC Agency Automation -- Setup Guide

Complete setup instructions for the AI-powered PPC agency automation system. This system uses Claude as the core AI to monitor ad campaigns, manage tasks, generate reports, and communicate with you via WhatsApp.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Installation](#2-installation)
3. [API Credential Setup](#3-api-credential-setup)
4. [Running the Setup Checker](#4-running-the-setup-checker)
5. [Starting the System](#5-starting-the-system)
6. [Exposing the Webhook](#6-exposing-the-webhook)
7. [WhatsApp Sandbox Testing](#7-whatsapp-sandbox-testing)
8. [Production Deployment](#8-production-deployment)

---

## 1. Prerequisites

Before you begin, make sure you have the following:

- **Node.js 20 or higher** -- This project uses ES modules, the native test runner, and the `--watch` flag, all of which require Node 20+. Download from [https://nodejs.org/](https://nodejs.org/) or use a version manager like `nvm`:
  ```bash
  nvm install 20
  nvm use 20
  node --version   # Should print v20.x.x or higher
  ```

- **npm** -- Comes bundled with Node.js. Verify with:
  ```bash
  npm --version
  ```

- **A server or tunnel for webhooks** -- Twilio sends incoming WhatsApp messages to your server via HTTP POST. You need either:
  - A publicly accessible server (VPS, cloud instance, etc.) for production
  - [ngrok](https://ngrok.com/) for local development and testing

- **Git** -- To clone the repository.

---

## 2. Installation

```bash
# Clone the repository
git clone <your-repo-url> ppc-agency-automation
cd ppc-agency-automation

# Install dependencies
npm install

# Copy the example environment file
cp .env.example .env
```

Open `.env` in your editor. The rest of this guide walks through every credential you need to fill in.

The system also expects two directories to exist at runtime (`data/` and `logs/`). These are created automatically on first start, but you can create them now if you prefer:

```bash
mkdir -p data logs
```

If you plan to use Google APIs, create the config directory for the service account key:

```bash
mkdir -p config
```

---

## 3. API Credential Setup

The system has **required** and **optional** integrations. You must configure the required ones to start the system. Optional integrations can be added later as you enable each advertising platform.

### Required Credentials

#### 3.1 Anthropic (Claude API)

Claude is the core AI that powers every workflow in the system.

1. Go to [https://console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Sign up or log in to your Anthropic account
3. Click **Create Key**
4. Copy the key (it starts with `sk-ant-`)

```env
ANTHROPIC_API_KEY=sk-ant-xxxxx
```

**Pricing note:** The system uses Claude for every workflow execution. The built-in cost tracker monitors usage against your `MONTHLY_AI_BUDGET_CENTS` setting (default: $1,000/month). Adjust this in `.env` based on your expected usage.

---

#### 3.2 Twilio (WhatsApp)

Twilio provides the WhatsApp messaging layer. You send commands to the system and receive alerts through WhatsApp.

**Account Setup:**

1. Go to [https://www.twilio.com/try-twilio](https://www.twilio.com/try-twilio) and create an account
2. After verifying your email and phone number, you land on the Twilio Console
3. Your **Account SID** and **Auth Token** are displayed on the console dashboard at [https://console.twilio.com/](https://console.twilio.com/)

```env
TWILIO_ACCOUNT_SID=ACxxxxx
TWILIO_AUTH_TOKEN=xxxxx
```

**WhatsApp Sandbox Setup (for development):**

1. In the Twilio Console, go to **Messaging > Try it out > Send a WhatsApp message** or navigate directly to [https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn](https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn)
2. Follow the instructions to join the sandbox: send the displayed join code (e.g., `join <word>-<word>`) from your personal WhatsApp to the Twilio sandbox number
3. The sandbox number is typically `+1 415 523 8886`

```env
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
OWNER_WHATSAPP_NUMBER=whatsapp:+1XXXXXXXXXX
```

Replace `+1XXXXXXXXXX` with your actual WhatsApp phone number in E.164 format (e.g., `+12125551234`).

**Webhook URL Configuration:**

1. In the Twilio Console, go to **Messaging > Settings > WhatsApp Sandbox Settings**
2. Set the **"When a message comes in"** webhook URL to:
   ```
   https://your-server.com/webhook
   ```
   (In development, this will be your ngrok URL -- see [Section 6](#6-exposing-the-webhook))
3. Set the HTTP method to **POST**
4. Save the configuration

---

#### 3.3 ClickUp

ClickUp is used for task management -- tracking client work, campaign tasks, and internal operations.

**Getting Your API Token:**

1. Log in to ClickUp
2. Click your avatar in the bottom-left corner
3. Go to **Settings > Apps** (or navigate to [https://app.clickup.com/settings/apps](https://app.clickup.com/settings/apps))
4. Under **API Token**, click **Generate** (or copy your existing token)
5. The token starts with `pk_`

```env
CLICKUP_API_TOKEN=pk_xxxxx
```

**Finding Your Team ID:**

Your Team ID (also called Workspace ID) appears in your ClickUp URLs. For example, in `https://app.clickup.com/12345678/home`, the Team ID is `12345678`.

Alternatively, use the API:
```bash
curl -H "Authorization: pk_xxxxx" https://api.clickup.com/api/v2/team
```

**Finding Your Space ID:**

The Space ID for your PPC workspace can be found in the URL when you click into a Space, or via the API:
```bash
curl -H "Authorization: pk_xxxxx" https://api.clickup.com/api/v2/team/YOUR_TEAM_ID/space
```

```env
CLICKUP_TEAM_ID=12345678
CLICKUP_PPC_SPACE_ID=87654321
```

---

### Optional Credentials

These integrations are optional. The system starts without them and logs a notice for any missing platform credentials.

#### 3.4 Google (Drive and Docs)

Used for storing generated reports, documents, and shared assets in Google Drive.

**Service Account Setup:**

1. Go to [https://console.cloud.google.com/](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the following APIs (go to **APIs & Services > Library**):
   - Google Drive API
   - Google Sheets API
   - Google Docs API
4. Go to **APIs & Services > Credentials**
5. Click **Create Credentials > Service Account**
6. Fill in a name (e.g., `ppc-automation`) and click **Create and Continue**
7. Grant the role **Editor** (or a more restrictive role if preferred), then click **Done**
8. Click on the newly created service account
9. Go to the **Keys** tab
10. Click **Add Key > Create new key > JSON**
11. The JSON key file downloads automatically. Move it to your project:
    ```bash
    mv ~/Downloads/your-project-xxxxxx.json config/google-service-account.json
    ```

**Sharing folders with the service account:**

The service account has its own email address (visible in the JSON file under `client_email`, e.g., `ppc-automation@your-project.iam.gserviceaccount.com`). Share your target Google Drive folder with this email address, giving it **Editor** access.

**Finding the Drive Folder ID:**

Open the folder in Google Drive. The URL looks like `https://drive.google.com/drive/folders/1aBcDeFgHiJkLmNoPqRsT`. The ID is the string after `/folders/`.

```env
GOOGLE_APPLICATION_CREDENTIALS=config/google-service-account.json
GOOGLE_DRIVE_ROOT_FOLDER_ID=1aBcDeFgHiJkLmNoPqRsT
GOOGLE_SHEETS_REPORTS_ID=
```

For `GOOGLE_SHEETS_REPORTS_ID`, create a Google Sheet for reports and grab its ID from the URL: `https://docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit`.

---

#### 3.5 HubSpot

Used for CRM integration -- pulling client data, deal information, and syncing contact activity.

**Creating a Private App:**

1. Log in to HubSpot and go to **Settings** (gear icon in the top navigation)
2. In the left sidebar, navigate to **Integrations > Private Apps**
3. Click **Create a private app**
4. Give it a name (e.g., `PPC Automation`)
5. Go to the **Scopes** tab and enable the scopes you need:
   - `crm.objects.contacts.read`
   - `crm.objects.deals.read`
   - `crm.objects.companies.read`
   - Any other scopes relevant to your use case
6. Click **Create app**
7. Copy the access token shown (starts with `pat-`)

```env
HUBSPOT_ACCESS_TOKEN=pat-xxxxx
```

---

#### 3.6 Meta Marketing API (Facebook/Instagram Ads)

Used for pulling campaign performance data, managing ad budgets, and pausing underperforming ads.

**App Creation:**

1. Go to [https://developers.facebook.com/apps/](https://developers.facebook.com/apps/)
2. Click **Create App**
3. Select **Business** as the app type
4. Fill in the app name and contact email, select your Business portfolio
5. Click **Create App**
6. Your **App ID** and **App Secret** are on the app dashboard (under **Settings > Basic**)

**Required Permissions:**

In your app's dashboard, go to **Add Products** and add **Marketing API**. Then request the following permissions via App Review or use them in development mode with your own ad accounts:
- `ads_management`
- `ads_read`
- `business_management`
- `read_insights`

**Generating a Long-Lived Token:**

Short-lived tokens expire in about an hour. You need a long-lived token:

1. Go to [https://developers.facebook.com/tools/explorer/](https://developers.facebook.com/tools/explorer/)
2. Select your app from the dropdown
3. Click **Generate Access Token** and grant the required permissions
4. Copy the short-lived token
5. Exchange it for a long-lived token (valid ~60 days):
   ```bash
   curl "https://graph.facebook.com/v21.0/oauth/access_token?\
   grant_type=fb_exchange_token&\
   client_id=YOUR_APP_ID&\
   client_secret=YOUR_APP_SECRET&\
   fb_exchange_token=YOUR_SHORT_LIVED_TOKEN"
   ```
6. The response contains your long-lived `access_token`

**Important:** Long-lived tokens still expire (~60 days). For production, implement a System User token through Meta Business Suite, which does not expire. Navigate to **Business Settings > System Users**, create a system user, and generate a token with the required permissions.

**Finding Your Business ID:**

Go to [https://business.facebook.com/settings/](https://business.facebook.com/settings/). Your Business ID is in the URL or displayed under **Business Info**.

```env
META_APP_ID=123456789
META_APP_SECRET=abcdef123456
META_ACCESS_TOKEN=EAAxxxxxxx
META_BUSINESS_ID=987654321
```

---

#### 3.7 Google Ads

Used for pulling Google Ads campaign data, managing bids, and pausing poor performers.

**Developer Token:**

1. Sign in to your Google Ads Manager account at [https://ads.google.com/](https://ads.google.com/)
2. Go to **Tools & Settings > Setup > API Center**
3. If you do not see the API Center, you need to apply for API access at [https://developers.google.com/google-ads/api/docs/get-started/dev-token](https://developers.google.com/google-ads/api/docs/get-started/dev-token)
4. Your developer token is shown on the API Center page
5. Note: the token starts in **test mode** (can only access accounts you list explicitly). Apply for **basic** or **standard** access for production use

```env
GOOGLE_ADS_DEVELOPER_TOKEN=xxxxxxxxxxxxxxxx
```

**OAuth2 Setup:**

1. Go to [https://console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
2. Select or create a project (can be the same project as your Google Drive setup)
3. Enable the **Google Ads API** under **APIs & Services > Library**
4. Go to **APIs & Services > Credentials**
5. Click **Create Credentials > OAuth client ID**
6. Application type: **Web application** (or **Desktop app** for easier refresh token generation)
7. Add `https://developers.google.com/oauthplayground` as an authorized redirect URI
8. Copy the **Client ID** and **Client Secret**

**Generating a Refresh Token:**

1. Go to [https://developers.google.com/oauthplayground/](https://developers.google.com/oauthplayground/)
2. Click the gear icon (settings) in the top right
3. Check **Use your own OAuth credentials**
4. Enter your Client ID and Client Secret
5. In the left panel, find **Google Ads API v17** and select `https://www.googleapis.com/auth/adwords`
6. Click **Authorize APIs** and sign in with the Google account that has access to your Google Ads
7. Click **Exchange authorization code for tokens**
8. Copy the **Refresh token**

**Manager Account ID:**

Your MCC (Manager account) ID is displayed in the top-right corner of Google Ads when logged into the manager account. Format: `xxx-xxx-xxxx` (enter without dashes).

```env
GOOGLE_ADS_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_ADS_CLIENT_SECRET=GOCSPX-xxxxx
GOOGLE_ADS_REFRESH_TOKEN=1//xxxxx
GOOGLE_ADS_MANAGER_ACCOUNT_ID=1234567890
```

---

#### 3.8 TikTok Ads

Used for pulling TikTok ad campaign performance and managing campaigns.

**Getting API Access:**

1. Go to the TikTok Marketing API portal: [https://business-api.tiktok.com/portal/docs](https://business-api.tiktok.com/portal/docs)
2. Click **My Apps** in the top navigation (log in with your TikTok Business Center account)
3. Click **Create an App**
4. Fill in the app details, select **Ads Management** as the product
5. Request the following scopes:
   - `Ad Account Management`
   - `Ad Management`
   - `Reporting`
6. Submit for review (approval typically takes 1--2 business days)

**Generating an Access Token:**

1. Once your app is approved, go to your app's page in the developer portal
2. Under **Tools > Authorization**, generate a long-lived access token
3. Select the advertiser accounts you want to grant access to

```env
TIKTOK_ACCESS_TOKEN=xxxxx
TIKTOK_APP_ID=xxxxx
TIKTOK_APP_SECRET=xxxxx
```

---

#### 3.9 X/Twitter Ads

Used for managing Twitter/X ad campaigns.

**Developer Account Setup:**

1. Go to [https://developer.x.com/en/portal/dashboard](https://developer.x.com/en/portal/dashboard)
2. Sign up for a developer account if you do not already have one (requires approval)
3. Create a new **Project** and then an **App** within it
4. In your app settings, go to **Keys and Tokens**
5. Under **Consumer Keys**, find your **API Key** and **API Key Secret**
6. Under **Authentication Tokens**, generate an **Access Token** and **Access Token Secret**
7. Make sure to set the app permissions to **Read and Write**

**OAuth 1.0a Credentials:**

Twitter Ads API uses OAuth 1.0a. All four tokens are required:

```env
TWITTER_API_KEY=xxxxxxxxxxxxxxx
TWITTER_API_SECRET=xxxxxxxxxxxxxxx
TWITTER_ACCESS_TOKEN=xxxxxxxxxxxxxxx
TWITTER_ACCESS_SECRET=xxxxxxxxxxxxxxx
```

**Ads Account ID:**

1. Log in to [https://ads.x.com/](https://ads.x.com/)
2. Your Ads Account ID is in the URL or in account settings
3. Format is typically a numeric string like `18ce54xxxxx`

```env
TWITTER_ADS_ACCOUNT_ID=18ce54xxxxx
```

**Note:** Access to the Twitter Ads API requires an approved Ads API application. Apply at [https://developer.x.com/en/docs/twitter-ads-api/getting-started](https://developer.x.com/en/docs/twitter-ads-api/getting-started).

---

#### 3.10 AgencyAnalytics

Used for pulling unified reporting data across channels.

1. Log in to your AgencyAnalytics account
2. Go to **Settings > API** (or ask your account admin for access)
3. Generate or copy your API key

```env
AGENCY_ANALYTICS_API_KEY=xxxxx
```

---

#### 3.11 OpenAI (DALL-E)

Used for generating ad creative images via DALL-E.

1. Go to [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Sign up or log in
3. Click **Create new secret key**
4. Copy the key (starts with `sk-`)

```env
OPENAI_API_KEY=sk-xxxxx
```

**Pricing note:** DALL-E image generation is billed per image. See [https://openai.com/pricing](https://openai.com/pricing) for current rates.

---

## 4. Running the Setup Checker

After filling in your `.env` file, verify your configuration:

```bash
npm run setup:check
```

This script validates every credential in your `.env` file and reports which integrations are configured. Output looks like:

```
PPC Agency Automation - Setup Check

============================================================
  [pass] Anthropic API Key
  [pass] Twilio Account SID
  [pass] Twilio Auth Token
  [pass] Twilio WhatsApp From
  [pass] Owner WhatsApp Number
  [pass] ClickUp API Token
  [pass] ClickUp Team ID
  [skip] ClickUp PPC Space ID - optional
  [skip] Google Service Account - optional
  ...
============================================================

Results:
  Required: 7/7 configured
  Optional: 3/10 configured

All required credentials configured!
```

The checker distinguishes between:
- **Required** credentials (Anthropic, Twilio, ClickUp) -- the system will not start without these
- **Optional** credentials (all ad platforms, Google, HubSpot, etc.) -- enable these as needed

Fix any required credentials that are missing before proceeding.

---

## 5. Starting the System

Once setup passes, start the system:

```bash
# Production mode
npm start

# Development mode (auto-restarts on file changes)
npm run dev
```

This does two things:
1. Starts the Express webhook server on the configured `PORT` (default: `3000`)
2. Initializes the scheduled workflows (morning briefings, daily monitoring, budget pacing, etc.)

You can also run individual components:

```bash
# WhatsApp server only
npm run whatsapp

# Morning briefing (one-shot)
npm run morning-briefing

# Daily monitor (one-shot)
npm run monitor

# Cost report
npm run cost-report
```

---

## 6. Exposing the Webhook

Twilio must be able to reach your server over HTTPS to deliver incoming WhatsApp messages.

### For Development: ngrok

1. Install ngrok from [https://ngrok.com/download](https://ngrok.com/download) or via npm:
   ```bash
   npm install -g ngrok
   ```

2. Start your application:
   ```bash
   npm start
   ```

3. In a separate terminal, start ngrok:
   ```bash
   ngrok http 3000
   ```

4. ngrok displays a public URL like `https://a1b2c3d4.ngrok-free.app`

5. Copy the HTTPS URL and update your Twilio webhook configuration:
   - Go to [https://console.twilio.com/](https://console.twilio.com/)
   - Navigate to **Messaging > Settings > WhatsApp Sandbox Settings**
   - Set **"When a message comes in"** to:
     ```
     https://a1b2c3d4.ngrok-free.app/webhook
     ```
   - Method: **POST**
   - Save

**Note:** The free ngrok URL changes every time you restart ngrok. For a stable URL, use ngrok's paid plan or deploy to a server.

### For Production: Direct Server Access

On a server with a public IP and domain name:

1. Point your domain (e.g., `automation.youragency.com`) to your server's IP via DNS
2. Set up a reverse proxy (nginx or Caddy) to forward traffic to port 3000
3. Enable HTTPS with Let's Encrypt:

**nginx example** (`/etc/nginx/sites-available/ppc-automation`):
```nginx
server {
    listen 443 ssl;
    server_name automation.youragency.com;

    ssl_certificate /etc/letsencrypt/live/automation.youragency.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/automation.youragency.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Set your Twilio webhook to `https://automation.youragency.com/webhook`.

---

## 7. WhatsApp Sandbox Testing

Before deploying to production, test the full flow using the Twilio sandbox.

1. Make sure you have joined the sandbox (see [Section 3.2](#32-twilio-whatsapp))

2. Make sure your webhook URL is configured and your server is running

3. Send a test message from your WhatsApp to the sandbox number. Try these commands:
   - `status` -- Get a system status overview
   - `briefing` -- Trigger a morning briefing
   - `clients` -- List configured clients
   - `help` -- See available commands

4. Check your server logs for incoming webhook activity:
   ```bash
   tail -f logs/combined.log
   ```

5. If messages are not arriving, verify:
   - Your ngrok tunnel (or server) is running and accessible
   - The webhook URL in Twilio matches your server (including `/webhook` path)
   - Your sandbox session has not expired (re-join if needed by sending the join code again)

**Sandbox limitations:**
- The sandbox session expires after 72 hours of inactivity. You need to re-send the join code to rejoin.
- Only numbers that have joined the sandbox can receive messages.
- For production WhatsApp, you need an approved Twilio WhatsApp sender (a registered business number). See [https://www.twilio.com/docs/whatsapp](https://www.twilio.com/docs/whatsapp).

---

## 8. Production Deployment

### Process Management with PM2

PM2 keeps your application running, restarts it on crashes, and manages logs.

```bash
# Install PM2 globally
npm install -g pm2

# Start the application
pm2 start src/index.js --name ppc-automation --node-args="--env-file=.env"

# Or use an ecosystem file for more control
```

Create `ecosystem.config.cjs`:
```javascript
module.exports = {
  apps: [{
    name: 'ppc-automation',
    script: 'src/index.js',
    node_args: '--env-file=.env',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
  }],
};
```

```bash
pm2 start ecosystem.config.cjs
pm2 save       # Persist across reboots
pm2 startup    # Generate system startup script
```

Useful PM2 commands:
```bash
pm2 logs ppc-automation     # View logs
pm2 monit                   # Monitor CPU/memory
pm2 restart ppc-automation  # Restart
pm2 stop ppc-automation     # Stop
```

### Docker Deployment

Create a `Dockerfile`:
```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

RUN mkdir -p data logs

EXPOSE 3000

CMD ["node", "src/index.js"]
```

Create a `.dockerignore`:
```
node_modules
.env
logs/
data/
.git
```

Build and run:
```bash
docker build -t ppc-automation .
docker run -d \
  --name ppc-automation \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/config:/app/config \
  ppc-automation
```

### Production Checklist

- [ ] Set `NODE_ENV=production` in `.env`
- [ ] Configure all required credentials and verify with `npm run setup:check`
- [ ] Set up HTTPS (via nginx/Caddy + Let's Encrypt)
- [ ] Configure Twilio webhook to your production HTTPS URL
- [ ] Set appropriate cost and safety thresholds in `.env`:
  - `MONTHLY_AI_BUDGET_CENTS` -- Maximum monthly spend on AI API calls (in cents)
  - `DAILY_COST_ALERT_THRESHOLD_CENTS` -- Daily spend alert threshold (in cents)
  - `AUTO_APPROVE_BUDGET_CHANGE_LIMIT` -- Max budget change (in cents) the system can make without approval
  - `AUTO_APPROVE_BID_CHANGE_PCT` -- Max bid change percentage without approval
  - `AUTO_PAUSE_ROAS_THRESHOLD` -- ROAS below this triggers auto-pause
  - `AUTO_PAUSE_CPA_MULTIPLIER` -- CPA above target multiplied by this triggers auto-pause
- [ ] Use PM2 or Docker for process management
- [ ] Set up log rotation (PM2 handles this, or use `logrotate` for Docker)
- [ ] Upgrade from the Twilio WhatsApp sandbox to a registered business number
- [ ] For Meta Ads, set up a System User token (does not expire) instead of a user token
- [ ] Schedule regular backup of the `data/` directory (contains the cost tracking SQLite database)
- [ ] Monitor the application health and set up external uptime monitoring
