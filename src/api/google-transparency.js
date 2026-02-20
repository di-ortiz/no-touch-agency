import axios from 'axios';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';

const log = logger.child({ platform: 'google-transparency' });

const BASE_URL = 'https://adstransparency.google.com';

/**
 * Search the Google Ads Transparency Center for advertiser creatives.
 *
 * Uses the public RPC endpoint that powers the Transparency Center web UI.
 * No retries — this is a scraping endpoint that may block server IPs.
 * Fails fast so Sofia can fall back to Meta Ad Library or DataForSEO.
 *
 * @param {object} opts
 * @param {string} opts.query - Advertiser name or domain to search
 * @param {string} opts.region - Region code (default: 'anywhere')
 * @param {number} opts.limit - Max results (default: 10)
 * @returns {object} Advertiser results with creative data
 */
export async function searchAdvertiser(opts = {}) {
  if (!opts.query) throw new Error('Search query is required');

  return rateLimited('google', async () => {
    log.info('Searching Google Ads Transparency Center', { query: opts.query });

    const searchRes = await axios.get(`${BASE_URL}/anji/_/rpc/SearchService/SearchAdvertisers`, {
      params: {
        q: opts.query,
        region: opts.region || 'anywhere',
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      timeout: 8000, // fail fast
      validateStatus: (s) => s < 500, // don't throw on 4xx — just return empty
    });

    if (searchRes.status >= 400) {
      log.warn('Google Transparency returned non-OK status', { status: searchRes.status, query: opts.query });
      return { advertisers: [], query: opts.query, source: 'google_ads_transparency_center' };
    }

    const advertisers = parseSearchResults(searchRes.data);
    if (advertisers.length === 0) {
      log.info('No advertisers found', { query: opts.query });
      return { advertisers: [], creatives: [], query: opts.query };
    }

    return {
      query: opts.query,
      advertisers: advertisers.slice(0, opts.limit || 10),
      source: 'google_ads_transparency_center',
    };
  });
}

/**
 * Get creatives for a specific advertiser by their ID.
 */
export async function getAdvertiserCreatives(advertiserId, opts = {}) {
  return rateLimited('google', async () => {
    log.info('Fetching advertiser creatives', { advertiserId });

    const res = await axios.get(`${BASE_URL}/anji/_/rpc/SearchService/SearchCreatives`, {
      params: {
        advertiser_id: advertiserId,
        region: opts.region || 'anywhere',
        format: opts.format || '',
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      timeout: 8000,
      validateStatus: (s) => s < 500,
    });

    if (res.status >= 400) {
      log.warn('Google Transparency creatives returned non-OK status', { status: res.status, advertiserId });
      return { advertiserId, creatives: [], totalFound: 0 };
    }

    const creatives = parseCreativeResults(res.data);
    return {
      advertiserId,
      creatives: creatives.slice(0, opts.limit || 20),
      totalFound: creatives.length,
      source: 'google_ads_transparency_center',
    };
  });
}

/**
 * Combined search: find advertiser + get their creatives in one call.
 */
export async function searchAndGetCreatives(opts = {}) {
  let searchResult;
  try {
    searchResult = await searchAdvertiser(opts);
  } catch (e) {
    // Fail fast — don't let network errors waste time
    log.warn('Google Transparency search failed', { error: e.message, query: opts.query });
    return {
      query: opts.query,
      advertiserFound: false,
      advertisers: [],
      creatives: [],
      error: e.message,
      message: `Google Ads Transparency Center is currently unavailable. Try searching the Meta Ad Library instead, or visit directly: ${BASE_URL}/?q=${encodeURIComponent(opts.query || '')}`,
    };
  }

  if (!searchResult.advertisers || searchResult.advertisers.length === 0) {
    return {
      query: opts.query,
      advertiserFound: false,
      advertisers: [],
      creatives: [],
      message: `No advertisers found for "${opts.query}" on Google Ads Transparency Center. You can view it directly at: ${BASE_URL}/?q=${encodeURIComponent(opts.query || '')}`,
    };
  }

  const topAdvertiser = searchResult.advertisers[0];
  if (!topAdvertiser.id) {
    return {
      query: opts.query,
      advertiserFound: true,
      advertisers: searchResult.advertisers,
      creatives: [],
      message: `Found advertiser(s) but could not retrieve creatives. View directly: ${BASE_URL}/?q=${encodeURIComponent(opts.query)}`,
    };
  }

  try {
    const creativesResult = await getAdvertiserCreatives(topAdvertiser.id, opts);
    return {
      query: opts.query,
      advertiserFound: true,
      advertiser: topAdvertiser,
      creatives: creativesResult.creatives,
      totalCreatives: creativesResult.totalFound,
      transparencyUrl: `${BASE_URL}/advertiser/${topAdvertiser.id}`,
    };
  } catch (e) {
    log.warn('Failed to fetch creatives, returning advertiser info only', { error: e.message });
    return {
      query: opts.query,
      advertiserFound: true,
      advertiser: topAdvertiser,
      creatives: [],
      transparencyUrl: `${BASE_URL}/advertiser/${topAdvertiser.id}`,
      message: `Creatives could not be fetched automatically. View at: ${BASE_URL}/advertiser/${topAdvertiser.id}`,
    };
  }
}

// --- Parsers ---

function parseSearchResults(data) {
  if (!data) return [];
  try {
    if (Array.isArray(data)) {
      return data.map(item => ({
        id: item[0] || item.advertiserId,
        name: item[1] || item.advertiserName || 'Unknown',
        region: item[2] || null,
        verificationStatus: item[3] || null,
      })).filter(a => a.id);
    }
    if (data.advertisers) {
      return data.advertisers.map(a => ({
        id: a.advertiserId || a.id,
        name: a.advertiserName || a.name || 'Unknown',
        region: a.region || null,
        verificationStatus: a.verificationStatus || null,
      }));
    }
    return [];
  } catch {
    return [];
  }
}

function parseCreativeResults(data) {
  if (!data) return [];
  try {
    if (Array.isArray(data)) {
      return data.map(item => ({
        id: item[0] || null,
        format: item[1] || 'UNKNOWN',
        firstShown: item[2] || null,
        lastShown: item[3] || null,
        previewUrl: item[4] || null,
        regions: item[5] || [],
      })).filter(c => c.id);
    }
    if (data.creatives) {
      return data.creatives.map(c => ({
        id: c.creativeId || c.id,
        format: c.format || 'UNKNOWN',
        firstShown: c.firstShownDate || null,
        lastShown: c.lastShownDate || null,
        previewUrl: c.previewUrl || null,
        regions: c.regions || [],
      }));
    }
    return [];
  } catch {
    return [];
  }
}

export default {
  searchAdvertiser,
  getAdvertiserCreatives,
  searchAndGetCreatives,
};
