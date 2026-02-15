import axios from 'axios';
import { google } from 'googleapis';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'google-ads' });
const API_VERSION = 'v17';
const BASE_URL = `https://googleads.googleapis.com/${API_VERSION}`;

let accessToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry - 60000) {
    return accessToken;
  }

  const oauth2Client = new google.auth.OAuth2(
    config.GOOGLE_ADS_CLIENT_ID,
    config.GOOGLE_ADS_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({ refresh_token: config.GOOGLE_ADS_REFRESH_TOKEN });

  const { credentials } = await oauth2Client.refreshAccessToken();
  accessToken = credentials.access_token;
  tokenExpiry = credentials.expiry_date || Date.now() + 3600000;
  return accessToken;
}

async function gaqlQuery(customerId, query) {
  return rateLimited('googleAds', () =>
    retry(async () => {
      const token = await getAccessToken();
      const res = await axios.post(
        `${BASE_URL}/customers/${customerId}/googleAds:searchStream`,
        { query },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'developer-token': config.GOOGLE_ADS_DEVELOPER_TOKEN,
            'login-customer-id': config.GOOGLE_ADS_MANAGER_ACCOUNT_ID,
          },
          timeout: 30000,
        },
      );
      // searchStream returns array of batches
      const results = [];
      for (const batch of res.data || []) {
        if (batch.results) results.push(...batch.results);
      }
      return results;
    }, { retries: 3, label: 'Google Ads GAQL', shouldRetry: isRetryableHttpError })
  );
}

// --- Account Info ---

export async function getAccounts() {
  const results = await gaqlQuery(config.GOOGLE_ADS_MANAGER_ACCOUNT_ID, `
    SELECT
      customer_client.client_customer,
      customer_client.descriptive_name,
      customer_client.currency_code,
      customer_client.status
    FROM customer_client
    WHERE customer_client.status = 'ENABLED'
  `);
  return results.map(r => r.customerClient);
}

// --- Campaign Data ---

export async function getCampaigns(customerId, opts = {}) {
  const dateFilter = opts.dateRange
    ? `AND segments.date BETWEEN '${opts.dateRange.start}' AND '${opts.dateRange.end}'`
    : "AND segments.date DURING LAST_7_DAYS";

  return gaqlQuery(customerId, `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.bidding_strategy_type,
      campaign_budget.amount_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.average_cpc,
      metrics.ctr,
      metrics.average_cpm
    FROM campaign
    WHERE campaign.status != 'REMOVED'
    ${dateFilter}
    ORDER BY metrics.cost_micros DESC
  `);
}

// --- Ad Group Data ---

export async function getAdGroups(customerId, campaignId) {
  return gaqlQuery(customerId, `
    SELECT
      ad_group.id,
      ad_group.name,
      ad_group.status,
      ad_group.type,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.average_cpc,
      metrics.ctr
    FROM ad_group
    WHERE campaign.id = ${campaignId}
    AND ad_group.status != 'REMOVED'
    AND segments.date DURING LAST_7_DAYS
  `);
}

// --- Keywords ---

export async function getKeywords(customerId, campaignId) {
  return gaqlQuery(customerId, `
    SELECT
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.quality_info.quality_score,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.average_cpc,
      metrics.ctr
    FROM keyword_view
    WHERE campaign.id = ${campaignId}
    AND segments.date DURING LAST_7_DAYS
    ORDER BY metrics.cost_micros DESC
    LIMIT 100
  `);
}

// --- Performance Summary ---

export async function getAccountPerformance(customerId, dateRange) {
  const dateFilter = dateRange
    ? `WHERE segments.date BETWEEN '${dateRange.start}' AND '${dateRange.end}'`
    : "WHERE segments.date DURING LAST_7_DAYS";

  return gaqlQuery(customerId, `
    SELECT
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.average_cpc,
      metrics.ctr,
      metrics.search_impression_share
    FROM customer
    ${dateFilter}
  `);
}

// --- Helpers ---

export function microsToMoney(micros) {
  return (micros / 1_000_000).toFixed(2);
}

export function formatGoogleAdsMetrics(row) {
  const m = row.metrics || {};
  return {
    impressions: parseInt(m.impressions || 0),
    clicks: parseInt(m.clicks || 0),
    cost: microsToMoney(m.costMicros || 0),
    conversions: parseFloat(m.conversions || 0),
    conversionValue: parseFloat(m.conversionsValue || 0),
    cpc: microsToMoney(m.averageCpc || 0),
    ctr: parseFloat(m.ctr || 0) * 100,
    roas: m.costMicros > 0 ? parseFloat(m.conversionsValue || 0) / (m.costMicros / 1_000_000) : 0,
    cpa: m.conversions > 0 ? (m.costMicros / 1_000_000) / parseFloat(m.conversions) : 0,
  };
}

export default {
  getAccounts, getCampaigns, getAdGroups, getKeywords,
  getAccountPerformance, gaqlQuery,
  microsToMoney, formatGoogleAdsMetrics,
};
