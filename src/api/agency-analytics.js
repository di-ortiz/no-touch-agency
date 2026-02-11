import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'agency-analytics' });

const api = axios.create({
  baseURL: 'https://api.agencyanalytics.com/v2',
  headers: { Authorization: `Bearer ${config.AGENCY_ANALYTICS_API_KEY}` },
  timeout: 15000,
});

async function request(method, path, data, params) {
  return rateLimited('hubspot', () => // reuse hubspot limiter (generic 5/s)
    retry(async () => {
      const res = await api({ method, url: path, data, params });
      return res.data;
    }, { retries: 3, label: `AgencyAnalytics ${method} ${path}`, shouldRetry: isRetryableHttpError })
  );
}

export async function getCampaigns() {
  return request('get', '/campaigns');
}

export async function getCampaign(campaignId) {
  return request('get', `/campaigns/${campaignId}`);
}

export async function getReports(campaignId) {
  return request('get', `/campaigns/${campaignId}/reports`);
}

export async function createReport(campaignId, reportData) {
  return request('post', `/campaigns/${campaignId}/reports`, reportData);
}

export async function getIntegrations(campaignId) {
  return request('get', `/campaigns/${campaignId}/integrations`);
}

export default { getCampaigns, getCampaign, getReports, createReport, getIntegrations };
