import axios from 'axios';
import { google } from 'googleapis';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'keyword-planner' });

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

/**
 * Generate keyword ideas from Google Keyword Planner.
 *
 * @param {object} opts
 * @param {string[]} opts.keywords - Seed keywords to get ideas for
 * @param {string} opts.url - URL to extract keyword ideas from (optional)
 * @param {string} opts.language - Language resource name (default: English 1000)
 * @param {string[]} opts.geoTargets - Geo target constant IDs (default: US 2840)
 * @param {number} opts.limit - Max keywords to return (default: 20)
 * @returns {Array} Keyword ideas with search volume, competition, CPC
 */
export async function getKeywordIdeas(opts = {}) {
  const customerId = config.GOOGLE_ADS_MANAGER_ACCOUNT_ID;
  if (!customerId) {
    throw new Error('Google Ads Manager Account ID not configured');
  }

  return rateLimited('googleAds', () =>
    retry(async () => {
      const token = await getAccessToken();

      const body = {
        language: opts.language || `customers/${customerId}/languageConstants/1000`,
        geoTargetConstants: (opts.geoTargets || ['2840']).map(
          id => `geoTargetConstants/${id}`
        ),
        keywordPlanNetwork: 'GOOGLE_SEARCH',
      };

      // Either use seed keywords or a URL, or both
      if (opts.keywords && opts.keywords.length > 0) {
        body.keywordSeed = { keywords: opts.keywords };
      }
      if (opts.url) {
        body.urlSeed = { url: opts.url };
      }
      if (!body.keywordSeed && !body.urlSeed) {
        throw new Error('Provide either keywords or a URL for keyword ideas');
      }

      log.info('Fetching keyword ideas', { keywords: opts.keywords, url: opts.url });

      const res = await axios.post(
        `${BASE_URL}/customers/${customerId}:generateKeywordIdeas`,
        body,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'developer-token': config.GOOGLE_ADS_DEVELOPER_TOKEN,
            'login-customer-id': customerId,
          },
          timeout: 30000,
        },
      );

      const ideas = (res.data.results || []).map(r => ({
        keyword: r.text,
        avgMonthlySearches: parseInt(r.keywordIdeaMetrics?.avgMonthlySearches || 0),
        competition: r.keywordIdeaMetrics?.competition || 'UNSPECIFIED',
        competitionIndex: r.keywordIdeaMetrics?.competitionIndex || 0,
        lowTopOfPageBidMicros: r.keywordIdeaMetrics?.lowTopOfPageBidMicros || 0,
        highTopOfPageBidMicros: r.keywordIdeaMetrics?.highTopOfPageBidMicros || 0,
        lowTopOfPageBid: ((r.keywordIdeaMetrics?.lowTopOfPageBidMicros || 0) / 1_000_000).toFixed(2),
        highTopOfPageBid: ((r.keywordIdeaMetrics?.highTopOfPageBidMicros || 0) / 1_000_000).toFixed(2),
      }));

      // Sort by search volume descending
      ideas.sort((a, b) => b.avgMonthlySearches - a.avgMonthlySearches);

      const limit = opts.limit || 20;
      const result = ideas.slice(0, limit);

      log.info('Keyword ideas fetched', { count: result.length });
      return result;
    }, { retries: 2, label: 'Keyword Planner', shouldRetry: isRetryableHttpError })
  );
}

/**
 * Get historical search volume for specific keywords.
 *
 * @param {object} opts
 * @param {string[]} opts.keywords - Keywords to get volume for
 * @param {string[]} opts.geoTargets - Geo target IDs (default: US)
 * @returns {Array} Keywords with monthly search volume data
 */
export async function getSearchVolume(opts = {}) {
  const customerId = config.GOOGLE_ADS_MANAGER_ACCOUNT_ID;
  if (!customerId) {
    throw new Error('Google Ads Manager Account ID not configured');
  }

  if (!opts.keywords || opts.keywords.length === 0) {
    throw new Error('Provide at least one keyword');
  }

  return rateLimited('googleAds', () =>
    retry(async () => {
      const token = await getAccessToken();

      const body = {
        language: `customers/${customerId}/languageConstants/1000`,
        geoTargetConstants: (opts.geoTargets || ['2840']).map(
          id => `geoTargetConstants/${id}`
        ),
        keywordPlanNetwork: 'GOOGLE_SEARCH',
        keywords: opts.keywords,
      };

      log.info('Fetching search volume', { keywords: opts.keywords });

      const res = await axios.post(
        `${BASE_URL}/customers/${customerId}:generateKeywordHistoricalMetrics`,
        body,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'developer-token': config.GOOGLE_ADS_DEVELOPER_TOKEN,
            'login-customer-id': customerId,
          },
          timeout: 30000,
        },
      );

      return (res.data.results || []).map(r => ({
        keyword: r.text,
        avgMonthlySearches: parseInt(r.keywordMetrics?.avgMonthlySearches || 0),
        competition: r.keywordMetrics?.competition || 'UNSPECIFIED',
        competitionIndex: r.keywordMetrics?.competitionIndex || 0,
        lowTopOfPageBid: ((r.keywordMetrics?.lowTopOfPageBidMicros || 0) / 1_000_000).toFixed(2),
        highTopOfPageBid: ((r.keywordMetrics?.highTopOfPageBidMicros || 0) / 1_000_000).toFixed(2),
        monthlySearchVolumes: (r.keywordMetrics?.monthlySearchVolumes || []).map(m => ({
          month: m.month,
          year: m.year,
          searches: parseInt(m.monthlySearches || 0),
        })),
      }));
    }, { retries: 2, label: 'Search Volume', shouldRetry: isRetryableHttpError })
  );
}

export default { getKeywordIdeas, getSearchVolume };
