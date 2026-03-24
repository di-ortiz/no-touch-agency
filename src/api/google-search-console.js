import { google } from 'googleapis';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';
import { getGoogleAuth } from './google-auth.js';

const log = logger.child({ platform: 'google-search-console' });

let searchConsoleClient;

function getSearchConsole() {
  if (!searchConsoleClient) {
    const auth = getGoogleAuth(['https://www.googleapis.com/auth/webmasters.readonly']);
    if (!auth) {
      throw new Error('Google Search Console not configured — no OAuth2 credentials found');
    }
    searchConsoleClient = google.searchconsole({ version: 'v1', auth });
  }
  return searchConsoleClient;
}

/**
 * Get top search queries with clicks, impressions, CTR, and position.
 */
export async function getTopQueries(siteUrl, opts = {}) {
  const sc = getSearchConsole();
  const startDate = opts.startDate || '30daysAgo';
  const endDate = opts.endDate || 'today';

  return rateLimited('google', () =>
    retry(async () => {
      const res = await sc.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate: resolveDate(startDate),
          endDate: resolveDate(endDate),
          dimensions: ['query'],
          rowLimit: opts.limit || 25,
          type: 'web',
        },
      });
      return (res.data.rows || []).map(row => ({
        query: row.keys[0],
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: (row.ctr * 100).toFixed(1),
        position: row.position.toFixed(1),
      }));
    }, { retries: 3, label: 'GSC top queries', shouldRetry: isRetryableHttpError })
  );
}

/**
 * Get top pages by clicks with impressions, CTR, and position.
 */
export async function getTopPages(siteUrl, opts = {}) {
  const sc = getSearchConsole();

  return rateLimited('google', () =>
    retry(async () => {
      const res = await sc.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate: resolveDate(opts.startDate || '30daysAgo'),
          endDate: resolveDate(opts.endDate || 'today'),
          dimensions: ['page'],
          rowLimit: opts.limit || 25,
          type: 'web',
        },
      });
      return (res.data.rows || []).map(row => ({
        page: row.keys[0],
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: (row.ctr * 100).toFixed(1),
        position: row.position.toFixed(1),
      }));
    }, { retries: 3, label: 'GSC top pages', shouldRetry: isRetryableHttpError })
  );
}

/**
 * Get queries for a specific page.
 */
export async function getPageQueries(siteUrl, pageUrl, opts = {}) {
  const sc = getSearchConsole();

  return rateLimited('google', () =>
    retry(async () => {
      const res = await sc.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate: resolveDate(opts.startDate || '30daysAgo'),
          endDate: resolveDate(opts.endDate || 'today'),
          dimensions: ['query'],
          dimensionFilterGroups: [{
            filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl }],
          }],
          rowLimit: opts.limit || 25,
          type: 'web',
        },
      });
      return (res.data.rows || []).map(row => ({
        query: row.keys[0],
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: (row.ctr * 100).toFixed(1),
        position: row.position.toFixed(1),
      }));
    }, { retries: 3, label: 'GSC page queries', shouldRetry: isRetryableHttpError })
  );
}

/**
 * Get daily search performance trend.
 */
export async function getDailyTrend(siteUrl, opts = {}) {
  const sc = getSearchConsole();

  return rateLimited('google', () =>
    retry(async () => {
      const res = await sc.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate: resolveDate(opts.startDate || '30daysAgo'),
          endDate: resolveDate(opts.endDate || 'today'),
          dimensions: ['date'],
          type: 'web',
        },
      });
      return (res.data.rows || []).map(row => ({
        date: row.keys[0],
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: (row.ctr * 100).toFixed(1),
        position: row.position.toFixed(1),
      }));
    }, { retries: 3, label: 'GSC daily trend', shouldRetry: isRetryableHttpError })
  );
}

/**
 * Get search performance by device (DESKTOP, MOBILE, TABLET).
 */
export async function getDeviceBreakdown(siteUrl, opts = {}) {
  const sc = getSearchConsole();

  return rateLimited('google', () =>
    retry(async () => {
      const res = await sc.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate: resolveDate(opts.startDate || '30daysAgo'),
          endDate: resolveDate(opts.endDate || 'today'),
          dimensions: ['device'],
          type: 'web',
        },
      });
      return (res.data.rows || []).map(row => ({
        device: row.keys[0],
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: (row.ctr * 100).toFixed(1),
        position: row.position.toFixed(1),
      }));
    }, { retries: 3, label: 'GSC device breakdown', shouldRetry: isRetryableHttpError })
  );
}

/**
 * Resolve relative date strings to YYYY-MM-DD.
 */
function resolveDate(dateStr) {
  const match = dateStr.match(/^(\d+)daysAgo$/);
  if (match) {
    const d = new Date();
    d.setDate(d.getDate() - parseInt(match[1]));
    return d.toISOString().split('T')[0];
  }
  if (dateStr === 'today') {
    return new Date().toISOString().split('T')[0];
  }
  return dateStr; // already YYYY-MM-DD
}

export default {
  getTopQueries,
  getTopPages,
  getPageQueries,
  getDailyTrend,
  getDeviceBreakdown,
};
