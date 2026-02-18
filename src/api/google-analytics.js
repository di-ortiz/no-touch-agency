import { google } from 'googleapis';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';
import fs from 'fs';

const log = logger.child({ platform: 'google-analytics' });

let auth;
let analyticsClient;

function getAuth() {
  if (!auth) {
    const credPath = config.GOOGLE_APPLICATION_CREDENTIALS || 'config/google-service-account.json';
    if (fs.existsSync(credPath)) {
      auth = new google.auth.GoogleAuth({
        keyFile: credPath,
        scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
      });
    } else {
      log.error('Google credentials MISSING', { credPath });
      throw new Error(
        `Google service account credentials not found. ` +
        `Expected credentials at "${credPath}" but the file does NOT exist. ` +
        `To fix: download the service account JSON key from console.cloud.google.com and save it to ${credPath}`
      );
    }
  }
  return auth;
}

function getAnalytics() {
  if (!analyticsClient) {
    const a = getAuth();
    if (!a) return null;
    analyticsClient = google.analyticsdata({ version: 'v1beta', auth: a });
  }
  return analyticsClient;
}

/**
 * Run a GA4 report query.
 */
async function runReport(propertyId, params) {
  const analytics = getAnalytics();
  if (!analytics) throw new Error('Google Analytics not configured');

  return rateLimited('google', () =>
    retry(async () => {
      const res = await analytics.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: params,
      });
      return res.data;
    }, { retries: 3, label: 'GA4 report', shouldRetry: isRetryableHttpError })
  );
}

/**
 * Get core metrics for a date range.
 *
 * @param {string} propertyId - GA4 property ID
 * @param {object} opts
 * @param {string} opts.startDate - Start date (YYYY-MM-DD or relative: '7daysAgo')
 * @param {string} opts.endDate - End date (YYYY-MM-DD or 'today')
 * @returns {object} Aggregated metrics
 */
export async function getPropertyMetrics(propertyId, opts = {}) {
  const startDate = opts.startDate || '30daysAgo';
  const endDate = opts.endDate || 'today';

  const data = await runReport(propertyId, {
    dateRanges: [{ startDate, endDate }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'screenPageViews' },
      { name: 'averageSessionDuration' },
      { name: 'bounceRate' },
      { name: 'engagementRate' },
      { name: 'conversions' },
      { name: 'eventCount' },
    ],
  });

  const row = data.rows?.[0]?.metricValues || [];
  return {
    sessions: parseInt(row[0]?.value || 0),
    totalUsers: parseInt(row[1]?.value || 0),
    newUsers: parseInt(row[2]?.value || 0),
    pageViews: parseInt(row[3]?.value || 0),
    avgSessionDuration: parseFloat(row[4]?.value || 0).toFixed(1),
    bounceRate: (parseFloat(row[5]?.value || 0) * 100).toFixed(1),
    engagementRate: (parseFloat(row[6]?.value || 0) * 100).toFixed(1),
    conversions: parseInt(row[7]?.value || 0),
    totalEvents: parseInt(row[8]?.value || 0),
    dateRange: { startDate, endDate },
  };
}

/**
 * Get top pages by pageviews.
 */
export async function getTopPages(propertyId, opts = {}) {
  const data = await runReport(propertyId, {
    dateRanges: [{ startDate: opts.startDate || '30daysAgo', endDate: opts.endDate || 'today' }],
    dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'averageSessionDuration' },
      { name: 'bounceRate' },
      { name: 'conversions' },
    ],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: opts.limit || 20,
  });

  return (data.rows || []).map(row => ({
    path: row.dimensionValues[0]?.value,
    title: row.dimensionValues[1]?.value,
    pageViews: parseInt(row.metricValues[0]?.value || 0),
    avgDuration: parseFloat(row.metricValues[1]?.value || 0).toFixed(1),
    bounceRate: (parseFloat(row.metricValues[2]?.value || 0) * 100).toFixed(1),
    conversions: parseInt(row.metricValues[3]?.value || 0),
  }));
}

/**
 * Get traffic source breakdown.
 */
export async function getTrafficSources(propertyId, opts = {}) {
  const data = await runReport(propertyId, {
    dateRanges: [{ startDate: opts.startDate || '30daysAgo', endDate: opts.endDate || 'today' }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'conversions' },
      { name: 'engagementRate' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: opts.limit || 15,
  });

  return (data.rows || []).map(row => ({
    channel: row.dimensionValues[0]?.value,
    sessions: parseInt(row.metricValues[0]?.value || 0),
    users: parseInt(row.metricValues[1]?.value || 0),
    conversions: parseInt(row.metricValues[2]?.value || 0),
    engagementRate: (parseFloat(row.metricValues[3]?.value || 0) * 100).toFixed(1),
  }));
}

/**
 * Get audience demographics (device, country, age, gender).
 */
export async function getAudienceDemographics(propertyId, opts = {}) {
  const dateRanges = [{ startDate: opts.startDate || '30daysAgo', endDate: opts.endDate || 'today' }];

  const [deviceData, countryData, genderData] = await Promise.all([
    runReport(propertyId, {
      dateRanges,
      dimensions: [{ name: 'deviceCategory' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    }),
    runReport(propertyId, {
      dateRanges,
      dimensions: [{ name: 'country' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 10,
    }),
    runReport(propertyId, {
      dateRanges,
      dimensions: [{ name: 'userGender' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
    }),
  ]);

  return {
    devices: (deviceData.rows || []).map(r => ({
      device: r.dimensionValues[0]?.value,
      sessions: parseInt(r.metricValues[0]?.value || 0),
      users: parseInt(r.metricValues[1]?.value || 0),
    })),
    countries: (countryData.rows || []).map(r => ({
      country: r.dimensionValues[0]?.value,
      sessions: parseInt(r.metricValues[0]?.value || 0),
      users: parseInt(r.metricValues[1]?.value || 0),
    })),
    gender: (genderData.rows || []).map(r => ({
      gender: r.dimensionValues[0]?.value,
      sessions: parseInt(r.metricValues[0]?.value || 0),
      users: parseInt(r.metricValues[1]?.value || 0),
    })),
  };
}

/**
 * Get daily metrics trend for charts / projections.
 */
export async function getDailyTrend(propertyId, opts = {}) {
  const data = await runReport(propertyId, {
    dateRanges: [{ startDate: opts.startDate || '30daysAgo', endDate: opts.endDate || 'today' }],
    dimensions: [{ name: 'date' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'conversions' },
      { name: 'screenPageViews' },
    ],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
  });

  return (data.rows || []).map(row => ({
    date: row.dimensionValues[0]?.value,
    sessions: parseInt(row.metricValues[0]?.value || 0),
    users: parseInt(row.metricValues[1]?.value || 0),
    conversions: parseInt(row.metricValues[2]?.value || 0),
    pageViews: parseInt(row.metricValues[3]?.value || 0),
  }));
}

/**
 * Get conversion events breakdown.
 */
export async function getConversionEvents(propertyId, opts = {}) {
  const data = await runReport(propertyId, {
    dateRanges: [{ startDate: opts.startDate || '30daysAgo', endDate: opts.endDate || 'today' }],
    dimensions: [{ name: 'eventName' }],
    metrics: [
      { name: 'conversions' },
      { name: 'eventCount' },
    ],
    dimensionFilter: {
      filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: '' } },
    },
    orderBys: [{ metric: { metricName: 'conversions' }, desc: true }],
    limit: opts.limit || 20,
  });

  // Filter only events with conversions > 0
  return (data.rows || [])
    .map(row => ({
      event: row.dimensionValues[0]?.value,
      conversions: parseInt(row.metricValues[0]?.value || 0),
      totalFires: parseInt(row.metricValues[1]?.value || 0),
    }))
    .filter(e => e.conversions > 0);
}

export default {
  getPropertyMetrics,
  getTopPages,
  getTrafficSources,
  getAudienceDemographics,
  getDailyTrend,
  getConversionEvents,
};
