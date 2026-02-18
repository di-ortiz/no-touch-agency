import logger from '../utils/logger.js';
import { askClaude } from '../api/anthropic.js';
import * as dataforseo from '../api/dataforseo.js';
import * as pagespeed from '../api/pagespeed.js';
import * as webScraper from '../api/web-scraper.js';
import { getClient } from '../services/knowledge-base.js';
import { createClient as createWPClient } from '../api/wordpress.js';

const log = logger.child({ workflow: 'seo-engine' });

/**
 * Get a WordPress client for a given agency client.
 * Returns null if WordPress is not configured.
 */
export function getWordPressClient(client) {
  if (!client?.wordpress_url || !client?.wordpress_app_password) return null;
  return createWPClient({
    siteUrl: client.wordpress_url,
    username: client.wordpress_username || 'admin',
    appPassword: client.wordpress_app_password,
  });
}

// --- Full SEO Audit ---

/**
 * Run a comprehensive SEO audit combining PageSpeed, on-page SEO, meta analysis,
 * and WordPress site-level checks (if connected).
 */
export async function fullSEOAudit(clientNameOrId) {
  const client = getClient(clientNameOrId);
  if (!client?.website) throw new Error('Client has no website configured');

  const url = client.website.startsWith('http') ? client.website : `https://${client.website}`;

  // Run audits in parallel
  const [pageSpeed, onPage, webContent, domainOverview] = await Promise.allSettled([
    pagespeed.runPageSpeedAudit(url, { strategy: 'mobile' }),
    dataforseo.onPageAudit({ url }),
    webScraper.fetchWebpage(url, { includeImages: true, includeLinks: true }),
    dataforseo.getDomainOverview({ domain: new URL(url).hostname }),
  ]);

  const audit = {
    url,
    clientName: client.name,
    timestamp: new Date().toISOString(),
    performance: pageSpeed.status === 'fulfilled' ? pageSpeed.value : { error: pageSpeed.reason?.message },
    onPage: onPage.status === 'fulfilled' ? onPage.value : { error: onPage.reason?.message },
    content: webContent.status === 'fulfilled' ? {
      title: webContent.value.title,
      description: webContent.value.description,
      headings: webContent.value.headings,
      wordCount: webContent.value.wordCount,
      images: webContent.value.images?.length || 0,
      imagesWithoutAlt: webContent.value.images?.filter(i => !i.alt)?.length || 0,
    } : { error: webContent.reason?.message },
    domain: domainOverview.status === 'fulfilled' ? domainOverview.value : { error: domainOverview.reason?.message },
  };

  // WordPress-specific audit (if connected)
  const wp = getWordPressClient(client);
  if (wp) {
    try {
      const [siteInfo, allSEO] = await Promise.all([
        wp.validateConnection(),
        wp.getAllPagesSEO(),
      ]);
      audit.wordpress = {
        connected: siteInfo.connected,
        totalPages: allSEO.length,
        pagesWithoutSEOTitle: allSEO.filter(p => !p.seoTitle).length,
        pagesWithoutSEODescription: allSEO.filter(p => !p.seoDescription).length,
        pagesWithoutFocusKeyword: allSEO.filter(p => !p.focusKeyword).length,
        pages: allSEO.map(p => ({
          id: p.id,
          title: p.title,
          slug: p.slug,
          type: p.type,
          seoTitle: p.seoTitle || '(missing)',
          seoDescription: p.seoDescription || '(missing)',
          focusKeyword: p.focusKeyword || '(missing)',
        })),
      };
    } catch (e) {
      audit.wordpress = { connected: false, error: e.message };
    }
  }

  return audit;
}

// --- Meta Tag Generation ---

/**
 * Generate optimized meta tags (title + description) for a page.
 */
export async function generateMetaTags({ url, currentTitle, currentDescription, focusKeyword, businessDescription }) {
  const prompt = `Generate optimized SEO meta tags for this page.

URL: ${url}
Current title: ${currentTitle || '(none)'}
Current description: ${currentDescription || '(none)'}
Focus keyword: ${focusKeyword || '(not set)'}
Business: ${businessDescription || '(unknown)'}

Respond with ONLY valid JSON:
{
  "seoTitle": "Optimized title tag (50-60 chars, include focus keyword near start)",
  "seoDescription": "Optimized meta description (150-160 chars, include focus keyword, add CTA)",
  "focusKeyword": "Recommended focus keyword",
  "reasoning": "Brief explanation of why these are better"
}`;

  const response = await askClaude({
    systemPrompt: 'You are an SEO expert. Generate optimized meta tags. Output ONLY valid JSON, no other text.',
    userMessage: prompt,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 512,
    workflow: 'seo-meta-generation',
  });

  try {
    const match = response.text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { error: 'Failed to parse meta tag response' };
  } catch (e) {
    return { error: `Meta tag generation failed: ${e.message}` };
  }
}

// --- Blog Post Generation ---

/**
 * Generate a full SEO-optimized blog post.
 */
export async function generateBlogPost({ topic, keywords, tone, wordCount = 1200, clientName, businessDescription, targetAudience, language = 'en' }) {
  const langInstruction = language !== 'en'
    ? `\nIMPORTANT: Write the ENTIRE blog post in ${language}. Title, headings, body, meta — everything.\n`
    : '';

  const prompt = `Write a comprehensive, SEO-optimized blog post.

TOPIC: ${topic}
TARGET KEYWORDS: ${(keywords || []).join(', ')}
TONE: ${tone || 'professional, informative, engaging'}
WORD COUNT: ~${wordCount} words
BUSINESS: ${clientName || 'N/A'} — ${businessDescription || 'N/A'}
TARGET AUDIENCE: ${targetAudience || 'general'}
${langInstruction}
REQUIREMENTS:
- Include the primary keyword in the title, first paragraph, and 2-3 subheadings
- Use H2 and H3 headings for structure
- Include a compelling introduction and clear conclusion
- Write naturally — avoid keyword stuffing
- Include a CTA at the end
- Make it scannable with short paragraphs
- Output as HTML (not markdown)

Respond with ONLY valid JSON:
{
  "title": "Blog post title (include primary keyword)",
  "slug": "url-friendly-slug",
  "content": "<h2>...</h2><p>...</p>...(full HTML blog post)",
  "excerpt": "2-3 sentence excerpt for previews (include primary keyword)",
  "seoTitle": "SEO title tag (50-60 chars)",
  "seoDescription": "Meta description (150-160 chars)",
  "focusKeyword": "Primary focus keyword",
  "suggestedTags": ["tag1", "tag2", "tag3"],
  "suggestedCategory": "Category name",
  "imagePrompt": "DALL-E prompt for a featured image that matches this post"
}`;

  const response = await askClaude({
    systemPrompt: 'You are an expert SEO content writer and digital marketer. Write high-quality, engaging blog posts optimized for search engines. Output ONLY valid JSON.',
    userMessage: prompt,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 8192,
    workflow: 'seo-blog-generation',
  });

  try {
    const match = response.text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { error: 'Failed to parse blog post response' };
  } catch (e) {
    return { error: `Blog post generation failed: ${e.message}` };
  }
}

// --- SEO Improvement Recommendations ---

/**
 * Analyze current SEO state and generate prioritized recommendations.
 */
export async function generateSEORecommendations(auditResults) {
  const prompt = `Analyze this SEO audit and provide prioritized recommendations.

AUDIT DATA:
${JSON.stringify(auditResults, null, 2).slice(0, 6000)}

Provide 5-10 prioritized recommendations. Respond with ONLY valid JSON:
{
  "recommendations": [
    {
      "priority": "high|medium|low",
      "category": "meta_tags|performance|content|technical|backlinks",
      "title": "Short title",
      "description": "What to fix and why",
      "impact": "Expected impact on rankings/traffic",
      "effort": "quick_win|moderate|major"
    }
  ],
  "overallScore": 0-100,
  "summary": "2-3 sentence overview of the site's SEO health"
}`;

  const response = await askClaude({
    systemPrompt: 'You are a senior SEO consultant. Analyze audit data and provide actionable, prioritized recommendations. Output ONLY valid JSON.',
    userMessage: prompt,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 4096,
    workflow: 'seo-recommendations',
  });

  try {
    const match = response.text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { error: 'Failed to parse recommendations' };
  } catch (e) {
    return { error: `Recommendation generation failed: ${e.message}` };
  }
}

// --- Content Calendar Planning ---

/**
 * Generate a content calendar with blog post topics based on keyword gaps and competitor analysis.
 */
export async function planContentCalendar({ clientName, keywords, competitors, industry, monthsAhead = 3, postsPerWeek = 1 }) {
  const totalPosts = monthsAhead * 4 * postsPerWeek;

  const prompt = `Create an SEO-driven content calendar for a ${industry || 'business'} website.

CLIENT: ${clientName}
TARGET KEYWORDS: ${(keywords || []).join(', ')}
COMPETITORS: ${(competitors || []).join(', ')}
DURATION: ${monthsAhead} months (${totalPosts} total posts, ${postsPerWeek}/week)

For each post, generate:
- A title optimized for the target keyword
- The primary keyword to target
- Content type (how-to, listicle, guide, comparison, case study, news)
- Estimated search volume category (high/medium/low)
- Suggested publish date (starting from next Monday)

Respond with ONLY valid JSON:
{
  "calendar": [
    {
      "week": 1,
      "publishDate": "YYYY-MM-DD",
      "title": "Blog post title",
      "primaryKeyword": "target keyword",
      "contentType": "how-to",
      "searchVolume": "high",
      "brief": "2-sentence content brief"
    }
  ],
  "strategy": "2-3 sentence explanation of the content strategy"
}`;

  const response = await askClaude({
    systemPrompt: 'You are a content strategist specializing in SEO. Create data-driven content calendars that target keyword gaps and drive organic traffic. Output ONLY valid JSON.',
    userMessage: prompt,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 8192,
    workflow: 'seo-content-calendar',
  });

  try {
    const match = response.text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { error: 'Failed to parse content calendar' };
  } catch (e) {
    return { error: `Content calendar generation failed: ${e.message}` };
  }
}

// --- Schema Markup Generation ---

/**
 * Generate JSON-LD schema markup for a page.
 */
export async function generateSchemaMarkup({ pageType, url, businessName, businessDescription, data = {} }) {
  const prompt = `Generate JSON-LD schema markup for this page.

PAGE TYPE: ${pageType} (e.g., LocalBusiness, Article, Product, Service, FAQ, HowTo)
URL: ${url}
BUSINESS: ${businessName} — ${businessDescription || ''}
ADDITIONAL DATA: ${JSON.stringify(data)}

Respond with ONLY the valid JSON-LD script tag content (the JSON object, not the script tag itself).`;

  const response = await askClaude({
    systemPrompt: 'You are a structured data expert. Generate valid JSON-LD schema markup following schema.org specifications. Output ONLY the JSON-LD object.',
    userMessage: prompt,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 2048,
    workflow: 'seo-schema-generation',
  });

  try {
    const match = response.text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { error: 'Failed to parse schema markup' };
  } catch (e) {
    return { error: `Schema generation failed: ${e.message}` };
  }
}

export default {
  getWordPressClient,
  fullSEOAudit,
  generateMetaTags,
  generateBlogPost,
  generateSEORecommendations,
  planContentCalendar,
  generateSchemaMarkup,
};
