/**
 * Meta App Review - Standalone Permission Test Script
 *
 * NO dependencies needed. Just save this file anywhere and run:
 *   node test-meta-permissions-standalone.js
 *
 * Works with Node.js v18+ (uses built-in fetch)
 */

// ========== YOUR CREDENTIALS (from .env) ==========
const ACCESS_TOKEN = 'EAAKzdBlme4MBQlXFY50NykaH9alkGHRn6tKFMeStJEblTZCmO7gOaKsFq6d4E0YgDRCc99i8ERp5KzZBgEc5WZBQVheK0YZBqMdHNsZCjpIPaitTQQHEPT1wsqSZCBCHk9q2QBRZBAWIrliNOVK421dgiLOKshLCEoh1rSAtfvIEZAtTnxt1xKxFJDvlBLUUAAKx7gZDZD';
const WHATSAPP_TOKEN = 'EAAKzdBlme4MBQglkLwSvVk0IqWeHsFZBCA0QY1zrrvzcR6A6qDPUgxSopd9uKdCROhtsz6oskcsIZBtGcG0TDSHVW1F7OSQ3JUebZCaHHATa9DTQ07xLJ5qagEZCwrFW9zAMHFzRwYiNiRI9N7LwCZAGzZBx31nv7le9KrhpsJSvaSnWHNtXKdKkGJM86ACTXtZBqNMBpvqWZBo4dkGCvnSKoMyYYT4RSP9IUAWsg326ZBgjeOJy53UT2sDjUHjladeld4z35ZAzZBlMjNInNBpJoRJeAZDZD';
const BUSINESS_ID = '412107959434423';
const WHATSAPP_PHONE_ID = '660374193829829';
const APP_ID = '760261177146243';
// ===================================================

const BASE = 'https://graph.facebook.com/v22.0';
let passed = 0;
let failed = 0;

async function api(path, token = ACCESS_TOKEN, params = {}) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('access_token', token);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  if (data.error) throw new Error(`(${data.error.code}) ${data.error.message}`);
  return data;
}

async function test(label, fn) {
  try {
    const result = await fn();
    const preview = JSON.stringify(result).slice(0, 150);
    console.log(`  ✅ ${label}`);
    console.log(`     ${preview}...\n`);
    passed++;
    return result;
  } catch (err) {
    console.log(`  ❌ ${label}`);
    console.log(`     ${err.message}\n`);
    failed++;
    return null;
  }
}

async function main() {
  console.log('');
  console.log('==========================================================');
  console.log('  Meta App Review - Permission API Test Calls');
  console.log('==========================================================');
  console.log(`  App ID:      ${APP_ID}`);
  console.log(`  Business ID: ${BUSINESS_ID}`);
  console.log(`  Token:       ${ACCESS_TOKEN.slice(0, 20)}...`);
  console.log('');

  // =====================================================
  // WHATSAPP PERMISSIONS
  // =====================================================
  console.log('--- WhatsApp: Connect with customers through WhatsApp ---\n');

  // whatsapp_business_manage_events
  await test('whatsapp_business_manage_events - Phone number details', () =>
    api(`/${WHATSAPP_PHONE_ID}`, WHATSAPP_TOKEN, {
      fields: 'verified_name,display_phone_number,quality_rating,messaging_limit_tier',
    })
  );

  // manage_app_solution
  await test('manage_app_solution - Get app details', () =>
    api(`/${APP_ID}`, ACCESS_TOKEN, { fields: 'name,category,description' })
  );

  // business_management (WhatsApp section)
  await test('business_management - Get business info', () =>
    api(`/${BUSINESS_ID}`, ACCESS_TOKEN, {
      fields: 'name,id,primary_page,timezone_id,vertical',
    })
  );

  await test('business_management - Get business users', () =>
    api(`/${BUSINESS_ID}/business_users`, ACCESS_TOKEN, { fields: 'name,role' })
  );

  // =====================================================
  // MARKETING API PERMISSIONS
  // =====================================================
  console.log('--- Marketing API: Create & manage ads ---\n');

  // business_management
  const bizResult = await test('business_management - Owned ad accounts', () =>
    api(`/${BUSINESS_ID}/owned_ad_accounts`, ACCESS_TOKEN, {
      fields: 'name,account_id,account_status,currency,timezone_name,amount_spent',
    })
  );

  await test('business_management - Owned pages', () =>
    api(`/${BUSINESS_ID}/owned_pages`, ACCESS_TOKEN, {
      fields: 'name,id,fan_count,category',
    })
  );

  await test('business_management - System users', () =>
    api(`/${BUSINESS_ID}/system_users`, ACCESS_TOKEN, { fields: 'name,role' })
  );

  // pages_show_list
  const pagesResult = await test('pages_show_list - List pages (me/accounts)', () =>
    api('/me/accounts', ACCESS_TOKEN, { fields: 'name,id,category,access_token' })
  );

  // Extract ad account and page for further tests
  let adAccountId = bizResult?.data?.[0]?.account_id || null;
  let pageId = pagesResult?.data?.[0]?.id || null;
  let pageToken = pagesResult?.data?.[0]?.access_token || ACCESS_TOKEN;

  if (adAccountId) console.log(`  >> Using ad account: ${adAccountId}\n`);
  if (pageId) console.log(`  >> Using page: ${pageId}\n`);

  // pages_read_engagement
  if (pageId) {
    await test('pages_read_engagement - Page info', () =>
      api(`/${pageId}`, pageToken, {
        fields: 'name,fan_count,new_like_count,talking_about_count',
      })
    );
    await test('pages_read_engagement - Page posts', () =>
      api(`/${pageId}/posts`, pageToken, {
        fields: 'message,created_time',
        limit: '5',
      })
    );
  } else {
    await test('pages_read_engagement - Business owned pages (fallback)', () =>
      api(`/${BUSINESS_ID}/owned_pages`, ACCESS_TOKEN, {
        fields: 'name,id,fan_count,category',
      })
    );
  }

  // pages_manage_ads
  if (pageId) {
    await test('pages_manage_ads - Leadgen forms', () =>
      api(`/${pageId}/leadgen_forms`, pageToken, { fields: 'name,status' })
    );
  }

  // ads_read
  if (adAccountId) {
    await test('ads_read - Get campaigns', () =>
      api(`/act_${adAccountId}/campaigns`, ACCESS_TOKEN, {
        fields: 'name,status,objective,daily_budget',
        limit: '10',
      })
    );
    await test('ads_read - Account insights (last 30 days)', () =>
      api(`/act_${adAccountId}/insights`, ACCESS_TOKEN, {
        fields: 'spend,impressions,clicks,cpc,cpm,ctr,reach',
        date_preset: 'last_30d',
      })
    );
    await test('ads_read - Get ad sets', () =>
      api(`/act_${adAccountId}/adsets`, ACCESS_TOKEN, {
        fields: 'name,status,daily_budget,optimization_goal',
        limit: '10',
      })
    );
    await test('ads_read - Get ads', () =>
      api(`/act_${adAccountId}/ads`, ACCESS_TOKEN, {
        fields: 'name,status',
        limit: '10',
      })
    );
  }

  // ads_management
  if (adAccountId) {
    await test('ads_management - Custom audiences', () =>
      api(`/act_${adAccountId}/customaudiences`, ACCESS_TOKEN, {
        fields: 'name,approximate_count,subtype',
      })
    );
    await test('ads_management - Ad creatives', () =>
      api(`/act_${adAccountId}/adcreatives`, ACCESS_TOKEN, {
        fields: 'name,title,body',
        limit: '10',
      })
    );
  }

  // Ads Management Standard Access
  if (adAccountId) {
    await test('Ads Management Standard Access - Ad account details', () =>
      api(`/act_${adAccountId}`, ACCESS_TOKEN, {
        fields: 'name,account_id,account_status,currency,amount_spent,balance',
      })
    );
  }

  // catalog_management
  await test('catalog_management - Product catalogs', () =>
    api(`/${BUSINESS_ID}/owned_product_catalogs`, ACCESS_TOKEN, {
      fields: 'name,id,product_count',
    })
  );

  // threads_business_basic
  await test('threads_business_basic - User profile', () =>
    api('/me', ACCESS_TOKEN, { fields: 'name,id' })
  );

  // =====================================================
  // RESULTS
  // =====================================================
  console.log('==========================================================');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('==========================================================\n');

  if (failed > 0) {
    console.log('  If you see permission errors, you need to regenerate your token:');
    console.log('  1. Go to: https://developers.facebook.com/tools/explorer/');
    console.log('  2. Select your app (760261177146243)');
    console.log('  3. Click "Generate Access Token"');
    console.log('  4. Check ALL required permissions');
    console.log('  5. Update the ACCESS_TOKEN in this script');
    console.log('  6. Run again\n');
  }
}

main().catch(console.error);
