import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'dataforseo' });

const BASE_URL = 'https://api.dataforseo.com/v3';

function getAuthHeader() {
  const login = config.DATAFORSEO_LOGIN;
  const password = config.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    throw new Error('DataForSEO credentials not configured. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in .env');
  }
  return 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
}

async function apiPost(endpoint, data) {
  return retry(async () => {
    const res = await axios.post(`${BASE_URL}${endpoint}`, data, {
      headers: {
        Authorization: getAuthHeader(),
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });

    if (res.data?.status_code !== 20000) {
      throw new Error(`DataForSEO error: ${res.data?.status_message || 'Unknown error'}`);
    }

    return res.data;
  }, { retries: 2, label: `DataForSEO ${endpoint}`, shouldRetry: isRetryableHttpError });
}

// --- Keyword Data ---

/**
 * Get search volume and keyword metrics for a list of keywords.
 *
 * @param {object} opts
 * @param {string[]} opts.keywords - Keywords to look up (max 1000)
 * @param {string} opts.location - Location name (default: "United States")
 * @param {string} opts.language - Language name (default: "English")
 * @returns {Array} Keyword data with search volume, CPC, competition, trend
 */
export async function getKeywordData(opts = {}) {
  if (!opts.keywords || opts.keywords.length === 0) {
    throw new Error('Provide at least one keyword');
  }

  log.info('Fetching keyword data', { count: opts.keywords.length });

  const response = await apiPost('/keywords_data/google_ads/search_volume/live', [{
    keywords: opts.keywords.slice(0, 1000),
    location_name: opts.location || 'United States',
    language_name: opts.language || 'English',
  }]);

  const results = response.tasks?.[0]?.result || [];
  return results.map(r => ({
    keyword: r.keyword,
    searchVolume: r.search_volume || 0,
    competition: r.competition || 0,
    competitionLevel: r.competition_level || 'UNKNOWN',
    cpc: r.cpc || 0,
    monthlySearches: (r.monthly_searches || []).map(m => ({
      month: m.month,
      year: m.year,
      volume: m.search_volume,
    })),
  }));
}

/**
 * Get keyword suggestions/ideas based on seed keywords.
 *
 * @param {object} opts
 * @param {string} opts.keyword - Seed keyword
 * @param {string} opts.location - Location name
 * @param {string} opts.language - Language name
 * @param {number} opts.limit - Max results (default: 20)
 * @returns {Array} Related keyword ideas with metrics
 */
export async function getKeywordSuggestions(opts = {}) {
  if (!opts.keyword) {
    throw new Error('Provide a seed keyword');
  }

  log.info('Fetching keyword suggestions', { keyword: opts.keyword });

  const response = await apiPost('/keywords_data/google_ads/keywords_for_keywords/live', [{
    keywords: [opts.keyword],
    location_name: opts.location || 'United States',
    language_name: opts.language || 'English',
    sort_by: 'search_volume',
    limit: opts.limit || 20,
  }]);

  const results = response.tasks?.[0]?.result || [];
  return results.map(r => ({
    keyword: r.keyword,
    searchVolume: r.search_volume || 0,
    competition: r.competition || 0,
    competitionLevel: r.competition_level || 'UNKNOWN',
    cpc: r.cpc || 0,
  }));
}

// --- SERP Analysis ---

/**
 * Get live SERP results for a keyword.
 *
 * @param {object} opts
 * @param {string} opts.keyword - Keyword to search
 * @param {string} opts.location - Location name
 * @param {string} opts.language - Language name
 * @param {number} opts.depth - Number of results (default: 10)
 * @returns {object} SERP results with organic and paid listings
 */
export async function getSerpResults(opts = {}) {
  if (!opts.keyword) {
    throw new Error('Provide a keyword to search');
  }

  log.info('Fetching SERP results', { keyword: opts.keyword });

  const response = await apiPost('/serp/google/organic/live/regular', [{
    keyword: opts.keyword,
    location_name: opts.location || 'United States',
    language_name: opts.language || 'English',
    depth: opts.depth || 10,
  }]);

  const taskResult = response.tasks?.[0]?.result?.[0] || {};
  const items = taskResult.items || [];

  const organic = items
    .filter(i => i.type === 'organic')
    .map(i => ({
      position: i.rank_absolute,
      title: i.title,
      url: i.url,
      domain: i.domain,
      description: i.description,
    }));

  const paid = items
    .filter(i => i.type === 'paid')
    .map(i => ({
      position: i.rank_absolute,
      title: i.title,
      url: i.url,
      domain: i.domain,
      description: i.description,
    }));

  return {
    keyword: opts.keyword,
    totalResults: taskResult.se_results_count || 0,
    organic,
    paid,
    featuredSnippet: items.find(i => i.type === 'featured_snippet') || null,
  };
}

// --- Competitor Analysis ---

/**
 * Get competitors for a domain (who ranks for similar keywords).
 *
 * @param {object} opts
 * @param {string} opts.domain - Domain to analyze
 * @param {string} opts.location - Location name
 * @param {string} opts.language - Language name
 * @param {number} opts.limit - Max results (default: 10)
 * @returns {Array} Competitor domains with overlap metrics
 */
export async function getCompetitors(opts = {}) {
  if (!opts.domain) {
    throw new Error('Provide a domain to analyze');
  }

  log.info('Fetching competitors', { domain: opts.domain });

  const response = await apiPost('/dataforseo_labs/google/competitors_domain/live', [{
    target: opts.domain,
    location_name: opts.location || 'United States',
    language_name: opts.language || 'English',
    limit: opts.limit || 10,
  }]);

  const results = response.tasks?.[0]?.result?.[0]?.items || [];
  return results.map(r => ({
    domain: r.domain,
    avgPosition: r.avg_position,
    competitorRelevance: r.relevance,
    estimatedTraffic: r.se_traffic,
    keywordsCount: r.se_keywords,
    commonKeywords: r.intersections,
  }));
}

/**
 * Get keywords that competitors rank for but you don't (keyword gap).
 *
 * @param {object} opts
 * @param {string} opts.yourDomain - Your domain
 * @param {string} opts.competitorDomain - Competitor domain
 * @param {string} opts.location - Location name
 * @param {number} opts.limit - Max results (default: 20)
 * @returns {Array} Keywords the competitor ranks for that you're missing
 */
export async function getKeywordGap(opts = {}) {
  if (!opts.yourDomain || !opts.competitorDomain) {
    throw new Error('Provide both your domain and competitor domain');
  }

  log.info('Fetching keyword gap', { yours: opts.yourDomain, competitor: opts.competitorDomain });

  const response = await apiPost('/dataforseo_labs/google/domain_intersection/live', [{
    target1: opts.competitorDomain,
    target2: opts.yourDomain,
    location_name: opts.location || 'United States',
    language_name: opts.language || 'English',
    intersections: false, // keywords competitor has but you don't
    limit: opts.limit || 20,
    order_by: ['keyword_data.keyword_info.search_volume,desc'],
  }]);

  const results = response.tasks?.[0]?.result?.[0]?.items || [];
  return results.map(r => ({
    keyword: r.keyword_data?.keyword,
    searchVolume: r.keyword_data?.keyword_info?.search_volume || 0,
    competition: r.keyword_data?.keyword_info?.competition || 0,
    cpc: r.keyword_data?.keyword_info?.cpc || 0,
    competitorPosition: r.target1_serp_info?.serp_item?.rank_group,
    yourPosition: r.target2_serp_info?.serp_item?.rank_group || 'Not ranking',
  }));
}

// --- On-Page / Site Audit ---

/**
 * Run a quick on-page SEO audit for a specific URL.
 *
 * @param {object} opts
 * @param {string} opts.url - URL to audit
 * @returns {object} On-page audit results
 */
export async function onPageAudit(opts = {}) {
  if (!opts.url) {
    throw new Error('Provide a URL to audit');
  }

  log.info('Running on-page audit', { url: opts.url });

  const response = await apiPost('/on_page/instant_pages', [{
    url: opts.url,
    enable_javascript: true,
    enable_browser_rendering: true,
  }]);

  const page = response.tasks?.[0]?.result?.[0]?.items?.[0] || {};

  return {
    url: opts.url,
    statusCode: page.status_code,
    meta: {
      title: page.meta?.title,
      titleLength: page.meta?.title?.length || 0,
      description: page.meta?.description,
      descriptionLength: page.meta?.description?.length || 0,
      canonical: page.meta?.canonical,
      hasHreflang: page.meta?.htags?.hreflang?.length > 0,
    },
    headings: {
      h1: page.meta?.htags?.h1 || [],
      h2: page.meta?.htags?.h2 || [],
      h3Count: (page.meta?.htags?.h3 || []).length,
    },
    content: {
      wordCount: page.meta?.content?.plain_text_word_count || 0,
      readabilityScore: page.meta?.content?.automated_readability_index || null,
    },
    performance: {
      loadTime: page.page_timing?.duration_time,
      connectionTime: page.page_timing?.connection_time,
      downloadTime: page.page_timing?.download_time,
      size: page.size,
      encodedSize: page.encoded_size,
    },
    links: {
      internalCount: page.internal_links_count || 0,
      externalCount: page.external_links_count || 0,
    },
    images: {
      total: page.images_count || 0,
      withoutAlt: page.images_without_alt_count || 0,
    },
    checks: {
      isHttps: page.is_https,
      hasRobotsTxt: page.checks?.is_robots_txt,
      hasSitemap: page.checks?.is_sitemap,
      isMobileFriendly: page.checks?.is_mobile_friendly,
    },
  };
}

/**
 * Get domain ranking overview — how a domain performs in organic search.
 *
 * @param {object} opts
 * @param {string} opts.domain - Domain to analyze
 * @param {string} opts.location - Location name
 * @returns {object} Domain SEO overview
 */
export async function getDomainOverview(opts = {}) {
  if (!opts.domain) {
    throw new Error('Provide a domain');
  }

  log.info('Fetching domain overview', { domain: opts.domain });

  const response = await apiPost('/dataforseo_labs/google/domain_rank_overview/live', [{
    target: opts.domain,
    location_name: opts.location || 'United States',
    language_name: opts.language || 'English',
  }]);

  const data = response.tasks?.[0]?.result?.[0]?.items?.[0] || {};
  return {
    domain: opts.domain,
    organicTraffic: data.metrics?.organic?.etv || 0,
    organicKeywords: data.metrics?.organic?.count || 0,
    paidTraffic: data.metrics?.paid?.etv || 0,
    paidKeywords: data.metrics?.paid?.count || 0,
    backlinks: data.metrics?.organic?.is_referring_domains || 0,
  };
}

export default {
  getKeywordData, getKeywordSuggestions,
  getSerpResults, getCompetitors, getKeywordGap,
  onPageAudit, getDomainOverview,
};
