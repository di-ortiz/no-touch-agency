import axios from 'axios';
import crypto from 'crypto';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'twitter' });
const BASE_URL = 'https://ads-api.x.com/12';

function oauthSign(method, url, params = {}) {
  const oauthParams = {
    oauth_consumer_key: config.TWITTER_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: config.TWITTER_ACCESS_TOKEN,
    oauth_version: '1.0',
  };

  const allParams = { ...params, ...oauthParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`).join('&');
  const baseString = `${method.toUpperCase()}&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;
  const signingKey = `${encodeURIComponent(config.TWITTER_API_SECRET)}&${encodeURIComponent(config.TWITTER_ACCESS_SECRET)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  oauthParams.oauth_signature = signature;
  const authHeader = 'OAuth ' + Object.entries(oauthParams).map(([k, v]) => `${k}="${encodeURIComponent(v)}"`).join(', ');
  return authHeader;
}

async function request(method, path, params = {}) {
  const url = `${BASE_URL}${path}`;
  return rateLimited('twitter', () =>
    retry(async () => {
      const authHeader = oauthSign(method, url, method === 'get' ? params : {});
      const res = await axios({
        method,
        url,
        headers: { Authorization: authHeader },
        params: method === 'get' ? params : undefined,
        data: method !== 'get' ? params : undefined,
        timeout: 30000,
      });
      return res.data;
    }, { retries: 3, label: `Twitter Ads ${method} ${path}`, shouldRetry: isRetryableHttpError })
  );
}

export async function getCampaigns(accountId) {
  return request('get', `/accounts/${accountId || config.TWITTER_ADS_ACCOUNT_ID}/campaigns`, {
    with_deleted: false,
    count: 100,
  });
}

export async function getCampaignStats(accountId, campaignIds, startDate, endDate) {
  return request('get', `/stats/accounts/${accountId || config.TWITTER_ADS_ACCOUNT_ID}`, {
    entity: 'CAMPAIGN',
    entity_ids: campaignIds.join(','),
    start_time: startDate,
    end_time: endDate,
    granularity: 'DAY',
    metric_groups: 'ENGAGEMENT,BILLING,CONVERSION_TAGS',
  });
}

export async function updateCampaignStatus(accountId, campaignId, enabled) {
  return request('put', `/accounts/${accountId || config.TWITTER_ADS_ACCOUNT_ID}/campaigns/${campaignId}`, {
    entity_status: enabled ? 'ACTIVE' : 'PAUSED',
  });
}

export default { getCampaigns, getCampaignStats, updateCampaignStatus };
