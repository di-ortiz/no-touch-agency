import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';
import { recordCost } from '../services/cost-tracker.js';

const log = logger.child({ platform: 'meta-ad-library' });
const API_VERSION = 'v21.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

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
 * @param {string} opts.fields - Fields to return
 * @param {string} opts.searchPageIds - Comma-separated Page IDs to search
 * @param {string} opts.adReachedCountries - Country codes for targeting
 */
export async function searchAds(opts = {}) {
  const {
    searchTerms,
    country = 'BR',
    adType = 'ALL',
    adActiveStatus = 'ACTIVE',
    limit = 10,
    searchPageIds,
    fields = 'id,ad_creation_time,ad_delivery_start_time,ad_delivery_stop_time,ad_creative_bodies,ad_creative_link_captions,ad_creative_link_descriptions,ad_creative_link_titles,ad_snapshot_url,page_id,page_name,publisher_platforms,estimated_audience_size,impressions,spend,currency',
  } = opts;

  if (!searchTerms && !searchPageIds) {
    throw new Error('Either searchTerms or searchPageIds is required');
  }

  const params = {
    access_token: config.META_ACCESS_TOKEN,
    ad_type: adType,
    ad_active_status: adActiveStatus,
    ad_reached_countries: JSON.stringify([country]),
    fields,
    limit,
  };

  if (searchTerms) params.search_terms = searchTerms;
  if (searchPageIds) params.search_page_ids = searchPageIds;

  return rateLimited('meta', () =>
    retry(async () => {
      const res = await axios.get(`${BASE_URL}/ads_archive`, {
        params,
        timeout: 30000,
      });

      recordCost({ platform: 'meta', workflow: 'ad-library', costCentsOverride: 0 });
      log.info('Ad Library search', { terms: searchTerms, results: res.data?.data?.length || 0 });
      return res.data;
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
 */
export async function searchPages(query) {
  return rateLimited('meta', () =>
    retry(async () => {
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
    }, { retries: 2, label: 'Meta Page search', shouldRetry: isRetryableHttpError })
  );
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
