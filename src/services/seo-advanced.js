import logger from '../utils/logger.js';
import { askClaude } from '../api/anthropic.js';
import * as webScraper from '../api/web-scraper.js';
import * as pagespeed from '../api/pagespeed.js';

const log = logger.child({ service: 'seo-advanced' });

// ============================================================
// E-E-A-T Content Quality Assessment
// ============================================================

/**
 * Analyze a page for E-E-A-T signals (Experience, Expertise, Authoritativeness, Trustworthiness).
 * Based on Google Quality Rater Guidelines (Sept 2025 + Dec 2025 Core Update).
 *
 * Scoring weights: Experience 20%, Expertise 25%, Authoritativeness 25%, Trustworthiness 30%.
 * Dec 2025 update: E-E-A-T now applies to ALL competitive queries, not just YMYL.
 */
export async function analyzeEEAT(url) {
  if (!url) throw new Error('URL is required');
  if (!url.startsWith('http')) url = `https://${url}`;

  log.info('Starting E-E-A-T analysis', { url });

  const page = await webScraper.fetchWebpage(url, { includeImages: true, includeLinks: true, maxLength: 8000 });

  const prompt = `Analyze this webpage for E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness) signals per Google Quality Rater Guidelines (September 2025 + December 2025 Core Update).

URL: ${url}
TITLE: ${page.title}
DESCRIPTION: ${page.description}
HEADINGS H1: ${(page.headings?.h1 || []).join(', ')}
HEADINGS H2: ${(page.headings?.h2 || []).join(', ')}
WORD COUNT: ${page.wordCount}
IMAGES: ${page.images?.length || 0} (with alt: ${page.images?.filter(i => i.alt).length || 0})
LINKS: Internal ${page.links?.filter(l => l.href?.includes(new URL(url).hostname)).length || 0}, External ${page.links?.filter(l => !l.href?.includes(new URL(url).hostname)).length || 0}
CONTENT PREVIEW:
${page.bodyText?.slice(0, 5000) || ''}

SCORING CRITERIA:
- Experience (20%): First-hand experience signals, original photos/screenshots, case studies, process documentation, before/after results
- Expertise (25%): Author credentials, technical accuracy, claims supported by evidence, byline with credentials
- Authoritativeness (25%): Site recognized as authority, external citations, industry recognition
- Trustworthiness (30%): Contact info, privacy policy, HTTPS, transparency, customer reviews, corrections history

ALSO ASSESS:
- AI content quality (generic phrasing = low quality; original insight = acceptable)
- AI Citation Readiness: Does content have clear, structured answers suitable for AI search engines?
- Optimal answer passages for AI citation (134-167 words per passage)
- Content freshness indicators

Respond with ONLY valid JSON:
{
  "overallScore": 0-100,
  "experience": { "score": 0-25, "signals": ["signal1"], "missing": ["gap1"] },
  "expertise": { "score": 0-25, "signals": ["signal1"], "missing": ["gap1"] },
  "authoritativeness": { "score": 0-25, "signals": ["signal1"], "missing": ["gap1"] },
  "trustworthiness": { "score": 0-30, "signals": ["signal1"], "missing": ["gap1"] },
  "aiContentAssessment": "genuine|suspected_ai_low_quality|acceptable_ai",
  "aiCitationReadiness": 0-100,
  "contentFreshness": "fresh|needs_update|stale",
  "topImprovements": ["improvement1", "improvement2", "improvement3"],
  "summary": "2-3 sentence E-E-A-T assessment"
}`;

  const response = await askClaude({
    systemPrompt: 'You are a senior SEO consultant specializing in E-E-A-T analysis per Google Quality Rater Guidelines. Analyze webpages for trust and quality signals. Output ONLY valid JSON.',
    userMessage: prompt,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 2048,
    workflow: 'seo-eeat-analysis',
  });

  try {
    const match = response.text.match(/\{[\s\S]*\}/);
    const result = match ? JSON.parse(match[0]) : null;
    if (!result) throw new Error('Failed to parse E-E-A-T response');
    result.url = url;
    result.pageTitle = page.title;
    result.wordCount = page.wordCount;
    log.info('E-E-A-T analysis complete', { url, score: result.overallScore });
    return result;
  } catch (e) {
    log.error('E-E-A-T analysis failed', { url, error: e.message });
    throw new Error(`E-E-A-T analysis failed: ${e.message}`);
  }
}

// ============================================================
// GEO / AI Search Readiness Analysis
// ============================================================

/**
 * Analyze a page/domain for AI search optimization (Generative Engine Optimization).
 * Assesses visibility for Google AI Overviews, ChatGPT, Perplexity.
 *
 * Key insight: Brand mentions correlate 3x more strongly with AI visibility than backlinks.
 * Multi-modal content sees 156% higher selection rates.
 * Only 11% of domains cited by both ChatGPT and Google AI Overviews for the same query.
 */
export async function analyzeAISearchReadiness(url) {
  if (!url) throw new Error('URL is required');
  if (!url.startsWith('http')) url = `https://${url}`;

  log.info('Starting AI search readiness analysis', { url });

  const hostname = new URL(url).hostname;

  // Fetch main page + check robots.txt for AI crawlers
  const [pageResult, robotsResult] = await Promise.allSettled([
    webScraper.fetchWebpage(url, { includeImages: true, includeLinks: true, maxLength: 6000 }),
    webScraper.fetchWebpage(`https://${hostname}/robots.txt`, { maxLength: 3000 }),
  ]);

  const page = pageResult.status === 'fulfilled' ? pageResult.value : null;
  const robotsTxt = robotsResult.status === 'fulfilled' ? robotsResult.value?.bodyText?.slice(0, 2000) : 'Could not fetch';

  if (!page) throw new Error(`Could not fetch ${url}`);

  // Check for llms.txt
  let llmsTxt = null;
  try {
    const llmsResult = await webScraper.fetchWebpage(`https://${hostname}/llms.txt`, { maxLength: 1000 });
    llmsTxt = llmsResult?.bodyText?.slice(0, 500) || null;
  } catch { /* optional */ }

  const prompt = `Analyze this website for AI Search Readiness (Generative Engine Optimization / GEO).

URL: ${url}
TITLE: ${page.title}
DESCRIPTION: ${page.description}
HEADINGS: ${JSON.stringify(page.headings)}
WORD COUNT: ${page.wordCount}
IMAGES: ${page.images?.length || 0}
EXTERNAL LINKS: ${page.links?.filter(l => !l.href?.includes(hostname)).length || 0}

ROBOTS.TXT:
${robotsTxt}

LLMS.TXT: ${llmsTxt ? 'Present: ' + llmsTxt : 'Not found'}

CONTENT PREVIEW:
${page.bodyText?.slice(0, 4000) || ''}

AI CRAWLERS TO CHECK IN ROBOTS.TXT:
- GPTBot (OpenAI training) — blocking does NOT prevent ChatGPT browsing citations
- OAI-SearchBot (OpenAI search)
- ChatGPT-User (ChatGPT browsing)
- ClaudeBot (Anthropic training)
- PerplexityBot (Perplexity search)
- Bytespider (ByteDance/TikTok)
- Google-Extended (Gemini training) — blocking does NOT affect Google Search or AI Overviews
- CCBot (Common Crawl)

SCORING CRITERIA (GEO Readiness Score /100):
- Citability Score (25%): Clear, structured answers in 134-167 word passages; question-based headings; definitions
- Structural Readability (20%): Logical heading hierarchy; scannable sections; bullet lists; ToC
- Multi-Modal Content (15%): Images, videos, infographics (156% higher AI selection rate)
- Authority & Brand Signals (20%): External references, author attribution, schema markup, brand mentions
- Technical Accessibility (20%): AI crawler access via robots.txt, SSR vs CSR, llms.txt

KEY FACTS:
- 92% of AI Overview citations come from top-10 ranking pages
- Brand mentions correlate 3x more strongly with AI visibility than backlinks
- AI crawlers do NOT execute JavaScript — SSR is critical
- Google AI Mode (May 2025): zero organic blue links in some queries

Respond with ONLY valid JSON:
{
  "geoScore": 0-100,
  "citabilityScore": 0-25,
  "structuralReadability": 0-20,
  "multiModalContent": 0-15,
  "authoritySignals": 0-20,
  "technicalAccessibility": 0-20,
  "crawlerAccess": {
    "GPTBot": "allowed|blocked|not_specified",
    "ChatGPT-User": "allowed|blocked|not_specified",
    "ClaudeBot": "allowed|blocked|not_specified",
    "PerplexityBot": "allowed|blocked|not_specified",
    "Google-Extended": "allowed|blocked|not_specified",
    "Bytespider": "allowed|blocked|not_specified"
  },
  "hasLlmsTxt": false,
  "isSSR": true,
  "hasSchemaMarkup": false,
  "hasAuthorAttribution": false,
  "platformReadiness": {
    "googleAIOverviews": "high|medium|low",
    "chatGPT": "high|medium|low",
    "perplexity": "high|medium|low"
  },
  "quickWins": ["win1", "win2", "win3"],
  "topImprovements": ["improvement1", "improvement2", "improvement3"],
  "summary": "2-3 sentence GEO assessment"
}`;

  const response = await askClaude({
    systemPrompt: 'You are a Generative Engine Optimization (GEO) specialist. Analyze websites for AI search readiness across Google AI Overviews, ChatGPT, and Perplexity. Output ONLY valid JSON.',
    userMessage: prompt,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 2048,
    workflow: 'seo-geo-analysis',
  });

  try {
    const match = response.text.match(/\{[\s\S]*\}/);
    const result = match ? JSON.parse(match[0]) : null;
    if (!result) throw new Error('Failed to parse GEO response');
    result.url = url;
    result.pageTitle = page.title;
    log.info('AI search readiness analysis complete', { url, score: result.geoScore });
    return result;
  } catch (e) {
    log.error('AI search readiness analysis failed', { url, error: e.message });
    throw new Error(`AI search readiness analysis failed: ${e.message}`);
  }
}

// ============================================================
// Technical SEO Audit (9 categories)
// ============================================================

/**
 * Comprehensive technical SEO audit covering:
 * 1. Crawlability (robots.txt, sitemaps, crawl depth)
 * 2. Indexability (canonicals, duplicates, thin content)
 * 3. Security (HTTPS, security headers)
 * 4. URL Structure (clean URLs, redirects)
 * 5. Mobile Optimization (responsive, viewport, touch targets)
 * 6. Core Web Vitals (LCP <2.5s, INP <200ms, CLS <0.1)
 * 7. Structured Data (JSON-LD validation)
 * 8. JavaScript Rendering (CSR vs SSR)
 * 9. AI Crawler Management
 */
export async function technicalSEOAudit(url) {
  if (!url) throw new Error('URL is required');
  if (!url.startsWith('http')) url = `https://${url}`;

  log.info('Starting technical SEO audit', { url });
  const hostname = new URL(url).hostname;

  // Run all checks in parallel
  const [pageResult, robotsResult, pageSpeedResult, sitemapResult] = await Promise.allSettled([
    webScraper.fetchWebpage(url, { includeImages: true, includeLinks: true, maxLength: 6000 }),
    webScraper.fetchWebpage(`https://${hostname}/robots.txt`, { maxLength: 3000 }),
    pagespeed.runPageSpeedAudit(url, { strategy: 'mobile' }),
    webScraper.fetchWebpage(`https://${hostname}/sitemap.xml`, { maxLength: 2000 }),
  ]);

  const page = pageResult.status === 'fulfilled' ? pageResult.value : null;
  const robotsTxt = robotsResult.status === 'fulfilled' ? robotsResult.value?.bodyText?.slice(0, 2000) : null;
  const pageSpeedData = pageSpeedResult.status === 'fulfilled' ? pageSpeedResult.value : null;
  const sitemapData = sitemapResult.status === 'fulfilled' ? sitemapResult.value?.bodyText?.slice(0, 1000) : null;

  if (!page) throw new Error(`Could not fetch ${url}`);

  const prompt = `Perform a comprehensive technical SEO audit across 9 categories.

URL: ${url}
STATUS CODE: ${page.statusCode || 'unknown'}
TITLE: ${page.title}
DESCRIPTION: ${page.description}
CANONICAL: ${page.canonical || 'not set'}
HEADINGS: ${JSON.stringify(page.headings)}
WORD COUNT: ${page.wordCount}
IMAGES: ${page.images?.length || 0} (with alt: ${page.images?.filter(i => i.alt).length || 0}, without alt: ${page.images?.filter(i => !i.alt).length || 0})
INTERNAL LINKS: ${page.links?.filter(l => l.href?.includes(hostname)).length || 0}
EXTERNAL LINKS: ${page.links?.filter(l => !l.href?.includes(hostname)).length || 0}
BRAND COLORS: ${page.brandColors?.join(', ') || 'none detected'}

ROBOTS.TXT: ${robotsTxt || 'Not found / could not fetch'}
SITEMAP: ${sitemapData ? 'Found' : 'Not found / could not fetch'}
HTTPS: ${url.startsWith('https') ? 'Yes' : 'No'}

PAGESPEED DATA: ${pageSpeedData ? JSON.stringify({
    scores: pageSpeedData.scores,
    coreWebVitals: pageSpeedData.coreWebVitals,
    labMetrics: pageSpeedData.labMetrics,
  }) : 'Not available'}

CONTENT PREVIEW (first 2000 chars):
${page.bodyText?.slice(0, 2000) || ''}

AUDIT ACROSS 9 CATEGORIES (score each /100):
1. Crawlability: robots.txt present, XML sitemap accessible, crawl depth, AI crawler management
2. Indexability: canonical tags, potential duplicates, thin content (<300 words)
3. Security: HTTPS, recommend CSP/HSTS/X-Frame-Options/X-Content-Type-Options
4. URL Structure: clean URLs, logical hierarchy, URL length <100 chars
5. Mobile: responsive indicators, viewport meta, font size adequacy
6. Core Web Vitals: LCP (good <=2.5s), INP (good <=200ms), CLS (good <=0.1)
7. Structured Data: detect JSON-LD/Microdata/RDFa in content, validate types
8. JavaScript Rendering: CSR vs SSR indicators, JS-heavy framework detection
9. AI Crawler Access: GPTBot, ClaudeBot, PerplexityBot, Bytespider status in robots.txt

Respond with ONLY valid JSON:
{
  "technicalScore": 0-100,
  "categories": {
    "crawlability": { "score": 0-100, "issues": [], "recommendations": [] },
    "indexability": { "score": 0-100, "issues": [], "recommendations": [] },
    "security": { "score": 0-100, "issues": [], "recommendations": [] },
    "urlStructure": { "score": 0-100, "issues": [], "recommendations": [] },
    "mobile": { "score": 0-100, "issues": [], "recommendations": [] },
    "coreWebVitals": { "score": 0-100, "issues": [], "recommendations": [] },
    "structuredData": { "score": 0-100, "issues": [], "recommendations": [] },
    "jsRendering": { "score": 0-100, "issues": [], "recommendations": [] },
    "aiCrawlerAccess": { "score": 0-100, "issues": [], "recommendations": [] }
  },
  "criticalIssues": ["issue1"],
  "highPriorityFixes": ["fix1"],
  "summary": "2-3 sentence technical SEO assessment"
}`;

  const response = await askClaude({
    systemPrompt: 'You are a technical SEO expert. Perform comprehensive audits covering crawlability, indexability, security, Core Web Vitals, structured data, JavaScript rendering, and AI crawler access. Use current best practices (February 2026). Output ONLY valid JSON.',
    userMessage: prompt,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 4096,
    workflow: 'seo-technical-audit',
  });

  try {
    const match = response.text.match(/\{[\s\S]*\}/);
    const result = match ? JSON.parse(match[0]) : null;
    if (!result) throw new Error('Failed to parse technical audit response');
    result.url = url;
    result.pageTitle = page.title;
    log.info('Technical SEO audit complete', { url, score: result.technicalScore });
    return result;
  } catch (e) {
    log.error('Technical SEO audit failed', { url, error: e.message });
    throw new Error(`Technical SEO audit failed: ${e.message}`);
  }
}

// ============================================================
// Image SEO Analysis
// ============================================================

/**
 * Analyze a page's images for SEO optimization.
 * Checks: alt text, file sizes, formats, lazy loading, responsive images, CLS prevention.
 */
export async function analyzeImageSEO(url) {
  if (!url) throw new Error('URL is required');
  if (!url.startsWith('http')) url = `https://${url}`;

  log.info('Starting image SEO analysis', { url });

  const page = await webScraper.fetchWebpage(url, { includeImages: true, maxLength: 4000 });

  const prompt = `Analyze this webpage's images for SEO optimization.

URL: ${url}
TOTAL IMAGES: ${page.images?.length || 0}
IMAGES DATA: ${JSON.stringify(page.images?.slice(0, 20) || [])}

CONTENT PREVIEW:
${page.bodyText?.slice(0, 1500) || ''}

ANALYZE EACH IMAGE FOR:
1. Alt text: Present? Descriptive (10-125 chars)? Contains natural keywords? Decorative images should use alt="" or role="presentation"
2. File format: Check extension for WebP/AVIF (recommended), JPEG/PNG (acceptable), BMP/GIF (outdated)
3. File naming: Descriptive, hyphenated, lowercase, includes keywords?
4. File size estimation from URL patterns (CDN, image service parameters)
5. Responsive images: Look for srcset/sizes indicators
6. Lazy loading indicators
7. CDN usage: Is image served from a CDN?

FILE SIZE THRESHOLDS:
- Thumbnails: Good <50KB, Warn >100KB, Critical >200KB
- Content images: Good <100KB, Warn >200KB, Critical >500KB
- Hero/banner: Good <200KB, Warn >300KB, Critical >700KB

RECOMMENDATIONS:
- fetchpriority="high" on LCP/hero images
- decoding="async" on non-LCP images
- width/height attributes or aspect-ratio CSS on all images (CLS prevention)
- Use <picture> element: AVIF > WebP > JPEG fallback

Respond with ONLY valid JSON:
{
  "imageScore": 0-100,
  "totalImages": 0,
  "missingAltText": 0,
  "poorAltText": 0,
  "estimatedOversized": 0,
  "outdatedFormats": 0,
  "missingDimensions": 0,
  "notLazyLoaded": 0,
  "usingCDN": false,
  "issues": [
    { "priority": "critical|high|medium|low", "image": "filename or src", "issue": "description", "fix": "recommendation" }
  ],
  "generalRecommendations": ["rec1", "rec2", "rec3"],
  "summary": "2-3 sentence image SEO assessment"
}`;

  const response = await askClaude({
    systemPrompt: 'You are an image SEO and web performance specialist. Analyze webpage images for alt text quality, file optimization, format choices, lazy loading, and CLS prevention. Output ONLY valid JSON.',
    userMessage: prompt,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 2048,
    workflow: 'seo-image-analysis',
  });

  try {
    const match = response.text.match(/\{[\s\S]*\}/);
    const result = match ? JSON.parse(match[0]) : null;
    if (!result) throw new Error('Failed to parse image SEO response');
    result.url = url;
    result.pageTitle = page.title;
    log.info('Image SEO analysis complete', { url, score: result.imageScore });
    return result;
  } catch (e) {
    log.error('Image SEO analysis failed', { url, error: e.message });
    throw new Error(`Image SEO analysis failed: ${e.message}`);
  }
}

// ============================================================
// Schema Markup Detection & Validation
// ============================================================

/**
 * Detect, validate, and recommend schema markup for a page.
 * Checks for JSON-LD, Microdata, RDFa; validates against Google supported types.
 */
export async function analyzeSchemaMarkup(url) {
  if (!url) throw new Error('URL is required');
  if (!url.startsWith('http')) url = `https://${url}`;

  log.info('Starting schema markup analysis', { url });

  // Fetch with full HTML to detect schema in source
  const page = await webScraper.fetchWebpage(url, { includeImages: false, includeLinks: false, maxLength: 8000 });

  const prompt = `Analyze this webpage for schema markup (structured data).

URL: ${url}
TITLE: ${page.title}
DESCRIPTION: ${page.description}
HEADINGS: ${JSON.stringify(page.headings)}
OG IMAGE: ${page.ogImage || 'not set'}

CONTENT PREVIEW:
${page.bodyText?.slice(0, 4000) || ''}

${page.markdown ? `MARKDOWN/RAW CONTENT (may contain JSON-LD):
${page.markdown?.slice(0, 3000) || ''}` : ''}

ANALYZE:
1. Detect existing schema markup (JSON-LD preferred, also Microdata, RDFa)
2. Validate detected types against Google's supported types (2026)
3. Check for required properties
4. Identify missing schema opportunities

CURRENT GOOGLE SUPPORTED TYPES (Active - recommend freely):
Organization, LocalBusiness, SoftwareApplication, Product, Offer, Service, Article, BlogPosting, NewsArticle, Review, AggregateRating, BreadcrumbList, WebSite, WebPage, Person, VideoObject, Event, JobPosting, Course, ProfilePage, DiscussionForumPosting, ProductGroup

RESTRICTED (only for specific sites):
- FAQPage: Government/healthcare authority sites ONLY (since Aug 2023)

DEPRECATED (never recommend):
- HowTo (Sept 2023), SpecialAnnouncement (July 2025)

KEY FACT: Content with proper schema has ~2.5x higher chance of appearing in AI-generated answers.

Respond with ONLY valid JSON:
{
  "schemaScore": 0-100,
  "detected": [
    { "type": "Organization", "format": "JSON-LD", "valid": true, "issues": [] }
  ],
  "detectedCount": 0,
  "format": "JSON-LD|Microdata|RDFa|none",
  "missingOpportunities": [
    { "type": "BreadcrumbList", "reason": "Page has clear hierarchy", "priority": "high", "impact": "Rich results in search" }
  ],
  "deprecatedUsed": [],
  "recommendations": ["rec1", "rec2"],
  "suggestedSchema": null,
  "summary": "2-3 sentence schema assessment"
}`;

  const response = await askClaude({
    systemPrompt: 'You are a structured data and schema.org expert. Detect, validate, and recommend schema markup for webpages. Use current Google standards (2026). Output ONLY valid JSON.',
    userMessage: prompt,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 2048,
    workflow: 'seo-schema-analysis',
  });

  try {
    const match = response.text.match(/\{[\s\S]*\}/);
    const result = match ? JSON.parse(match[0]) : null;
    if (!result) throw new Error('Failed to parse schema analysis response');
    result.url = url;
    result.pageTitle = page.title;
    log.info('Schema markup analysis complete', { url, score: result.schemaScore });
    return result;
  } catch (e) {
    log.error('Schema markup analysis failed', { url, error: e.message });
    throw new Error(`Schema markup analysis failed: ${e.message}`);
  }
}

// ============================================================
// Comprehensive SEO Audit (Enhanced with all dimensions)
// ============================================================

/**
 * Run a comprehensive SEO audit combining all analysis dimensions.
 * Scoring: Technical 22%, Content/E-E-A-T 23%, On-Page 20%, Schema 10%,
 * Performance/CWV 10%, AI Search Readiness 10%, Images 5%.
 */
export async function comprehensiveSEOAudit(url) {
  if (!url) throw new Error('URL is required');
  if (!url.startsWith('http')) url = `https://${url}`;

  log.info('Starting comprehensive SEO audit', { url });

  // Run all analyses in parallel
  const [eeatResult, geoResult, technicalResult, imageResult, schemaResult] = await Promise.allSettled([
    analyzeEEAT(url),
    analyzeAISearchReadiness(url),
    technicalSEOAudit(url),
    analyzeImageSEO(url),
    analyzeSchemaMarkup(url),
  ]);

  const eeat = eeatResult.status === 'fulfilled' ? eeatResult.value : { overallScore: 0, error: eeatResult.reason?.message };
  const geo = geoResult.status === 'fulfilled' ? geoResult.value : { geoScore: 0, error: geoResult.reason?.message };
  const technical = technicalResult.status === 'fulfilled' ? technicalResult.value : { technicalScore: 0, error: technicalResult.reason?.message };
  const images = imageResult.status === 'fulfilled' ? imageResult.value : { imageScore: 0, error: imageResult.reason?.message };
  const schema = schemaResult.status === 'fulfilled' ? schemaResult.value : { schemaScore: 0, error: schemaResult.reason?.message };

  // Calculate weighted overall score
  const overallScore = Math.round(
    (technical.technicalScore || 0) * 0.22 +
    (eeat.overallScore || 0) * 0.23 +
    (technical.categories?.coreWebVitals?.score || 0) * 0.10 +
    (schema.schemaScore || 0) * 0.10 +
    (geo.geoScore || 0) * 0.10 +
    (images.imageScore || 0) * 0.05 +
    // On-page score from technical categories
    ((technical.categories?.indexability?.score || 0) + (technical.categories?.urlStructure?.score || 0)) / 2 * 0.20
  );

  // Collect all critical issues
  const allCritical = [
    ...(technical.criticalIssues || []).map(i => `[Technical] ${i}`),
    ...(eeat.topImprovements || []).slice(0, 2).map(i => `[E-E-A-T] ${i}`),
    ...(geo.topImprovements || []).slice(0, 2).map(i => `[AI Search] ${i}`),
    ...(images.issues || []).filter(i => i.priority === 'critical').map(i => `[Images] ${i.issue}`),
  ];

  const result = {
    url,
    overallScore,
    scoreBreakdown: {
      technical: { score: technical.technicalScore || 0, weight: '22%' },
      contentEEAT: { score: eeat.overallScore || 0, weight: '23%' },
      onPage: { score: ((technical.categories?.indexability?.score || 0) + (technical.categories?.urlStructure?.score || 0)) / 2, weight: '20%' },
      schema: { score: schema.schemaScore || 0, weight: '10%' },
      coreWebVitals: { score: technical.categories?.coreWebVitals?.score || 0, weight: '10%' },
      aiSearchReadiness: { score: geo.geoScore || 0, weight: '10%' },
      images: { score: images.imageScore || 0, weight: '5%' },
    },
    criticalIssues: allCritical.slice(0, 10),
    eeat: eeat.error ? { error: eeat.error } : {
      score: eeat.overallScore,
      experience: eeat.experience?.score,
      expertise: eeat.expertise?.score,
      authoritativeness: eeat.authoritativeness?.score,
      trustworthiness: eeat.trustworthiness?.score,
      aiCitationReadiness: eeat.aiCitationReadiness,
      summary: eeat.summary,
    },
    aiSearch: geo.error ? { error: geo.error } : {
      score: geo.geoScore,
      platformReadiness: geo.platformReadiness,
      crawlerAccess: geo.crawlerAccess,
      hasLlmsTxt: geo.hasLlmsTxt,
      quickWins: geo.quickWins,
      summary: geo.summary,
    },
    technical: technical.error ? { error: technical.error } : {
      score: technical.technicalScore,
      categories: Object.fromEntries(
        Object.entries(technical.categories || {}).map(([k, v]) => [k, { score: v.score, issueCount: v.issues?.length || 0 }])
      ),
      summary: technical.summary,
    },
    images: images.error ? { error: images.error } : {
      score: images.imageScore,
      totalImages: images.totalImages,
      missingAltText: images.missingAltText,
      summary: images.summary,
    },
    schema: schema.error ? { error: schema.error } : {
      score: schema.schemaScore,
      detectedCount: schema.detectedCount,
      missingOpportunities: schema.missingOpportunities?.length || 0,
      summary: schema.summary,
    },
    timestamp: new Date().toISOString(),
  };

  log.info('Comprehensive SEO audit complete', { url, overallScore: result.overallScore });
  return result;
}

export default {
  analyzeEEAT,
  analyzeAISearchReadiness,
  technicalSEOAudit,
  analyzeImageSEO,
  analyzeSchemaMarkup,
  comprehensiveSEOAudit,
};
