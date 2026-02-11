#!/usr/bin/env node

/**
 * Setup Verification Script
 * Checks that all required credentials and configurations are in place.
 * Run with: npm run setup:check
 */

import 'dotenv/config';

const CHECKS = [
  {
    name: 'Anthropic API Key',
    env: 'ANTHROPIC_API_KEY',
    required: true,
    hint: 'Get from https://console.anthropic.com/settings/keys',
  },
  {
    name: 'Twilio Account SID',
    env: 'TWILIO_ACCOUNT_SID',
    required: true,
    hint: 'Get from https://console.twilio.com/',
  },
  {
    name: 'Twilio Auth Token',
    env: 'TWILIO_AUTH_TOKEN',
    required: true,
    hint: 'Get from https://console.twilio.com/',
  },
  {
    name: 'Twilio WhatsApp From',
    env: 'TWILIO_WHATSAPP_FROM',
    required: true,
    hint: 'Format: whatsapp:+14155238886 (Twilio sandbox or your number)',
  },
  {
    name: 'Owner WhatsApp Number',
    env: 'OWNER_WHATSAPP_NUMBER',
    required: true,
    hint: 'Format: whatsapp:+1XXXXXXXXXX (your personal number)',
  },
  {
    name: 'ClickUp API Token',
    env: 'CLICKUP_API_TOKEN',
    required: true,
    hint: 'Get from ClickUp Settings > Apps > API Token',
  },
  {
    name: 'ClickUp Team ID',
    env: 'CLICKUP_TEAM_ID',
    required: true,
    hint: 'Found in ClickUp URL or via API: GET /team',
  },
  {
    name: 'ClickUp PPC Space ID',
    env: 'CLICKUP_PPC_SPACE_ID',
    required: false,
    hint: 'The Space ID for your PPC workspace',
  },
  {
    name: 'Google Service Account',
    env: 'GOOGLE_APPLICATION_CREDENTIALS',
    required: false,
    hint: 'Path to Google service account JSON key file',
    fileCheck: true,
  },
  {
    name: 'Google Drive Root Folder',
    env: 'GOOGLE_DRIVE_ROOT_FOLDER_ID',
    required: false,
    hint: 'Folder ID from Google Drive URL',
  },
  {
    name: 'HubSpot Access Token',
    env: 'HUBSPOT_ACCESS_TOKEN',
    required: false,
    hint: 'Get from HubSpot > Settings > Integrations > Private Apps',
  },
  {
    name: 'Meta App ID',
    env: 'META_APP_ID',
    required: false,
    hint: 'Get from https://developers.facebook.com/apps/',
  },
  {
    name: 'Meta Access Token',
    env: 'META_ACCESS_TOKEN',
    required: false,
    hint: 'Generate long-lived token via Meta Business Suite',
  },
  {
    name: 'Google Ads Developer Token',
    env: 'GOOGLE_ADS_DEVELOPER_TOKEN',
    required: false,
    hint: 'Apply at https://developers.google.com/google-ads/api/docs/get-started/dev-token',
  },
  {
    name: 'Google Ads Client ID',
    env: 'GOOGLE_ADS_CLIENT_ID',
    required: false,
    hint: 'OAuth2 client ID for Google Ads API access',
  },
  {
    name: 'TikTok Access Token',
    env: 'TIKTOK_ACCESS_TOKEN',
    required: false,
    hint: 'Get from https://business-api.tiktok.com/',
  },
  {
    name: 'Twitter API Key',
    env: 'TWITTER_API_KEY',
    required: false,
    hint: 'Get from https://developer.x.com/en/portal/dashboard',
  },
  {
    name: 'AgencyAnalytics API Key',
    env: 'AGENCY_ANALYTICS_API_KEY',
    required: false,
    hint: 'Get from AgencyAnalytics account settings',
  },
  {
    name: 'OpenAI API Key (for DALL-E)',
    env: 'OPENAI_API_KEY',
    required: false,
    hint: 'Get from https://platform.openai.com/api-keys',
  },
];

import fs from 'fs';

console.log('\n🔍 PPC Agency Automation - Setup Check\n');
console.log('='.repeat(60));

let requiredPassed = 0;
let requiredFailed = 0;
let optionalPassed = 0;
let optionalMissing = 0;

for (const check of CHECKS) {
  const value = process.env[check.env];
  const hasValue = value && value.length > 0 && !value.startsWith('xxxxx');

  let fileExists = true;
  if (check.fileCheck && hasValue) {
    fileExists = fs.existsSync(value);
  }

  const passed = hasValue && fileExists;

  if (check.required) {
    if (passed) {
      console.log(`  ✅ ${check.name}`);
      requiredPassed++;
    } else {
      console.log(`  ❌ ${check.name} - REQUIRED`);
      console.log(`     💡 ${check.hint}`);
      requiredFailed++;
    }
  } else {
    if (passed) {
      console.log(`  ✅ ${check.name}`);
      optionalPassed++;
    } else {
      console.log(`  ⬜ ${check.name} - optional`);
      console.log(`     💡 ${check.hint}`);
      optionalMissing++;
    }
  }
}

console.log('\n' + '='.repeat(60));
console.log(`\n📊 Results:`);
console.log(`  Required: ${requiredPassed}/${requiredPassed + requiredFailed} configured`);
console.log(`  Optional: ${optionalPassed}/${optionalPassed + optionalMissing} configured`);

if (requiredFailed > 0) {
  console.log(`\n❌ ${requiredFailed} required credential(s) missing.`);
  console.log(`   Copy .env.example to .env and fill in the required values.`);
  process.exit(1);
} else {
  console.log(`\n✅ All required credentials configured!`);
  if (optionalMissing > 0) {
    console.log(`   ${optionalMissing} optional integrations not configured yet.`);
    console.log(`   These can be added later as you enable each platform.`);
  }
}

console.log('');
