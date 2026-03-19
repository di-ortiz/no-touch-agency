import 'dotenv/config';
import { z } from 'zod';

// Normalize ClickUp token: support both CLICKUP_API_TOKEN and CLICKUP_TOKEN env vars
if (!process.env.CLICKUP_API_TOKEN || process.env.CLICKUP_API_TOKEN === 'your_clickup_token_here') {
  if (process.env.CLICKUP_TOKEN) {
    process.env.CLICKUP_API_TOKEN = process.env.CLICKUP_TOKEN;
  }
}

// Normalize ClickUp team ID: CLICKUP_WORKSPACE_ID takes priority (newer naming convention)
if (process.env.CLICKUP_WORKSPACE_ID) {
  process.env.CLICKUP_TEAM_ID = process.env.CLICKUP_WORKSPACE_ID;
} else if (!process.env.CLICKUP_TEAM_ID) {
  // neither set — leave empty, Zod will catch it
}

const envSchema = z.object({
  // Core AI
  ANTHROPIC_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().optional().default(''),

  // WhatsApp Cloud API (Meta)
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_OWNER_PHONE: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().optional().default(''),
  WHATSAPP_APP_SECRET: z.string().optional().default(''), // For X-Hub-Signature-256 webhook verification

  // Telegram Bot
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_OWNER_CHAT_ID: z.string().optional().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(''), // For X-Telegram-Bot-Api-Secret-Token verification

  // ClickUp
  CLICKUP_API_TOKEN: z.string().optional().default(''),
  CLICKUP_TEAM_ID: z.string().optional().default(''),
  CLICKUP_PPC_SPACE_ID: z.string().optional().default(''),

  // Google
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional().default(''),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional().default(''),
  GOOGLE_DRIVE_ROOT_FOLDER_ID: z.string().optional().default(''),
  GOOGLE_SHEETS_REPORTS_ID: z.string().optional().default(''),

  // HubSpot
  HUBSPOT_ACCESS_TOKEN: z.string().optional().default(''),

  // Meta
  META_APP_ID: z.string().optional().default(''),
  META_APP_SECRET: z.string().optional().default(''),
  META_ACCESS_TOKEN: z.string().optional().default(''),
  META_USER_ACCESS_TOKEN: z.string().optional().default(''),
  META_BUSINESS_ID: z.string().optional().default(''),

  // Google Analytics
  GA4_PROPERTY_ID: z.string().optional().default(''),

  // Google Ads
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional().default(''),
  GOOGLE_ADS_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_ADS_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_ADS_REFRESH_TOKEN: z.string().optional().default(''),
  GOOGLE_ADS_MANAGER_ACCOUNT_ID: z.string().optional().default(''),

  // TikTok
  TIKTOK_ACCESS_TOKEN: z.string().optional().default(''),
  TIKTOK_APP_ID: z.string().optional().default(''),
  TIKTOK_APP_SECRET: z.string().optional().default(''),

  // Twitter/X
  TWITTER_API_KEY: z.string().optional().default(''),
  TWITTER_API_SECRET: z.string().optional().default(''),
  TWITTER_ACCESS_TOKEN: z.string().optional().default(''),
  TWITTER_ACCESS_SECRET: z.string().optional().default(''),
  TWITTER_ADS_ACCOUNT_ID: z.string().optional().default(''),

  // AgencyAnalytics
  AGENCY_ANALYTICS_API_KEY: z.string().optional().default(''),

  // Canva
  CANVA_API_KEY: z.string().optional().default(''),

  // DataForSEO
  DATAFORSEO_LOGIN: z.string().optional().default(''),
  DATAFORSEO_PASSWORD: z.string().optional().default(''),

  // Leadsie
  LEADSIE_API_KEY: z.string().optional().default(''),
  LEADSIE_WEBHOOK_SECRET: z.string().optional().default(''),

  // Client onboarding
  WHATSAPP_BUSINESS_PHONE: z.string().optional().default(''), // The actual phone number for wa.me links
  TELEGRAM_BOT_USERNAME: z.string().optional().default(''), // For t.me deep links
  CLIENT_INIT_API_KEY: z.string().optional().default(''), // API key to protect /api/client-init (strongly recommended)

  // CORS
  CORS_ALLOWED_ORIGINS: z.string().optional().default(''), // Comma-separated list of allowed origins for /api routes

  // Supabase (Lovable onboarding submissions)
  SUPABASE_URL: z.string().optional().default(''),
  SUPABASE_ANON_KEY: z.string().optional().default(''),

  // Kimi 2.5 (Moonshot AI — text generation + visual analysis)
  KIMI_API_KEY: z.string().optional().default(''),

  // Firecrawl (web scraping / crawling)
  FIRECRAWL_API_KEY: z.string().optional().default(''),

  // Gemini (Google AI — Imagen 3 image generation + multi-modal vision)
  GEMINI_API_KEY: z.string().optional().default(''),

  // fal.ai (Flux image generation)
  FAL_API_KEY: z.string().optional().default(''),

  // App
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // Cost
  MONTHLY_AI_BUDGET_CENTS: z.coerce.number().default(100000),
  DAILY_COST_ALERT_THRESHOLD_CENTS: z.coerce.number().default(5000),
  COST_DB_PATH: z.string().default('data/costs.db'),

  // Safety
  AUTO_APPROVE_BUDGET_CHANGE_LIMIT: z.coerce.number().default(5000),
  AUTO_APPROVE_BID_CHANGE_PCT: z.coerce.number().default(20),
  AUTO_PAUSE_ROAS_THRESHOLD: z.coerce.number().default(0.2),
  AUTO_PAUSE_CPA_MULTIPLIER: z.coerce.number().default(3),
  ZERO_CONVERSION_SPEND_ALERT: z.coerce.number().default(50000),
});

let config;

try {
  config = envSchema.parse(process.env);
} catch (error) {
  if (process.env.NODE_ENV === 'test') {
    // In test mode, use defaults for everything
    config = envSchema.parse({
      ANTHROPIC_API_KEY: 'test-key',
      WHATSAPP_ACCESS_TOKEN: 'test-token',
      WHATSAPP_PHONE_NUMBER_ID: '000000000000',
      WHATSAPP_OWNER_PHONE: '10000000001',
      WHATSAPP_VERIFY_TOKEN: 'test-verify',
      WHATSAPP_APP_SECRET: 'test-app-secret',
      TELEGRAM_WEBHOOK_SECRET: 'test-telegram-secret',
      CLICKUP_API_TOKEN: 'test-clickup',
      CLICKUP_TEAM_ID: 'test-team',
      NODE_ENV: 'test',
      ...process.env,
    });
  } else {
    console.error('=== CONFIGURATION VALIDATION FAILED ===');
    console.error(error.errors?.map(e => `  ${e.path.join('.')}: ${e.message}`).join('\n'));
    console.error('\nRequired env vars: ANTHROPIC_API_KEY, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_OWNER_PHONE');
    console.error('Copy .env.example to .env and fill in required values.');
    process.exit(1);
  }
}

export default config;
