import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'tiktok' });
const BASE_URL = 'https://business-api.tiktok.com/open_api/v1.3';

async function request(method, path, params = {}, data) {
  return rateLimited('tiktok', () =>
    retry(async () => {
      const res = await axios({
        method,
        url: `${BASE_URL}${path}`,
        headers: { 'Access-Token': config.TIKTOK_ACCESS_TOKEN },
        params: method === 'get' ? params : undefined,
        data: method !== 'get' ? (data || params) : undefined,
        timeout: 30000,
      });
      if (res.data.code !== 0) {
        throw new Error(`TikTok API error: ${res.data.message} (code: ${res.data.code})`);
      }
      return res.data.data;
    }, { retries: 3, label: `TikTok ${method} ${path}`, shouldRetry: isRetryableHttpError })
  );
}

// --- Campaigns ---

export async function getCampaigns(advertiserId, opts = {}) {
  return request('get', '/campaign/get/', {
    advertiser_id: advertiserId,
    filtering: opts.status ? JSON.stringify({ status: opts.status }) : undefined,
    page_size: opts.limit || 100,
  });
}

export async function getAdGroups(advertiserId, campaignId) {
  return request('get', '/adgroup/get/', {
    advertiser_id: advertiserId,
    filtering: JSON.stringify({ campaign_ids: [campaignId] }),
    page_size: 100,
  });
}

export async function getAds(advertiserId, adGroupId) {
  return request('get', '/ad/get/', {
    advertiser_id: advertiserId,
    filtering: JSON.stringify({ adgroup_ids: [adGroupId] }),
    page_size: 100,
  });
}

// --- Reporting ---

export async function getReport(advertiserId, opts = {}) {
  const {
    reportType = 'BASIC',
    dataLevel = 'AUCTION_CAMPAIGN',
    dimensions = ['campaign_id'],
    metrics = ['spend', 'impressions', 'clicks', 'conversion', 'cost_per_conversion', 'ctr', 'cpc', 'cpm'],
    startDate,
    endDate,
  } = opts;

  return request('get', '/report/integrated/get/', {
    advertiser_id: advertiserId,
    report_type: reportType,
    data_level: dataLevel,
    dimensions: JSON.stringify(dimensions),
    metrics: JSON.stringify(metrics),
    start_date: startDate,
    end_date: endDate,
    page_size: 200,
  });
}

// --- Management ---

export async function updateCampaignStatus(advertiserId, campaignId, status) {
  log.info(`Updating TikTok campaign ${campaignId} to ${status}`);
  return request('post', '/campaign/status/update/', {
    advertiser_id: advertiserId,
    campaign_ids: [campaignId],
    opt_status: status, // 'ENABLE', 'DISABLE', 'DELETE'
  });
}

export async function updateAdGroupBudget(advertiserId, adGroupId, budget) {
  return request('post', '/adgroup/update/', {
    advertiser_id: advertiserId,
    adgroup_id: adGroupId,
    budget: budget,
  });
}

export default {
  getCampaigns, getAdGroups, getAds,
  getReport, updateCampaignStatus, updateAdGroupBudget,
};
