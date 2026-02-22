import axios from 'axios';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import config from '../config.js';

const log = logger.child({ platform: 'firecrawl' });

const BASE_URL = 'https://api.firecrawl.dev/v2';

function getHeaders() {
  return {
    'Authorization': `Bearer ${config.FIRECRAWL_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

function isConfigured() {
  return !!config.FIRECRAWL_API_KEY;
}

/**
 * Scrape a single URL and return clean markdown content.
 * @param {string} url - URL to scrape
 * @param {object} opts
 * @param {string[]} opts.formats - Output formats: 'markdown', 'html', 'links', 'screenshot' (default: ['markdown'])
 * @param {boolean} opts.onlyMainContent - Extract only main content, exclude nav/footer (default: true)
 * @param {number} opts.waitFor - Wait ms for JS to render (default: 0)
 * @param {number} opts.timeout - Timeout in ms (default: 30000)
 * @returns {object} { url, markdown, html, metadata, links }
 */
export async function scrape(url, opts = {}) {
  if (!isConfigured()) throw new Error('Firecrawl API key not configured');
  if (!url) throw new Error('URL is required');
  if (!url.startsWith('http')) url = `https://${url}`;

  return rateLimited('firecrawl', async () => {
    log.info('Firecrawl scrape', { url });

    const body = {
      url,
      formats: opts.formats || ['markdown'],
      onlyMainContent: opts.onlyMainContent !== false,
    };
    if (opts.waitFor) body.waitFor = opts.waitFor;
    if (opts.timeout) body.timeout = opts.timeout;

    const response = await axios.post(`${BASE_URL}/scrape`, body, {
      headers: getHeaders(),
      timeout: opts.timeout || 30000,
    });

    const data = response.data?.data || response.data;

    log.info('Firecrawl scrape complete', {
      url,
      contentLength: data?.markdown?.length || 0,
      linksCount: data?.links?.length || 0,
    });

    return {
      url: data.url || url,
      markdown: data.markdown || '',
      html: data.html || '',
      screenshot: data.screenshot || '',
      metadata: data.metadata || {},
      links: data.links || [],
    };
  });
}

/**
 * Crawl an entire website starting from a URL.
 * Starts an async crawl job and polls until complete.
 * @param {string} url - Starting URL to crawl
 * @param {object} opts
 * @param {number} opts.limit - Max pages to crawl (default: 10)
 * @param {number} opts.maxDepth - Max link depth (default: 2)
 * @param {string[]} opts.includePaths - Only crawl these path patterns (e.g. ['/blog/*'])
 * @param {string[]} opts.excludePaths - Skip these path patterns (e.g. ['/admin/*'])
 * @param {number} opts.pollInterval - Poll interval in ms (default: 3000)
 * @param {number} opts.maxWait - Max wait time in ms (default: 120000)
 * @returns {object} { pages: [{ url, markdown, metadata }], totalPages }
 */
export async function crawl(url, opts = {}) {
  if (!isConfigured()) throw new Error('Firecrawl API key not configured');
  if (!url) throw new Error('URL is required');
  if (!url.startsWith('http')) url = `https://${url}`;

  return rateLimited('firecrawl', async () => {
    log.info('Firecrawl crawl started', { url, limit: opts.limit || 10 });

    const body = {
      url,
      limit: opts.limit || 10,
      maxDepth: opts.maxDepth || 2,
      scrapeOptions: {
        formats: ['markdown'],
        onlyMainContent: true,
      },
    };
    if (opts.includePaths) body.includePaths = opts.includePaths;
    if (opts.excludePaths) body.excludePaths = opts.excludePaths;

    // Start the crawl job
    const startResponse = await axios.post(`${BASE_URL}/crawl`, body, {
      headers: getHeaders(),
      timeout: 30000,
    });

    const jobId = startResponse.data?.id;
    if (!jobId) {
      throw new Error('Firecrawl crawl did not return a job ID');
    }

    log.info('Firecrawl crawl job created', { jobId });

    // Poll for completion
    const pollInterval = opts.pollInterval || 3000;
    const maxWait = opts.maxWait || 120000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));

      const statusResponse = await axios.get(`${BASE_URL}/crawl/${jobId}`, {
        headers: getHeaders(),
        timeout: 15000,
      });

      const status = statusResponse.data?.status;
      if (status === 'completed') {
        const pages = (statusResponse.data?.data || []).map(page => ({
          url: page.url || page.metadata?.url,
          markdown: page.markdown || '',
          metadata: page.metadata || {},
        }));

        log.info('Firecrawl crawl complete', { jobId, pagesFound: pages.length });

        return {
          pages,
          totalPages: pages.length,
        };
      }

      if (status === 'failed') {
        throw new Error(`Firecrawl crawl failed: ${statusResponse.data?.error || 'unknown error'}`);
      }

      // Still in progress — keep polling
      log.debug('Firecrawl crawl in progress', { jobId, status, elapsed: Date.now() - startTime });
    }

    throw new Error(`Firecrawl crawl timed out after ${maxWait / 1000}s`);
  });
}

/**
 * Map all URLs on a domain without scraping content.
 * Fast way to discover site structure.
 * @param {string} url - Website URL to map
 * @param {object} opts
 * @param {number} opts.limit - Max URLs to return (default: 100)
 * @param {string} opts.search - Optional search query to filter URLs
 * @returns {object} { urls: string[], totalUrls: number }
 */
export async function map(url, opts = {}) {
  if (!isConfigured()) throw new Error('Firecrawl API key not configured');
  if (!url) throw new Error('URL is required');
  if (!url.startsWith('http')) url = `https://${url}`;

  return rateLimited('firecrawl', async () => {
    log.info('Firecrawl map', { url });

    const body = { url };
    if (opts.limit) body.limit = opts.limit;
    if (opts.search) body.search = opts.search;

    const response = await axios.post(`${BASE_URL}/map`, body, {
      headers: getHeaders(),
      timeout: 30000,
    });

    const urls = response.data?.links || [];

    log.info('Firecrawl map complete', { url, urlsFound: urls.length });

    return {
      urls,
      totalUrls: urls.length,
    };
  });
}

/**
 * Search the web and return scraped results as markdown.
 * Like Google search but returns full page content.
 * @param {string} query - Search query
 * @param {object} opts
 * @param {number} opts.limit - Max results (default: 5)
 * @param {string} opts.lang - Language code (default: 'en')
 * @param {string} opts.country - Country code (default: 'us')
 * @returns {object} { results: [{ url, title, description, markdown }], totalResults }
 */
export async function search(query, opts = {}) {
  if (!isConfigured()) throw new Error('Firecrawl API key not configured');
  if (!query) throw new Error('Search query is required');

  return rateLimited('firecrawl', async () => {
    log.info('Firecrawl search', { query });

    const body = {
      query,
      limit: opts.limit || 5,
      lang: opts.lang || 'en',
      country: opts.country || 'us',
      scrapeOptions: {
        formats: ['markdown'],
        onlyMainContent: true,
      },
    };

    const response = await axios.post(`${BASE_URL}/search`, body, {
      headers: getHeaders(),
      timeout: 30000,
    });

    const results = (response.data?.data || []).map(r => ({
      url: r.url,
      title: r.metadata?.title || r.title || '',
      description: r.metadata?.description || r.description || '',
      markdown: r.markdown || '',
    }));

    log.info('Firecrawl search complete', { query, resultsCount: results.length });

    return {
      results,
      totalResults: results.length,
    };
  });
}

export default { scrape, crawl, map, search, isConfigured };
