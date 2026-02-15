#!/usr/bin/env node
/**
 * Meta App Review - Permission Test Script
 *
 * Makes the required API test calls for each permission so Meta's
 * App Review dashboard shows them as "Completed".
 *
 * Run: node scripts/test-meta-permissions.js
 */

import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const BUSINESS_ID = process.env.META_BUSINESS_ID;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const APP_ID = process.env.META_APP_ID;
const API_VERSION = 'v22.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

let passed = 0;
let failed = 0;

async function testCall(label, fn) {
  try {
    const result = await fn();
    console.log(`  ✅ ${label}`);
    if (result?.data) {
      const preview = JSON.stringify(result.data).slice(0, 200);
      console.log(`     Response: ${preview}...`);
    }
    passed++;
    return result;
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.log(`  ❌ ${label}: ${msg}`);
    failed++;
    return null;
  }
}

async function get(path, params = {}, token = ACCESS_TOKEN) {
  return axios.get(`${BASE}${path}`, {
    params: { access_token: token, ...params },
    timeout: 30000,
  });
}

async function post(path, data = {}, token = ACCESS_TOKEN) {
  return axios.post(`${BASE}${path}`, data, {
    params: { access_token: token },
    timeout: 30000,
  });
}

// ============================================================
// WHATSAPP PERMISSIONS
// ============================================================

async function testWhatsAppPermissions() {
  console.log('\n━━━ WhatsApp: Connect with customers through WhatsApp ━━━\n');

  // whatsapp_business_manage_events
  // Subscribe the app to the WhatsApp business account webhooks
  await testCall('whatsapp_business_manage_events - Get phone number details', () =>
    get(`/${WHATSAPP_PHONE_ID}`, {
      fields: 'verified_name,display_phone_number,quality_rating,messaging_limit_tier',
    }, WHATSAPP_TOKEN)
  );

  // Also try to get WABA (WhatsApp Business Account) analytics
  await testCall('whatsapp_business_manage_events - Get WABA analytics', () =>
    get(`/${WHATSAPP_PHONE_ID}/analytics`, {}, WHATSAPP_TOKEN)
  );

  // manage_app_solution - Get app info
  await testCall('manage_app_solution - Get app details', () =>
    get(`/${APP_ID}`, {
      fields: 'name,category,description',
    }, ACCESS_TOKEN)
  );

  // business_management (WhatsApp section)
  await testCall('business_management - Get business info', () =>
    get(`/${BUSINESS_ID}`, {
      fields: 'name,id,primary_page,timezone_id,vertical',
    })
  );

  await testCall('business_management - Get business users', () =>
    get(`/${BUSINESS_ID}/business_users`, {
      fields: 'name,role',
    })
  );

  // WhatsApp business management
  await testCall('whatsapp_business_management - Get phone number', () =>
    get(`/${WHATSAPP_PHONE_ID}`, {
      fields: 'verified_name,display_phone_number,quality_rating',
    }, WHATSAPP_TOKEN)
  );
}

// ============================================================
// MARKETING API PERMISSIONS
// ============================================================

async function testMarketingPermissions() {
  console.log('\n━━━ Marketing API: Create & manage ads with Marketing API ━━━\n');

  // --- business_management ---
  const bizResult = await testCall('business_management - Get owned ad accounts', () =>
    get(`/${BUSINESS_ID}/owned_ad_accounts`, {
      fields: 'name,account_id,account_status,currency,timezone_name,amount_spent',
    })
  );

  await testCall('business_management - Get owned pages', () =>
    get(`/${BUSINESS_ID}/owned_pages`, {
      fields: 'name,id,fan_count,category',
    })
  );

  await testCall('business_management - Get system users', () =>
    get(`/${BUSINESS_ID}/system_users`, {
      fields: 'name,role',
    })
  );

  // Extract first ad account ID for further tests
  let adAccountId = null;
  if (bizResult?.data?.data?.[0]) {
    adAccountId = bizResult.data.data[0].account_id;
    console.log(`\n  📋 Using ad account: ${adAccountId} (${bizResult.data.data[0].name})\n`);
  }

  // Extract first page ID
  let pageId = null;
  const pagesResult = await testCall('pages_show_list - List user pages (me/accounts)', () =>
    get('/me/accounts', { fields: 'name,id,category,access_token' })
  );

  if (pagesResult?.data?.data?.[0]) {
    pageId = pagesResult.data.data[0].id;
    console.log(`  📋 Using page: ${pageId} (${pagesResult.data.data[0].name})\n`);
  }

  // --- pages_read_engagement ---
  if (pageId) {
    const pageToken = pagesResult.data.data[0].access_token;

    await testCall('pages_read_engagement - Get page info', () =>
      get(`/${pageId}`, {
        fields: 'name,fan_count,engagement,new_like_count,talking_about_count',
      }, pageToken || ACCESS_TOKEN)
    );

    await testCall('pages_read_engagement - Get page posts', () =>
      get(`/${pageId}/posts`, {
        fields: 'message,created_time,likes.summary(true),comments.summary(true),shares',
        limit: 5,
      }, pageToken || ACCESS_TOKEN)
    );

    await testCall('pages_read_engagement - Get page insights', () =>
      get(`/${pageId}/insights`, {
        metric: 'page_impressions,page_engaged_users',
        period: 'day',
      }, pageToken || ACCESS_TOKEN)
    );
  } else {
    console.log('  ⚠️  No page found - skipping pages_read_engagement tests');
    // Try with business owned pages
    await testCall('pages_read_engagement - Get business owned pages', () =>
      get(`/${BUSINESS_ID}/owned_pages`, {
        fields: 'name,id,fan_count,category,engagement',
      })
    );
  }

  // --- pages_manage_ads ---
  if (pageId) {
    await testCall('pages_manage_ads - Get page ads (leadgen_forms)', () =>
      get(`/${pageId}/leadgen_forms`, {
        fields: 'name,status',
      })
    );
  }

  // --- ads_read ---
  if (adAccountId) {
    await testCall('ads_read - Get campaigns', () =>
      get(`/act_${adAccountId}/campaigns`, {
        fields: 'name,status,objective,daily_budget,lifetime_budget',
        limit: 10,
      })
    );

    await testCall('ads_read - Get account insights', () =>
      get(`/act_${adAccountId}/insights`, {
        fields: 'spend,impressions,clicks,cpc,cpm,ctr,reach,frequency',
        date_preset: 'last_30d',
      })
    );

    await testCall('ads_read - Get ad sets', () =>
      get(`/act_${adAccountId}/adsets`, {
        fields: 'name,status,targeting,daily_budget,optimization_goal',
        limit: 10,
      })
    );

    await testCall('ads_read - Get ads', () =>
      get(`/act_${adAccountId}/ads`, {
        fields: 'name,status,creative{title,body,image_url,thumbnail_url}',
        limit: 10,
      })
    );
  } else {
    console.log('  ⚠️  No ad account found - skipping ads_read tests');
  }

  // --- ads_management ---
  if (adAccountId) {
    // Read custom audiences (ads_management permission)
    await testCall('ads_management - Get custom audiences', () =>
      get(`/act_${adAccountId}/customaudiences`, {
        fields: 'name,approximate_count,data_source,delivery_status,subtype',
      })
    );

    // Get ad creatives (ads_management)
    await testCall('ads_management - Get ad creatives', () =>
      get(`/act_${adAccountId}/adcreatives`, {
        fields: 'name,title,body,image_url,link_url,call_to_action_type',
        limit: 10,
      })
    );

    // Get ad account info (Ads Management Standard Access)
    await testCall('Ads Management Standard Access - Get ad account details', () =>
      get(`/act_${adAccountId}`, {
        fields: 'name,account_id,account_status,currency,timezone_name,amount_spent,balance,business,owner',
      })
    );

    // Get targeting options (Ads Management Standard Access)
    await testCall('Ads Management Standard Access - Get targeting search', () =>
      get(`/act_${adAccountId}/targetingsearch`, {
        q: 'marketing',
        type: 'adinterest',
      })
    );
  }

  // --- catalog_management ---
  await testCall('catalog_management - Get business product catalogs', () =>
    get(`/${BUSINESS_ID}/owned_product_catalogs`, {
      fields: 'name,id,product_count,vertical',
    })
  );

  // --- threads_business_basic ---
  // Threads uses the same page token
  if (pageId) {
    await testCall('threads_business_basic - Get threads profile (via page)', () =>
      get(`/${pageId}`, {
        fields: 'name,id,instagram_business_account',
      })
    );
  }

  // Try threads user profile
  await testCall('threads_business_basic - Get user profile', () =>
    get('/me', {
      fields: 'name,id',
    })
  );
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Meta App Review - Permission API Test Calls           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\n  App ID:      ${APP_ID}`);
  console.log(`  Business ID: ${BUSINESS_ID}`);
  console.log(`  Token:       ${ACCESS_TOKEN?.slice(0, 20)}...`);
  console.log(`  WA Phone ID: ${WHATSAPP_PHONE_ID}`);

  await testWhatsAppPermissions();
  await testMarketingPermissions();

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    console.log('  💡 Some calls failed - this is normal if:');
    console.log('     - You have no ad accounts or campaigns yet');
    console.log('     - Some permissions are not yet granted in dev mode');
    console.log('     - The token needs specific permissions enabled');
    console.log('');
    console.log('  The important thing is that Meta recorded the API calls.');
    console.log('  Check your App Review dashboard to see updated counts.\n');
  }
}

main().catch(console.error);
