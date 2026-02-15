import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';
import { recordCost } from '../services/cost-tracker.js';
import { getValidToken, isTokenExpiredError, invalidateCachedToken } from '../utils/meta-token.js';

const log = logger.child({ platform: 'meta' });
const API_VERSION = 'v22.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

async function request(method, path, params = {}, data) {
  const token = await getValidToken();
  return rateLimited('meta', () =>
    retry(async () => {
      try {
        const res = await axios({
          method,
          url: `${BASE_URL}${path}`,
          params: { access_token: token, ...params },
          data,
          timeout: 30000,
        });
        recordCost({ platform: 'meta', workflow: 'api', costCentsOverride: 0 });
        return res.data;
      } catch (error) {
        if (isTokenExpiredError(error)) {
          invalidateCachedToken();
        }
        const metaError = error.response?.data?.error;
        if (metaError) {
          const msg = `Meta API error (${metaError.code || error.response?.status}): ${metaError.message || 'Unknown error'}`;
          log.error(msg, { type: metaError.type, fbtraceId: metaError.fbtrace_id });
          throw new Error(msg);
        }
        throw error;
      }
    }, { retries: 3, label: `Meta ${method} ${path}`, shouldRetry: isRetryableHttpError })
  );
}

// --- Account & Campaign Data ---

export async function getAdAccounts() {
  // Use Business ID if available to get all ad accounts under the business
  if (config.META_BUSINESS_ID) {
    return request('get', `/${config.META_BUSINESS_ID}/owned_ad_accounts`, {
      fields: 'name,account_id,account_status,currency,timezone_name,amount_spent',
    });
  }
  return request('get', `/me/adaccounts`, {
    fields: 'name,account_id,account_status,currency,timezone_name,amount_spent',
  });
}

export async function getBusinessInfo() {
  if (!config.META_BUSINESS_ID) {
    log.warn('META_BUSINESS_ID not configured');
    return null;
  }
  return request('get', `/${config.META_BUSINESS_ID}`, {
    fields: 'name,id,primary_page,timezone_id,vertical',
  });
}

export async function getCampaigns(adAccountId, opts = {}) {
  return request('get', `/act_${adAccountId}/campaigns`, {
    fields: 'name,status,objective,daily_budget,lifetime_budget,start_time,stop_time,bid_strategy',
    limit: opts.limit || 100,
    filtering: opts.statusFilter ? JSON.stringify([{ field: 'effective_status', operator: 'IN', value: opts.statusFilter }]) : undefined,
  });
}

export async function getAdSets(campaignId) {
  return request('get', `/${campaignId}/adsets`, {
    fields: 'name,status,targeting,daily_budget,bid_amount,optimization_goal,billing_event,start_time,end_time',
  });
}

export async function getAds(adSetId) {
  return request('get', `/${adSetId}/ads`, {
    fields: 'name,status,creative{title,body,image_url,thumbnail_url,link_url,call_to_action_type}',
  });
}

// --- Performance Insights ---

export async function getInsights(objectId, opts = {}) {
  const {
    datePreset,
    timeRange,
    fields = 'spend,impressions,clicks,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type,conversions,conversion_values',
    level = 'campaign',
    breakdowns,
  } = opts;

  const params = { fields, level };
  if (datePreset) params.date_preset = datePreset;
  if (timeRange) params.time_range = JSON.stringify(timeRange);
  if (breakdowns) params.breakdowns = breakdowns;

  return request('get', `/${objectId}/insights`, params);
}

export async function getAccountInsights(adAccountId, opts = {}) {
  return getInsights(`act_${adAccountId}`, opts);
}

export async function getCampaignInsights(campaignId, opts = {}) {
  return getInsights(campaignId, { ...opts, level: 'campaign' });
}

// --- Campaign Management ---

export async function updateCampaign(campaignId, updates) {
  return request('post', `/${campaignId}`, {}, updates);
}

export async function updateAdSet(adSetId, updates) {
  return request('post', `/${adSetId}`, {}, updates);
}

export async function updateAd(adId, updates) {
  return request('post', `/${adId}`, {}, updates);
}

export async function pauseCampaign(campaignId) {
  log.info(`Pausing Meta campaign ${campaignId}`);
  return updateCampaign(campaignId, { status: 'PAUSED' });
}

export async function enableCampaign(campaignId) {
  log.info(`Enabling Meta campaign ${campaignId}`);
  return updateCampaign(campaignId, { status: 'ACTIVE' });
}

// --- Audience ---

export async function getCustomAudiences(adAccountId) {
  return request('get', `/act_${adAccountId}/customaudiences`, {
    fields: 'name,approximate_count,data_source,delivery_status,subtype',
  });
}

// --- Helpers ---

export function extractConversions(insights) {
  if (!insights?.data?.[0]) return null;
  const data = insights.data[0];
  const actions = data.actions || [];
  const costPerAction = data.cost_per_action_type || [];

  const purchases = actions.find(a => a.action_type === 'purchase');
  const leads = actions.find(a => a.action_type === 'lead');
  const cpaObj = costPerAction.find(a => a.action_type === 'purchase') || costPerAction.find(a => a.action_type === 'lead');

  return {
    spend: parseFloat(data.spend || 0),
    impressions: parseInt(data.impressions || 0),
    clicks: parseInt(data.clicks || 0),
    ctr: parseFloat(data.ctr || 0),
    cpc: parseFloat(data.cpc || 0),
    reach: parseInt(data.reach || 0),
    frequency: parseFloat(data.frequency || 0),
    conversions: parseInt(purchases?.value || leads?.value || 0),
    cpa: parseFloat(cpaObj?.value || 0),
    roas: data.conversion_values ? parseFloat(data.conversion_values) / parseFloat(data.spend || 1) : 0,
  };
}

export default {
  getAdAccounts, getBusinessInfo, getCampaigns, getAdSets, getAds,
  getInsights, getAccountInsights, getCampaignInsights,
  updateCampaign, updateAdSet, updateAd,
  pauseCampaign, enableCampaign,
  getCustomAudiences, extractConversions,
};
