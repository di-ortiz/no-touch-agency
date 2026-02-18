import axios from 'axios';
import logger from '../utils/logger.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';
import * as firecrawl from './firecrawl.js';

const log = logger.child({ platform: 'web-scraper' });

/**
 * Fetch a webpage and extract useful content.
 * Uses Firecrawl when available (better JS rendering, cleaner markdown),
 * falls back to direct HTML fetch + regex extraction.
 *
 * @param {string} url - URL to fetch
 * @param {object} opts
 * @param {boolean} opts.includeImages - Include image URLs (default: true)
 * @param {boolean} opts.includeLinks - Include link URLs (default: false)
 * @param {number} opts.maxLength - Max content length to return (default: 8000)
 * @returns {object} Extracted page content
 */
export async function fetchWebpage(url, opts = {}) {
  if (!url) throw new Error('URL is required');
  if (!url.startsWith('http')) url = `https://${url}`;

  // Try Firecrawl first (handles JS rendering, returns clean markdown)
  if (firecrawl.isConfigured()) {
    try {
      return await fetchWithFirecrawl(url, opts);
    } catch (e) {
      log.warn('Firecrawl scrape failed, falling back to direct fetch', { url, error: e.message });
    }
  }

  return fetchWithAxios(url, opts);
}

/**
 * Firecrawl-powered fetch: scrapes the URL and converts markdown back
 * to the structured format the rest of the codebase expects.
 */
async function fetchWithFirecrawl(url, opts = {}) {
  const formats = ['markdown'];
  if (opts.includeLinks) formats.push('links');

  const result = await firecrawl.scrape(url, { formats });
  const md = result.markdown || '';
  const meta = result.metadata || {};

  // Extract headings from markdown
  const h1s = [...md.matchAll(/^# (.+)$/gm)].map(m => m[1].trim()).slice(0, 5);
  const h2s = [...md.matchAll(/^## (.+)$/gm)].map(m => m[1].trim()).slice(0, 10);
  const h3s = [...md.matchAll(/^### (.+)$/gm)].map(m => m[1].trim()).slice(0, 10);

  // Extract images from markdown ![alt](url)
  let images = [];
  if (opts.includeImages !== false) {
    images = [...md.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].slice(0, 20).map(m => ({
      src: m[2],
      alt: m[1] || '',
    }));
  }

  // Extract links from Firecrawl response or markdown
  let links = [];
  if (opts.includeLinks) {
    if (result.links?.length) {
      links = result.links.slice(0, 30).map(l => (typeof l === 'string' ? { href: l, text: '' } : l));
    } else {
      links = [...md.matchAll(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g)].slice(0, 30).map(m => ({
        href: m[2],
        text: m[1]?.slice(0, 100) || '',
      }));
    }
  }

  // Convert markdown to plain text for bodyText
  let bodyText = md
    .replace(/^#{1,6}\s+/gm, '')          // Remove heading markers
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')  // Remove images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links → text only
    .replace(/[*_~`]/g, '')                // Remove formatting
    .replace(/\n{3,}/g, '\n\n')            // Collapse blank lines
    .trim();

  const maxLength = opts.maxLength || 8000;
  if (bodyText.length > maxLength) {
    bodyText = bodyText.slice(0, maxLength) + '... [truncated]';
  }

  return {
    url: result.url || url,
    statusCode: 200,
    title: meta.title || meta.ogTitle || h1s[0] || '',
    description: meta.description || meta.ogDescription || '',
    ogImage: meta.ogImage || '',
    canonical: meta.canonical || '',
    headings: { h1: h1s, h2: h2s, h3: h3s },
    bodyText,
    markdown: md,
    images,
    links,
    brandColors: [],  // Firecrawl doesn't extract CSS colors
    wordCount: bodyText.split(/\s+/).length,
    source: 'firecrawl',
  };
}

/**
 * Legacy axios-based fetch: directly fetches HTML and extracts content via regex.
 * Used as fallback when Firecrawl is not available.
 */
async function fetchWithAxios(url, opts = {}) {
  return retry(async () => {
    log.info('Fetching webpage (direct)', { url });

    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AgencyBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7',
      },
      maxRedirects: 5,
      validateStatus: (s) => s < 500,
    });

    const html = response.data;
    if (typeof html !== 'string') {
      return { url, error: 'Response was not HTML' };
    }

    // Extract meta info
    const title = extractFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const metaDescription = extractMeta(html, 'description');
    const ogTitle = extractMeta(html, 'og:title', 'property');
    const ogDescription = extractMeta(html, 'og:description', 'property');
    const ogImage = extractMeta(html, 'og:image', 'property');
    const canonical = extractFirst(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);

    // Extract headings
    const h1s = extractAll(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi).map(stripTags).filter(Boolean);
    const h2s = extractAll(html, /<h2[^>]*>([\s\S]*?)<\/h2>/gi).map(stripTags).filter(Boolean);
    const h3s = extractAll(html, /<h3[^>]*>([\s\S]*?)<\/h3>/gi).map(stripTags).filter(Boolean);

    // Extract images
    let images = [];
    if (opts.includeImages !== false) {
      const imgSrcRegex = /src=["']([^"']+)["']/i;
      const imgAltRegex = /alt=["']([^"']*?)["']/i;

      const imgTags = html.match(/<img[^>]+>/gi) || [];
      images = imgTags.slice(0, 20).map(tag => {
        const src = tag.match(imgSrcRegex)?.[1];
        const alt = tag.match(imgAltRegex)?.[1];
        if (!src || src.startsWith('data:')) return null;
        return {
          src: src.startsWith('http') ? src : new URL(src, url).href,
          alt: alt || '',
        };
      }).filter(Boolean);
    }

    // Extract links
    let links = [];
    if (opts.includeLinks) {
      const linkTags = html.match(/<a[^>]+href=["'][^"']+["'][^>]*>[^<]*<\/a>/gi) || [];
      links = linkTags.slice(0, 30).map(tag => {
        const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
        const text = stripTags(tag);
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return null;
        return {
          href: href.startsWith('http') ? href : new URL(href, url).href,
          text: text?.trim()?.slice(0, 100) || '',
        };
      }).filter(Boolean);
    }

    // Extract clean body text
    let bodyText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const maxLength = opts.maxLength || 8000;
    if (bodyText.length > maxLength) {
      bodyText = bodyText.slice(0, maxLength) + '... [truncated]';
    }

    const colors = extractColors(html);

    const result = {
      url,
      statusCode: response.status,
      title: stripTags(title) || ogTitle || '',
      description: metaDescription || ogDescription || '',
      ogImage: ogImage || '',
      canonical: canonical || '',
      headings: {
        h1: h1s.slice(0, 5),
        h2: h2s.slice(0, 10),
        h3: h3s.slice(0, 10),
      },
      bodyText,
      images: images.slice(0, 15),
      links: links.slice(0, 20),
      brandColors: colors.slice(0, 10),
      wordCount: bodyText.split(/\s+/).length,
      source: 'direct',
    };

    log.info('Webpage fetched', { url, wordCount: result.wordCount, images: images.length });
    return result;
  }, { retries: 2, label: 'Web fetch', shouldRetry: isRetryableHttpError });
}

/**
 * Fetch a webpage and analyze it for creative inspiration.
 * Returns a concise summary optimized for feeding into ad creative generation.
 */
export async function analyzeForCreativeInspiration(url) {
  const page = await fetchWebpage(url, {
    includeImages: true,
    includeLinks: false,
    maxLength: 6000,
  });

  return {
    url: page.url,
    brand: {
      name: page.title,
      tagline: page.description,
      heroImage: page.ogImage,
      colors: page.brandColors,
    },
    messaging: {
      headline: page.headings.h1?.[0] || page.title,
      subheadings: page.headings.h2,
      keyPhrases: page.headings.h3,
    },
    visuals: {
      heroImage: page.ogImage,
      images: page.images.slice(0, 10),
    },
    content: page.bodyText.slice(0, 4000),
    wordCount: page.wordCount,
  };
}

// --- Helpers ---

function extractFirst(html, regex) {
  const match = html.match(regex);
  return match ? match[1]?.trim() : '';
}

function extractAll(html, regex) {
  const matches = [];
  let m;
  const r = new RegExp(regex.source, regex.flags);
  while ((m = r.exec(html)) !== null) {
    matches.push(m[1] || m[0]);
  }
  return matches;
}

function extractMeta(html, name, attr = 'name') {
  const regex = new RegExp(
    `<meta[^>]+${attr}=["']${name}["'][^>]+content=["']([^"']*?)["']`,
    'i'
  );
  const match = html.match(regex);
  if (match) return match[1];

  // Try reversed order (content before name)
  const regex2 = new RegExp(
    `<meta[^>]+content=["']([^"']*?)["'][^>]+${attr}=["']${name}["']`,
    'i'
  );
  const match2 = html.match(regex2);
  return match2 ? match2[1] : '';
}

function stripTags(text) {
  if (!text) return '';
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function extractColors(html) {
  const colors = new Set();
  // Match hex colors
  const hexMatches = html.match(/#[0-9a-fA-F]{6}/g) || [];
  for (const c of hexMatches) {
    // Skip common non-brand colors
    if (!['#000000', '#ffffff', '#fff', '#333333', '#666666', '#999999', '#cccccc'].includes(c.toLowerCase())) {
      colors.add(c.toUpperCase());
    }
  }
  return [...colors].slice(0, 10);
}

export default { fetchWebpage, analyzeForCreativeInspiration };
