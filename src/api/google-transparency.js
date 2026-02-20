import logger from '../utils/logger.js';
import * as firecrawl from './firecrawl.js';

const log = logger.child({ platform: 'google-transparency' });

const BASE_URL = 'https://adstransparency.google.com';

/**
 * Search the Google Ads Transparency Center for an advertiser.
 *
 * The Transparency Center has no public REST API — it's a JS-heavy SPA
 * powered by internal protobuf/gRPC calls. We use Firecrawl to:
 *   1. Web-search for the advertiser's page on the Transparency Center
 *   2. Scrape the found page to extract ad data from rendered content
 *
 * Always returns a direct URL so the user can check manually.
 */
export async function searchAdvertiser(opts = {}) {
  if (!opts.query) throw new Error('Search query is required');

  const query = opts.query;
  const searchUrl = `${BASE_URL}/advertiser?q=${encodeURIComponent(query)}`;

  if (!firecrawl.isConfigured()) {
    log.info('Firecrawl not configured, returning direct URL', { query });
    return {
      advertisers: [],
      query,
      transparencyUrl: searchUrl,
      source: 'google_ads_transparency_center',
      dataRetrieved: false,
      message: `Cannot access Google Ads Transparency Center programmatically. View directly: ${searchUrl}`,
    };
  }

  try {
    log.info('Searching for advertiser on Google Ads Transparency Center', { query });

    // Use Firecrawl web search to find the advertiser's transparency page
    const searchResults = await firecrawl.search(
      `"${query}" site:adstransparency.google.com`,
      { limit: 5 }
    );

    const results = searchResults.results || [];

    // Find a direct advertiser page (URL contains /advertiser/)
    const advertiserPage = results.find(r =>
      r.url?.includes('adstransparency.google.com/advertiser/')
    );

    if (advertiserPage) {
      const advertiserId = advertiserPage.url.match(/\/advertiser\/(AR[A-Za-z0-9]+)/)?.[1] || null;
      return {
        advertisers: [{
          id: advertiserId,
          name: advertiserPage.title?.replace(/ - Google Ads Transparency Center.*/, '').trim() || query,
          url: advertiserPage.url,
          description: advertiserPage.description || '',
        }],
        query,
        transparencyUrl: advertiserPage.url,
        source: 'google_ads_transparency_center',
        dataRetrieved: true,
      };
    }

    // No direct advertiser page — return whatever search found
    const relatedResults = results.slice(0, 3).map(r => ({
      title: r.title || '',
      url: r.url || '',
      description: r.description || '',
    }));

    return {
      advertisers: [],
      query,
      transparencyUrl: searchUrl,
      relatedResults,
      source: 'google_ads_transparency_center',
      dataRetrieved: false,
      message: `No direct advertiser page found for "${query}". Search manually: ${searchUrl}`,
    };
  } catch (e) {
    log.warn('Google Transparency search failed', { error: e.message, query });
    return {
      advertisers: [],
      query,
      transparencyUrl: searchUrl,
      source: 'google_ads_transparency_center',
      dataRetrieved: false,
      error: e.message,
      message: `Could not search Google Ads Transparency Center. View directly: ${searchUrl}`,
    };
  }
}

/**
 * Scrape an advertiser's Transparency Center page for ad creatives.
 * Uses Firecrawl to render the JS-heavy page and extract content.
 */
export async function getAdvertiserCreatives(advertiserUrl, opts = {}) {
  if (!advertiserUrl) throw new Error('Advertiser URL is required');

  if (!firecrawl.isConfigured()) {
    return {
      creatives: [],
      totalFound: 0,
      transparencyUrl: advertiserUrl,
      dataRetrieved: false,
      message: `Firecrawl not configured. View ads directly: ${advertiserUrl}`,
    };
  }

  try {
    log.info('Scraping advertiser page for creatives', { url: advertiserUrl });

    const result = await firecrawl.scrape(advertiserUrl, {
      formats: ['markdown'],
      waitFor: 5000, // Wait for JS to render ad creatives
      timeout: 15000,
      onlyMainContent: false, // Need full page including ad listings
    });

    const md = result.markdown || '';

    if (!md || md.length < 50) {
      return {
        creatives: [],
        totalFound: 0,
        transparencyUrl: advertiserUrl,
        dataRetrieved: false,
        message: `Page rendered but no content extracted. View directly: ${advertiserUrl}`,
      };
    }

    const parsed = parseTransparencyPage(md);

    return {
      creatives: parsed.creatives.slice(0, opts.limit || 20),
      totalFound: parsed.totalAds,
      adFormats: parsed.adFormats,
      dateRange: parsed.dateRange,
      advertiserName: parsed.advertiserName,
      transparencyUrl: advertiserUrl,
      pageContent: md.slice(0, 6000), // Raw content for Claude to interpret
      source: 'google_ads_transparency_center',
      dataRetrieved: true,
    };
  } catch (e) {
    log.warn('Failed to scrape advertiser page', { error: e.message, url: advertiserUrl });
    return {
      creatives: [],
      totalFound: 0,
      transparencyUrl: advertiserUrl,
      dataRetrieved: false,
      error: e.message,
      message: `Could not scrape advertiser page. View directly: ${advertiserUrl}`,
    };
  }
}

/**
 * Combined: find advertiser + get their creatives in one call.
 * This is the main function used by the search_google_ads_transparency tool.
 */
export async function searchAndGetCreatives(opts = {}) {
  if (!opts.query) throw new Error('Search query is required');

  const query = opts.query;
  const fallbackUrl = `${BASE_URL}/advertiser?q=${encodeURIComponent(query)}`;

  // Step 1: Find the advertiser
  let searchResult;
  try {
    searchResult = await searchAdvertiser(opts);
  } catch (e) {
    log.warn('Google Transparency search failed', { error: e.message, query });
    return {
      query,
      advertiserFound: false,
      advertisers: [],
      creatives: [],
      transparencyUrl: fallbackUrl,
      dataRetrieved: false,
      message: `Google Ads Transparency Center search failed. Try searching Meta Ad Library instead, or visit directly: ${fallbackUrl}`,
    };
  }

  const advertisers = searchResult.advertisers || [];

  if (advertisers.length === 0) {
    return {
      query,
      advertiserFound: false,
      advertisers: [],
      creatives: [],
      transparencyUrl: searchResult.transparencyUrl || fallbackUrl,
      relatedResults: searchResult.relatedResults || [],
      dataRetrieved: false,
      message: searchResult.message || `No advertiser found for "${query}" on Google Ads Transparency Center. This does NOT mean they aren't running ads — the search may have failed to find their page. Check manually: ${fallbackUrl}`,
    };
  }

  const topAdvertiser = advertisers[0];

  // Step 2: Scrape the advertiser's page for creatives
  if (topAdvertiser.url) {
    try {
      const creativesResult = await getAdvertiserCreatives(topAdvertiser.url, opts);
      return {
        query,
        advertiserFound: true,
        advertiser: topAdvertiser,
        advertisers,
        creatives: creativesResult.creatives,
        totalCreatives: creativesResult.totalFound,
        adFormats: creativesResult.adFormats,
        dateRange: creativesResult.dateRange,
        transparencyUrl: topAdvertiser.url,
        pageContent: creativesResult.pageContent,
        source: 'google_ads_transparency_center',
        dataRetrieved: creativesResult.dataRetrieved,
      };
    } catch (e) {
      log.warn('Failed to fetch creatives, returning advertiser info only', { error: e.message });
      return {
        query,
        advertiserFound: true,
        advertiser: topAdvertiser,
        advertisers,
        creatives: [],
        transparencyUrl: topAdvertiser.url,
        dataRetrieved: false,
        message: `Found advertiser but could not load creatives. View their ads at: ${topAdvertiser.url}`,
      };
    }
  }

  // Advertiser found but no URL to scrape
  return {
    query,
    advertiserFound: true,
    advertiser: topAdvertiser,
    advertisers,
    creatives: [],
    transparencyUrl: fallbackUrl,
    dataRetrieved: false,
    message: `Found advertiser "${topAdvertiser.name}" but could not retrieve creatives automatically. View their ads at: ${fallbackUrl}`,
  };
}

// --- Page Parser ---

/**
 * Parse the rendered Transparency Center page markdown to extract ad info.
 * The page content varies based on how much JS rendered, so we extract
 * what we can and pass the raw content to Claude for interpretation.
 */
function parseTransparencyPage(markdown) {
  const result = {
    advertiserName: '',
    totalAds: 0,
    adFormats: [],
    dateRange: null,
    creatives: [],
  };

  if (!markdown) return result;

  // Try to extract advertiser name (usually first heading or prominent text)
  const nameMatch = markdown.match(/^#\s+(.+)/m) ||
    markdown.match(/advertiser[:\s]+([^\n]+)/i);
  if (nameMatch) result.advertiserName = nameMatch[1].trim();

  // Try to extract total ad count
  const countMatch = markdown.match(/(\d[\d,]+)\s+ads?\b/i) ||
    markdown.match(/showing\s+(\d[\d,]+)/i);
  if (countMatch) result.totalAds = parseInt(countMatch[1].replace(/,/g, ''), 10);

  // Try to extract ad formats (Text, Image, Video)
  const formatMatches = markdown.matchAll(/(Text|Image|Video)\s*(?:ads?)?\s*[:(]\s*(\d[\d,]*)/gi);
  for (const m of formatMatches) {
    result.adFormats.push({
      format: m[1].toUpperCase(),
      count: parseInt(m[2].replace(/,/g, ''), 10),
    });
  }

  // Try to extract date range
  const dateMatch = markdown.match(
    /(?:from|since|between|date[s]?[:\s])\s*([\w\s,]+\d{4})\s*(?:to|[-–])\s*([\w\s,]+\d{4})/i
  );
  if (dateMatch) {
    result.dateRange = { from: dateMatch[1].trim(), to: dateMatch[2].trim() };
  }

  // Try to extract individual creative entries from repeated patterns
  // The transparency center shows creatives as cards with format + date info
  const creativeBlocks = markdown.split(/(?:^|\n)(?=(?:Text|Image|Video)\s+ad)/i);
  for (const block of creativeBlocks) {
    if (block.length < 10) continue;
    const formatMatch = block.match(/^(Text|Image|Video)\s+ad/i);
    if (!formatMatch) continue;

    const creative = {
      format: formatMatch[1].toUpperCase(),
      firstShown: null,
      lastShown: null,
      previewUrl: null,
    };

    // Extract dates from block
    const dates = block.match(
      /(\w+\s+\d{1,2},?\s+\d{4})/g
    );
    if (dates && dates.length >= 1) creative.firstShown = dates[0];
    if (dates && dates.length >= 2) creative.lastShown = dates[1];

    // Extract any image URLs from block
    const imgMatch = block.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/) ||
      block.match(/(https?:\/\/[^\s)]+\.(?:png|jpg|jpeg|gif|webp))/i);
    if (imgMatch) creative.previewUrl = imgMatch[1];

    result.creatives.push(creative);
  }

  return result;
}

export default {
  searchAdvertiser,
  getAdvertiserCreatives,
  searchAndGetCreatives,
};
