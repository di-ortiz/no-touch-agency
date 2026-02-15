import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';
import { recordCost } from '../services/cost-tracker.js';

const log = logger.child({ platform: 'meta-ad-library' });
const API_VERSION = 'v22.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

// Fields available for ALL ad types (commercial ads)
const BASE_FIELDS = 'id,ad_creation_time,ad_delivery_start_time,ad_delivery_stop_time,ad_creative_bodies,ad_creative_link_captions,ad_creative_link_descriptions,ad_creative_link_titles,ad_snapshot_url,page_id,page_name,publisher_platforms,languages';

// Additional fields only available for POLITICAL_AND_ISSUE_ADS or EU/UK ads
const POLITICAL_FIELDS = ',estimated_audience_size,impressions,spend,currency,demographic_distribution,delivery_by_region,funding_entity,bylines';

// EU/UK country codes where spend/impressions data is available for all ads
const EU_UK_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB',
]);

/**
 * Search the Meta Ad Library for competitor ads.
 * Uses the Ad Library API: https://www.facebook.com/ads/library/api/
 *
 * @param {object} opts
 * @param {string} opts.searchTerms - Keywords or brand name to search
 * @param {string} opts.country - ISO country code (default: 'BR')
 * @param {string} opts.adType - ALL, POLITICAL_AND_ISSUE_ADS (default: 'ALL')
 * @param {string} opts.adActiveStatus - ACTIVE, INACTIVE, ALL (default: 'ACTIVE')
 * @param {number} opts.limit - Max results (default: 10)
 * @param {string} opts.fields - Fields to return (auto-selected based on adType and country if not provided)
 * @param {string} opts.searchPageIds - Comma-separated Page IDs to search
 */
export async function searchAds(opts = {}) {
  const {
    searchTerms,
    country = 'BR',
    adType = 'ALL',
    adActiveStatus = 'ACTIVE',
    limit = 10,
    searchPageIds,
    fields,
  } = opts;

  if (!searchTerms && !searchPageIds) {
    throw new Error('Either searchTerms or searchPageIds is required');
  }

  // Auto-select fields: include spend/impressions only for political ads or EU/UK countries
  const isPolitical = adType === 'POLITICAL_AND_ISSUE_ADS';
  const isEU = EU_UK_COUNTRIES.has(country);
  const selectedFields = fields || (isPolitical || isEU ? BASE_FIELDS + POLITICAL_FIELDS : BASE_FIELDS);

  const params = {
    access_token: config.META_ACCESS_TOKEN,
    ad_type: adType,
    ad_active_status: adActiveStatus,
    ad_reached_countries: JSON.stringify([country]),
    fields: selectedFields,
    limit,
  };

  if (searchTerms) params.search_terms = searchTerms;
  if (searchPageIds) params.search_page_ids = searchPageIds;

  return rateLimited('meta', () =>
    retry(async () => {
      try {
        const res = await axios.get(`${BASE_URL}/ads_archive`, {
          params,
          timeout: 30000,
        });

        recordCost({ platform: 'meta', workflow: 'ad-library', costCentsOverride: 0 });
        log.info('Ad Library search', { terms: searchTerms, results: res.data?.data?.length || 0 });
        return res.data;
      } catch (error) {
        // Surface the actual Meta API error message for better debugging
        const metaError = error.response?.data?.error;
        if (metaError) {
          const msg = `Meta Ad Library API error (${metaError.code || error.response?.status}): ${metaError.message || 'Unknown error'}`;
          log.error(msg, { type: metaError.type, fbtraceId: metaError.fbtrace_id });
          throw new Error(msg);
        }
        throw error;
      }
    }, { retries: 3, label: 'Meta Ad Library search', shouldRetry: isRetryableHttpError })
  );
}

/**
 * Get ads from a specific Facebook Page.
 */
export async function getPageAds(pageId, opts = {}) {
  return searchAds({
    searchPageIds: pageId,
    country: opts.country || 'BR',
    adActiveStatus: opts.adActiveStatus || 'ACTIVE',
    limit: opts.limit || 10,
  });
}

/**
 * Search for a Facebook Page by name to get its ID.
 * Falls back to Ad Library search if the Pages Search API is unavailable.
 */
export async function searchPages(query) {
  // Try the Pages Search API first
  try {
    const result = await rateLimited('meta', () =>
      retry(async () => {
        try {
          const res = await axios.get(`${BASE_URL}/pages/search`, {
            params: {
              access_token: config.META_ACCESS_TOKEN,
              q: query,
              fields: 'id,name,category,fan_count,verification_status,link',
            },
            timeout: 15000,
          });

          recordCost({ platform: 'meta', workflow: 'ad-library', costCentsOverride: 0 });
          return res.data;
        } catch (error) {
          const metaError = error.response?.data?.error;
          if (metaError) {
            throw new Error(`Meta Pages API error (${metaError.code || error.response?.status}): ${metaError.message}`);
          }
          throw error;
        }
      }, { retries: 1, label: 'Meta Page search', shouldRetry: isRetryableHttpError })
    );
    return result;
  } catch (e) {
    log.warn('Pages Search API failed, falling back to Ad Library search', { error: e.message });

    // Fallback: search the Ad Library by keyword and extract unique page info
    const adResults = await searchAds({ searchTerms: query, limit: 10 });
    const pagesMap = new Map();
    for (const ad of adResults?.data || []) {
      if (ad.page_id && !pagesMap.has(ad.page_id)) {
        pagesMap.set(ad.page_id, {
          id: ad.page_id,
          name: ad.page_name || 'Unknown',
          category: null,
          fan_count: null,
          verification_status: null,
          link: null,
        });
      }
    }
    return { data: Array.from(pagesMap.values()) };
  }
}

/**
 * Parse Ad Library results into a clean format for display.
 */
export function parseAdLibraryResults(data) {
  if (!data?.data || data.data.length === 0) return [];

  return data.data.map(ad => {
    const headlines = ad.ad_creative_link_titles || [];
    const bodies = ad.ad_creative_bodies || [];
    const descriptions = ad.ad_creative_link_descriptions || [];
    const captions = ad.ad_creative_link_captions || [];

    return {
      id: ad.id,
      pageName: ad.page_name || 'Unknown',
      pageId: ad.page_id,
      startDate: ad.ad_delivery_start_time || ad.ad_creation_time,
      endDate: ad.ad_delivery_stop_time || null,
      isActive: !ad.ad_delivery_stop_time,
      headline: headlines[0] || '',
      body: bodies[0] || '',
      description: descriptions[0] || '',
      caption: captions[0] || '',
      allHeadlines: headlines,
      allBodies: bodies,
      platforms: ad.publisher_platforms || [],
      snapshotUrl: ad.ad_snapshot_url || null,
      estimatedAudience: ad.estimated_audience_size || null,
      impressions: ad.impressions || null,
      spend: ad.spend || null,
      currency: ad.currency || null,
    };
  });
}

/**
 * Format parsed ads for WhatsApp delivery.
 */
export function formatAdsForWhatsApp(parsedAds, competitorName) {
  if (parsedAds.length === 0) {
    return `🔍 No active ads found for *${competitorName}*.`;
  }

  const lines = [
    `🔍 *Competitor Ads: ${competitorName}*`,
    `Found ${parsedAds.length} active ad(s)\n`,
  ];

  for (let i = 0; i < parsedAds.length; i++) {
    const ad = parsedAds[i];
    lines.push(`━━━ Ad ${i + 1} ━━━`);
    lines.push(`📄 *Page:* ${ad.pageName}`);

    if (ad.headline) {
      lines.push(`📝 *Headline:* ${ad.headline}`);
    }
    if (ad.body) {
      // Truncate long body copy for WhatsApp
      const bodyPreview = ad.body.length > 200
        ? ad.body.slice(0, 200) + '...'
        : ad.body;
      lines.push(`💬 *Copy:* ${bodyPreview}`);
    }
    if (ad.description) {
      lines.push(`📋 *Description:* ${ad.description}`);
    }
    if (ad.platforms.length > 0) {
      lines.push(`📱 *Platforms:* ${ad.platforms.join(', ')}`);
    }
    if (ad.startDate) {
      lines.push(`📅 *Running since:* ${ad.startDate.split('T')[0]}`);
    }
    if (ad.snapshotUrl) {
      lines.push(`🔗 *View:* ${ad.snapshotUrl}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export default { searchAds, getPageAds, searchPages, parseAdLibraryResults, formatAdsForWhatsApp };
