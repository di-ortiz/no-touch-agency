import logger from '../utils/logger.js';
import * as firecrawl from './firecrawl.js';

const log = logger.child({ platform: 'google-transparency' });

const BASE_URL = 'https://adstransparency.google.com';

/**
 * Build the correct Google Ads Transparency Center URL.
 *
 * The Transparency Center uses these URL params:
 *   - domain: advertiser domain (e.g. "v4company.com")
 *   - region: 2-letter country code (e.g. "BR", "US") or omit for worldwide
 *
 * @param {string} query - Domain or advertiser name
 * @param {string} region - Region code (e.g. "BR", "US", "anywhere")
 * @returns {string} The transparency center URL
 */
function buildTransparencyUrl(query, region) {
  const params = new URLSearchParams();

  // Normalize region — "anywhere" or empty means no filter
  const regionCode = (region && region.toLowerCase() !== 'anywhere') ? region.toUpperCase() : '';
  if (regionCode) params.set('region', regionCode);

  // If query looks like a domain, use domain= param; otherwise use it as-is
  const isDomain = /^[a-zA-Z0-9]([a-zA-Z0-9-]*\.)+[a-zA-Z]{2,}$/.test(query.trim());
  if (isDomain) {
    params.set('domain', query.trim().toLowerCase());
  } else {
    // Try to extract domain if it's embedded in the query (e.g. "V4 Company v4company.com")
    const domainMatch = query.match(/([a-zA-Z0-9]([a-zA-Z0-9-]*\.)+[a-zA-Z]{2,})/);
    if (domainMatch) {
      params.set('domain', domainMatch[1].toLowerCase());
    } else {
      // Use as text query — the transparency center search box
      params.set('q', query.trim());
    }
  }

  return `${BASE_URL}/?${params.toString()}`;
}

/**
 * Search the Google Ads Transparency Center for an advertiser.
 *
 * Strategy:
 *   1. Build the correct transparency URL with domain= and region= params
 *   2. Try to scrape that URL directly with Firecrawl (renders JS)
 *   3. Fall back to Firecrawl web search if direct scrape yields nothing
 *   4. Always return the correct URL so the user can check manually
 */
export async function searchAdvertiser(opts = {}) {
  if (!opts.query) throw new Error('Search query is required');

  const query = opts.query;
  const region = opts.region || '';
  const transparencyUrl = buildTransparencyUrl(query, region);

  if (!firecrawl.isConfigured()) {
    log.info('Firecrawl not configured, returning direct URL', { query });
    return {
      advertisers: [],
      query,
      transparencyUrl,
      source: 'google_ads_transparency_center',
      dataRetrieved: false,
      message: `Cannot access Google Ads Transparency Center programmatically. View directly: ${transparencyUrl}`,
    };
  }

  // --- Method 1: Direct scrape of the transparency URL ---
  try {
    log.info('Direct scraping Google Ads Transparency Center', { url: transparencyUrl, query });

    const result = await firecrawl.scrape(transparencyUrl, {
      formats: ['markdown'],
      waitFor: 5000,
      timeout: 15000,
      onlyMainContent: false,
    });

    const md = result.markdown || '';

    if (md && md.length > 100) {
      const parsed = parseTransparencyPage(md);

      // If we found meaningful content, return it
      if (parsed.totalAds > 0 || parsed.advertiserName || parsed.creatives.length > 0 || md.length > 500) {
        return {
          advertisers: parsed.advertiserName ? [{ name: parsed.advertiserName, url: transparencyUrl }] : [],
          query,
          transparencyUrl,
          source: 'google_ads_transparency_center',
          dataRetrieved: true,
          pageContent: md.slice(0, 6000),
          parsedData: parsed,
        };
      }
    }

    log.info('Direct scrape returned minimal content, trying web search', { query, mdLength: md.length });
  } catch (e) {
    log.warn('Direct scrape failed, trying web search fallback', { error: e.message, query });
  }

  // --- Method 2: Firecrawl web search fallback ---
  try {
    log.info('Searching web for advertiser transparency page', { query });

    const searchResults = await firecrawl.search(
      `"${query}" site:adstransparency.google.com`,
      { limit: 5 }
    );

    const results = searchResults.results || [];

    // Find a direct advertiser page
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

    // Return whatever search found
    const relatedResults = results.slice(0, 3).map(r => ({
      title: r.title || '',
      url: r.url || '',
      description: r.description || '',
    }));

    return {
      advertisers: [],
      query,
      transparencyUrl,
      relatedResults,
      source: 'google_ads_transparency_center',
      dataRetrieved: false,
      message: `No advertiser page found for "${query}". Search manually: ${transparencyUrl}`,
    };
  } catch (e) {
    log.warn('Google Transparency web search also failed', { error: e.message, query });
    return {
      advertisers: [],
      query,
      transparencyUrl,
      source: 'google_ads_transparency_center',
      dataRetrieved: false,
      error: e.message,
      message: `Could not search Google Ads Transparency Center. View directly: ${transparencyUrl}`,
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
      waitFor: 5000,
      timeout: 15000,
      onlyMainContent: false,
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
      pageContent: md.slice(0, 6000),
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
  const region = opts.region || '';
  const fallbackUrl = buildTransparencyUrl(query, region);

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
      message: `Google Ads Transparency Center search failed. Try the Meta Ad Library instead, or visit directly: ${fallbackUrl}`,
    };
  }

  // If direct scrape already returned parsed data with creatives, use it
  if (searchResult.parsedData) {
    const pd = searchResult.parsedData;
    return {
      query,
      advertiserFound: true,
      advertiser: { name: pd.advertiserName || query, url: searchResult.transparencyUrl },
      advertisers: searchResult.advertisers,
      creatives: pd.creatives.slice(0, opts.limit || 10),
      totalCreatives: pd.totalAds,
      adFormats: pd.adFormats,
      dateRange: pd.dateRange,
      transparencyUrl: searchResult.transparencyUrl,
      pageContent: searchResult.pageContent,
      source: 'google_ads_transparency_center',
      dataRetrieved: true,
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
      message: searchResult.message || `No advertiser found for "${query}" on Google Ads Transparency Center. This does NOT mean they aren't running ads — the search may have failed. Check manually: ${fallbackUrl}`,
    };
  }

  const topAdvertiser = advertisers[0];

  // Step 2: Scrape the advertiser's page for creatives (only if we found via web search, not direct scrape)
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

    const dates = block.match(/(\w+\s+\d{1,2},?\s+\d{4})/g);
    if (dates && dates.length >= 1) creative.firstShown = dates[0];
    if (dates && dates.length >= 2) creative.lastShown = dates[1];

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
