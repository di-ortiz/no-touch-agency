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
 */
function buildTransparencyUrl(query, region) {
  const params = new URLSearchParams();

  const regionCode = (region && region.toLowerCase() !== 'anywhere') ? region.toUpperCase() : '';
  if (regionCode) params.set('region', regionCode);

  const isDomain = /^[a-zA-Z0-9]([a-zA-Z0-9-]*\.)+[a-zA-Z]{2,}$/.test(query.trim());
  if (isDomain) {
    params.set('domain', query.trim().toLowerCase());
  } else {
    const domainMatch = query.match(/([a-zA-Z0-9]([a-zA-Z0-9-]*\.)+[a-zA-Z]{2,})/);
    if (domainMatch) {
      params.set('domain', domainMatch[1].toLowerCase());
    } else {
      params.set('q', query.trim());
    }
  }

  return `${BASE_URL}/?${params.toString()}`;
}

/**
 * Scrape the Google Ads Transparency Center page and extract everything.
 *
 * Requests both markdown (for text/links) and screenshot (for visual snapshot).
 * Extracts ALL images found in the page as ad creatives.
 */
async function scrapeTransparencyPage(url) {
  const result = await firecrawl.scrape(url, {
    formats: ['markdown', 'screenshot'],
    waitFor: 8000, // Extra time for ad thumbnails to render
    timeout: 20000,
    onlyMainContent: false, // Need FULL page including ad grid
  });

  const md = result.markdown || '';
  const screenshot = result.screenshot || '';

  log.info('Transparency page scraped', {
    url,
    mdLength: md.length,
    hasScreenshot: !!screenshot,
  });

  return { markdown: md, screenshot };
}

/**
 * Search the Google Ads Transparency Center for an advertiser.
 *
 * Strategy:
 *   1. Build the correct transparency URL with domain= and region= params
 *   2. Scrape that URL directly with Firecrawl (renders JS, captures screenshot)
 *   3. Fall back to Firecrawl web search if direct scrape yields nothing
 *   4. Always return the correct URL so the user can check manually
 */
export async function searchAdvertiser(opts = {}) {
  if (!opts.query) throw new Error('Search query is required');

  const query = opts.query;
  const region = opts.region || '';
  const transparencyUrl = buildTransparencyUrl(query, region);

  if (!firecrawl.isConfigured()) {
    return {
      advertisers: [],
      query,
      transparencyUrl,
      source: 'google_ads_transparency_center',
      dataRetrieved: false,
      message: `Cannot access Google Ads Transparency Center programmatically. View directly: ${transparencyUrl}`,
    };
  }

  // --- Method 1: Direct scrape of the correct transparency URL ---
  try {
    log.info('Direct scraping Google Ads Transparency Center', { url: transparencyUrl, query });

    const { markdown: md, screenshot } = await scrapeTransparencyPage(transparencyUrl);

    if (md && md.length > 100) {
      const parsed = parseTransparencyPage(md);

      // Add screenshot as the first creative if available (full-page view of all ads)
      if (screenshot) {
        parsed.creatives.unshift({
          format: 'IMAGE',
          previewUrl: screenshot,
          label: `Google Ads Transparency — ${query}`,
          isScreenshot: true,
        });
      }

      if (parsed.totalAds > 0 || parsed.advertiserName || parsed.creatives.length > 0 || md.length > 500) {
        return {
          advertisers: parsed.advertiserName ? [{ name: parsed.advertiserName, url: transparencyUrl }] : [],
          query,
          transparencyUrl,
          source: 'google_ads_transparency_center',
          dataRetrieved: true,
          pageContent: md.slice(0, 10000),
          parsedData: parsed,
        };
      }
    }

    log.info('Direct scrape returned minimal content, trying web search', { query, mdLength: md?.length || 0 });
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

    const { markdown: md, screenshot } = await scrapeTransparencyPage(advertiserUrl);

    if (!md || md.length < 50) {
      return {
        creatives: screenshot ? [{ format: 'IMAGE', previewUrl: screenshot, label: 'Ads page screenshot' }] : [],
        totalFound: 0,
        transparencyUrl: advertiserUrl,
        dataRetrieved: !!screenshot,
        pageContent: md,
        message: screenshot ? '' : `Page rendered but no content extracted. View directly: ${advertiserUrl}`,
      };
    }

    const parsed = parseTransparencyPage(md);

    if (screenshot) {
      parsed.creatives.unshift({
        format: 'IMAGE',
        previewUrl: screenshot,
        label: 'Google Ads Transparency — full page',
        isScreenshot: true,
      });
    }

    return {
      creatives: parsed.creatives.slice(0, opts.limit || 20),
      totalFound: parsed.totalAds,
      adFormats: parsed.adFormats,
      dateRange: parsed.dateRange,
      advertiserName: parsed.advertiserName,
      transparencyUrl: advertiserUrl,
      pageContent: md.slice(0, 10000),
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

  // Step 1: Find the advertiser (also scrapes the page)
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

  // If direct scrape already returned parsed data, use it directly
  if (searchResult.parsedData) {
    const pd = searchResult.parsedData;
    return {
      query,
      advertiserFound: true,
      advertiser: { name: pd.advertiserName || query, url: searchResult.transparencyUrl },
      advertisers: searchResult.advertisers,
      creatives: pd.creatives.slice(0, opts.limit || 15),
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
      log.warn('Failed to fetch creatives', { error: e.message });
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
    message: `Found advertiser "${topAdvertiser.name}" but could not retrieve creatives. View their ads at: ${fallbackUrl}`,
  };
}

// --- Page Parser ---

/**
 * Parse the rendered Transparency Center page markdown.
 *
 * Aggressively extracts:
 *   - ALL image URLs (ad thumbnails, display creatives)
 *   - Text blocks that look like ad copy (headlines, descriptions)
 *   - Metadata (advertiser name, ad count, formats, dates)
 *
 * Returns raw pageContent so Claude can also interpret the full text.
 */
function parseTransparencyPage(markdown) {
  const result = {
    advertiserName: '',
    totalAds: 0,
    adFormats: [],
    dateRange: null,
    creatives: [],
    adTexts: [], // Text ad headlines/descriptions found on page
  };

  if (!markdown) return result;

  // --- Extract metadata ---

  const nameMatch = markdown.match(/^#\s+(.+)/m) ||
    markdown.match(/advertiser[:\s]+([^\n]+)/i);
  if (nameMatch) result.advertiserName = nameMatch[1].trim();

  const countMatch = markdown.match(/(\d[\d,]+)\s+ads?\b/i) ||
    markdown.match(/showing\s+(\d[\d,]+)/i);
  if (countMatch) result.totalAds = parseInt(countMatch[1].replace(/,/g, ''), 10);

  const formatMatches = markdown.matchAll(/(Text|Image|Video)\s*(?:ads?)?\s*[:(]\s*(\d[\d,]*)/gi);
  for (const m of formatMatches) {
    result.adFormats.push({
      format: m[1].toUpperCase(),
      count: parseInt(m[2].replace(/,/g, ''), 10),
    });
  }

  const dateMatch = markdown.match(
    /(?:from|since|between|date[s]?[:\s])\s*([\w\s,]+\d{4})\s*(?:to|[-–])\s*([\w\s,]+\d{4})/i
  );
  if (dateMatch) {
    result.dateRange = { from: dateMatch[1].trim(), to: dateMatch[2].trim() };
  }

  // --- Extract ALL images as ad creatives ---
  // The transparency center renders ads as thumbnail images.
  // Grab every image from the markdown — filter out obvious non-ad images.

  const seenUrls = new Set();

  // Markdown images: ![alt](url)
  const mdImageRegex = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  let match;
  while ((match = mdImageRegex.exec(markdown)) !== null) {
    const url = match[2];
    if (isAdImage(url) && !seenUrls.has(url)) {
      seenUrls.add(url);
      result.creatives.push({
        format: 'IMAGE',
        previewUrl: url,
        label: match[1] || 'Ad creative',
      });
    }
  }

  // Standalone image URLs in text (not already captured)
  const standaloneImgRegex = /(https?:\/\/[^\s"'<>()]+\.(?:png|jpg|jpeg|gif|webp)(?:[^\s"'<>()]*)?)/gi;
  while ((match = standaloneImgRegex.exec(markdown)) !== null) {
    const url = match[1];
    if (isAdImage(url) && !seenUrls.has(url)) {
      seenUrls.add(url);
      result.creatives.push({
        format: 'IMAGE',
        previewUrl: url,
        label: 'Ad creative',
      });
    }
  }

  // --- Extract text ad content ---
  // Look for blocks that look like Google text ads (headline + description patterns)

  // Pattern: repeated blocks with headline-like text followed by URL + description
  const textAdRegex = /(?:^|\n)([A-Z][^\n]{10,80})\n((?:https?:\/\/|www\.)[^\n]+)\n([^\n]{20,150})/gm;
  while ((match = textAdRegex.exec(markdown)) !== null) {
    result.adTexts.push({
      headline: match[1].trim(),
      displayUrl: match[2].trim(),
      description: match[3].trim(),
    });
  }

  // Simpler pattern: lines that look like ad headlines (short, title-case, no markdown)
  const headlineRegex = /(?:^|\n)(?:###?\s+)?([A-Z][A-Za-z0-9\s|—–\-:!?&,]{10,80})(?:\n|$)/gm;
  const potentialHeadlines = [];
  while ((match = headlineRegex.exec(markdown)) !== null) {
    const text = match[1].trim();
    // Skip obvious non-ad text
    if (!/google|transparency|center|filter|region|date range|about|privacy|terms/i.test(text)) {
      potentialHeadlines.push(text);
    }
  }
  // Only include if we found several (suggests they're ad headlines)
  if (potentialHeadlines.length >= 3) {
    for (const headline of potentialHeadlines.slice(0, 20)) {
      if (!result.adTexts.some(t => t.headline === headline)) {
        result.adTexts.push({ headline, displayUrl: '', description: '' });
      }
    }
  }

  return result;
}

/**
 * Check if a URL looks like an ad creative image (not a UI icon/logo).
 */
function isAdImage(url) {
  if (!url || !url.startsWith('http')) return false;
  // Skip obvious non-ad images
  const skipPatterns = [
    'favicon', 'logo', 'icon', 'sprite', 'arrow', 'chevron',
    'close', 'menu', 'search', 'spinner', 'loading',
    'google.com/images/branding', 'gstatic.com/images',
    'data:image', '1x1', 'pixel', 'tracking',
  ];
  const lower = url.toLowerCase();
  return !skipPatterns.some(p => lower.includes(p));
}

export default {
  searchAdvertiser,
  getAdvertiserCreatives,
  searchAndGetCreatives,
};
