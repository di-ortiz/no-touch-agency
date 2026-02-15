import logger from '../utils/logger.js';
import { askClaude, deepAnalysis } from '../api/anthropic.js';
import * as openaiMedia from '../api/openai-media.js';
import * as googleSlides from '../api/google-slides.js';
import { getClient, buildClientContext, getTopCreatives } from './knowledge-base.js';
import { auditLog } from './cost-tracker.js';
import config from '../config.js';

const log = logger.child({ workflow: 'creative-engine' });

// Platform-specific ad spec constraints
const PLATFORM_SPECS = {
  meta: {
    headline: { max: 40, label: 'Headline' },
    body: { max: 125, label: 'Primary Text' },
    description: { max: 30, label: 'Description' },
    cta_options: ['Shop Now', 'Learn More', 'Sign Up', 'Get Offer', 'Book Now', 'Contact Us', 'Download', 'Apply Now', 'Subscribe', 'Get Quote'],
    formats: ['Single Image', 'Carousel', 'Video', 'Stories', 'Reels'],
    imageFormats: ['meta_feed', 'meta_square', 'meta_story'],
    videoFormat: 'meta_story',
  },
  instagram: {
    headline: { max: 40, label: 'Headline' },
    body: { max: 125, label: 'Caption' },
    description: { max: 30, label: 'Description' },
    cta_options: ['Shop Now', 'Learn More', 'Sign Up', 'Book Now', 'Contact Us', 'Get Offer'],
    formats: ['Feed Post', 'Carousel', 'Reels', 'Stories'],
    imageFormats: ['instagram_feed', 'instagram_story'],
    videoFormat: 'instagram_story',
  },
  google: {
    headline: { max: 30, label: 'Headline' },
    longHeadline: { max: 90, label: 'Long Headline' },
    description: { max: 90, label: 'Description' },
    cta_options: ['Apply Now', 'Book Now', 'Contact Us', 'Download', 'Learn More', 'Get Quote', 'Shop Now', 'Sign Up', 'Subscribe'],
    formats: ['Responsive Search Ad', 'Responsive Display Ad', 'Performance Max', 'Video Ad'],
    imageFormats: ['google_display', 'google_square'],
    videoFormat: 'google_display',
  },
  tiktok: {
    headline: { max: 100, label: 'Ad Text' },
    body: { max: 100, label: 'Description' },
    cta_options: ['Shop Now', 'Learn More', 'Sign Up', 'Download', 'Contact Us', 'Apply Now', 'Book Now'],
    formats: ['In-Feed Video', 'Spark Ad', 'TopView'],
    imageFormats: ['tiktok'],
    videoFormat: 'tiktok',
  },
};

// ============================================================
// Text Ad Generation
// ============================================================

/**
 * Generate platform-specific text ad variations with proper constraints.
 *
 * @param {object} opts
 * @param {string} opts.clientName - Client name (or clientId)
 * @param {string} opts.platform - Platform key
 * @param {string} opts.objective - Campaign objective
 * @param {string} opts.audience - Target audience description
 * @param {string} opts.offer - Offer/promotion (optional)
 * @param {string} opts.angle - Creative angle/theme (optional)
 * @param {number} opts.variations - Number of variations (default: 5)
 * @returns {Array} Structured text ad objects
 */
export async function generateTextAds(opts = {}) {
  const client = typeof opts.clientName === 'string' ? getClient(opts.clientName) : null;
  const platform = opts.platform || 'meta';
  const specs = PLATFORM_SPECS[platform] || PLATFORM_SPECS.meta;
  const variations = opts.variations || 5;

  const topCreatives = client ? getTopCreatives(client.id, 5) : [];
  const topPerformingRef = topCreatives.length > 0
    ? topCreatives.map(c => `- "${c.headline}" (CTR: ${(c.ctr * 100).toFixed(2)}%)`).join('\n')
    : 'No past performance data.';

  const prompt = `Generate ${variations} ad copy variations for ${opts.clientName || 'the brand'}.

PLATFORM: ${platform.toUpperCase()}
OBJECTIVE: ${opts.objective || 'conversions'}
TARGET AUDIENCE: ${opts.audience || client?.target_audience || 'Not specified'}
OFFER: ${opts.offer || 'None'}
${opts.angle ? `CREATIVE ANGLE: ${opts.angle}` : ''}
${client?.brand_voice ? `BRAND VOICE: ${client.brand_voice}` : ''}
${client?.industry ? `INDUSTRY: ${client.industry}` : ''}

CHARACTER LIMITS (STRICT — do not exceed):
${Object.entries(specs).filter(([k, v]) => v.max).map(([k, v]) => `- ${v.label}: ${v.max} characters max`).join('\n')}

AVAILABLE CTAs: ${specs.cta_options.join(', ')}

TOP PERFORMING PAST ADS:
${topPerformingRef}

Return a JSON array of ${variations} ad objects. Each object must have:
{
  "headline": "string (within char limit)",
  "description": "string (within char limit)",
  "body": "string (primary text / caption, within char limit)",
  "cta": "string (from available CTAs)",
  "angle": "string (brief description of the creative angle used)"
}

${platform === 'google' ? 'Also include "longHeadline" (90 chars max) for responsive display ads.' : ''}

IMPORTANT: Stay STRICTLY within character limits. Return ONLY the JSON array.`;

  const response = await deepAnalysis({
    systemPrompt: `You are an expert PPC ad copywriter specializing in ${platform} ads. You write high-converting ad copy that strictly follows platform character limits. You always return valid JSON.`,
    prompt,
    workflow: 'text-ad-generation',
    clientId: client?.id,
  });

  let ads = [];
  try {
    const jsonMatch = response.text.match(/\[[\s\S]*\]/);
    if (jsonMatch) ads = JSON.parse(jsonMatch[0]);
  } catch (e) {
    log.error('Failed to parse text ad JSON', { error: e.message });
    ads = [{ headline: 'Generation failed', description: 'Please try again', body: '', cta: 'Learn More', angle: 'Error' }];
  }

  // Validate char limits
  for (const ad of ads) {
    if (specs.headline?.max && ad.headline?.length > specs.headline.max) {
      ad.headline = ad.headline.slice(0, specs.headline.max);
      ad._truncated = true;
    }
    if (specs.description?.max && ad.description?.length > specs.description.max) {
      ad.description = ad.description.slice(0, specs.description.max);
      ad._truncated = true;
    }
    if (specs.body?.max && ad.body?.length > specs.body.max) {
      ad.body = ad.body.slice(0, specs.body.max);
      ad._truncated = true;
    }
  }

  log.info(`Generated ${ads.length} text ads for ${opts.clientName}`, { platform });
  return ads;
}

// ============================================================
// Image Prompt Engineering
// ============================================================

/**
 * Generate an image prompt optimized for ad creatives.
 *
 * @param {object} opts
 * @param {string} opts.clientName
 * @param {string} opts.platform - Target platform
 * @param {string} opts.product - Product/service to feature
 * @param {string} opts.offer - Offer/promotion
 * @param {string} opts.concept - Creative concept/angle
 * @param {string} opts.audience - Target audience
 * @param {string} opts.mood - Desired mood/emotion
 * @param {string} opts.style - Creative style (photorealistic, minimalist, lifestyle, etc.)
 * @param {string} opts.brandColors - Brand color palette
 * @param {string} opts.references - Visual references or inspiration
 * @param {string} opts.websiteInsights - Insights from browsing client website
 * @param {string} opts.competitorInsights - Insights from competitor ad research
 */
export async function generateImagePrompt(opts = {}) {
  const client = typeof opts.clientName === 'string' ? getClient(opts.clientName) : null;

  const { SYSTEM_PROMPTS } = await import('../prompts/templates.js');

  const briefSections = [
    `CLIENT: ${opts.clientName || 'Brand'}`,
    `PLATFORM: ${opts.platform || 'social media'} ad creative`,
  ];

  if (client?.industry || opts.industry) briefSections.push(`INDUSTRY: ${client?.industry || opts.industry}`);
  if (opts.brandColors || client?.brand_colors) briefSections.push(`BRAND COLORS: ${opts.brandColors || client?.brand_colors}`);
  if (opts.product || opts.offer) briefSections.push(`PRODUCT/SERVICE: ${opts.product || opts.offer}`);
  if (opts.audience || client?.target_audience) briefSections.push(`TARGET AUDIENCE: ${opts.audience || client?.target_audience}`);
  if (opts.concept) briefSections.push(`CREATIVE CONCEPT: ${opts.concept}`);
  if (opts.mood) briefSections.push(`MOOD/EMOTION: ${opts.mood}`);
  if (opts.style) briefSections.push(`CREATIVE STYLE: ${opts.style}`);
  if (opts.references) briefSections.push(`VISUAL REFERENCES/INSPIRATION: ${opts.references}`);
  if (opts.websiteInsights) briefSections.push(`INSIGHTS FROM CLIENT WEBSITE:\n${opts.websiteInsights}`);
  if (opts.competitorInsights) briefSections.push(`COMPETITOR AD LANDSCAPE:\n${opts.competitorInsights}`);
  if (client?.brand_voice) briefSections.push(`BRAND VOICE: ${client.brand_voice}`);

  // Add platform-specific guidance
  const platformGuide = {
    meta: 'Design for Meta Feed — landscape/square, needs to stop the scroll in a busy feed. Leave clean space on the right or bottom third for headline overlay.',
    instagram: 'Design for Instagram — visually stunning, aspirational. Square or vertical format. Must feel native to the platform, not overly "ad-like".',
    google: 'Design for Google Display Network — needs to work at small sizes. Bold, simple composition with one clear focal point. High contrast.',
    tiktok: 'Design for TikTok — vertical format, energetic and authentic feel. Should look native to the platform, not overly polished/corporate.',
  };
  if (platformGuide[opts.platform]) briefSections.push(`PLATFORM GUIDANCE: ${platformGuide[opts.platform]}`);

  // Fallback defaults if minimal info provided
  if (!opts.concept && !opts.style && !opts.mood) {
    briefSections.push(`CREATIVE DIRECTION: Create a scroll-stopping, premium advertising visual. Choose an appropriate style based on the industry and brand. Avoid stock photo cliches.`);
  }

  const response = await askClaude({
    systemPrompt: SYSTEM_PROMPTS.imagePromptEngineer,
    userMessage: `Write a DALL-E 3 prompt for this ad creative brief:\n\n${briefSections.join('\n')}\n\nReturn ONLY the image prompt text, nothing else. Make it detailed (200-400 words). Remember to end with "no text, no words, no letters, no numbers, no logos, no watermarks, no writing of any kind".`,
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 1500,
    workflow: 'image-prompt-engineering',
    clientId: client?.id,
  });

  return response.text.trim();
}

// ============================================================
// Full Creative Package
// ============================================================

/**
 * Generate a complete creative package: text ads + images + video + presentation.
 *
 * @param {object} opts
 * @param {string} opts.clientName
 * @param {string} opts.platform
 * @param {string} opts.campaignName
 * @param {string} opts.objective
 * @param {string} opts.audience
 * @param {string} opts.offer
 * @param {string} opts.concept - Creative concept/theme
 * @param {number} opts.textVariations - Number of text variations (default: 5)
 * @param {boolean} opts.generateImages - Generate images (default: true)
 * @param {boolean} opts.generateVideo - Generate video (default: false)
 * @param {boolean} opts.buildDeck - Build Google Slides deck (default: true)
 * @returns {object} Full creative package with URLs
 */
export async function generateCreativePackage(opts = {}) {
  const client = typeof opts.clientName === 'string' ? getClient(opts.clientName) : null;
  const platform = opts.platform || 'meta';
  const specs = PLATFORM_SPECS[platform] || PLATFORM_SPECS.meta;

  log.info(`Generating full creative package for ${opts.clientName}`, { platform, objective: opts.objective });

  const result = {
    clientName: opts.clientName,
    platform,
    campaignName: opts.campaignName || `${platform} Campaign`,
    textAds: [],
    images: [],
    videos: [],
    presentation: null,
    summary: '',
  };

  // --- Step 1: Generate text ads ---
  log.info('Step 1: Generating text ads...');
  result.textAds = await generateTextAds({
    clientName: opts.clientName,
    platform,
    objective: opts.objective,
    audience: opts.audience,
    offer: opts.offer,
    angle: opts.concept,
    variations: opts.textVariations || 5,
  });

  // --- Step 2: Generate images ---
  if (opts.generateImages !== false && config.OPENAI_API_KEY) {
    log.info('Step 2: Generating ad images...');
    try {
      // Generate an image prompt based on the creative brief
      const imagePrompt = await generateImagePrompt({
        clientName: opts.clientName,
        platform,
        product: opts.offer,
        concept: opts.concept || result.textAds[0]?.angle,
        audience: opts.audience,
        mood: opts.mood,
        style: opts.style,
        brandColors: opts.brandColors || client?.brand_colors,
        references: opts.references,
        websiteInsights: opts.websiteInsights,
        competitorInsights: opts.competitorInsights,
      });

      // Generate images for platform-specific formats
      const images = await openaiMedia.generateAdImages({
        prompt: imagePrompt,
        platform,
        quality: 'hd',
        style: 'natural',
        workflow: 'creative-package',
        clientId: client?.id,
      });

      result.images = images.map((img, i) => ({
        ...img,
        concept: opts.concept || result.textAds[0]?.angle || `Creative ${i + 1}`,
        label: img.dimensions?.label || img.format,
      }));
    } catch (e) {
      log.error('Image generation failed', { error: e.message });
      result.images = [{ error: e.message }];
    }
  }

  // --- Step 3: Generate video ---
  if (opts.generateVideo && config.OPENAI_API_KEY) {
    log.info('Step 3: Generating ad video...');
    try {
      const videoPrompt = `Professional advertising video for ${opts.clientName || 'a brand'}. ${opts.concept || result.textAds[0]?.angle || 'Engaging and aspirational'}. ${opts.offer ? `Featuring: ${opts.offer}.` : ''} High production quality, smooth camera movement, cinematic lighting. No text overlays.`;

      const video = await openaiMedia.generateAdVideo({
        prompt: videoPrompt,
        format: specs.videoFormat,
        duration: 8,
        workflow: 'creative-package',
        clientId: client?.id,
      });

      result.videos = [{
        ...video,
        concept: opts.concept || 'Hero video',
      }];
    } catch (e) {
      log.error('Video generation failed', { error: e.message });
      result.videos = [{ error: e.message }];
    }
  }

  // --- Step 4: Generate campaign summary ---
  const summaryResponse = await askClaude({
    systemPrompt: 'You are a PPC strategist writing a brief campaign creative summary.',
    userMessage: `Write a concise 3-4 sentence summary for this creative package:
Client: ${opts.clientName}
Platform: ${platform}
Objective: ${opts.objective || 'conversions'}
Target: ${opts.audience || 'See client profile'}
Offer: ${opts.offer || 'None'}
Concept: ${opts.concept || 'Performance-driven'}
Text Variations: ${result.textAds.length}
Images: ${result.images.filter(i => !i.error).length}
Videos: ${result.videos.filter(v => !v.error).length}`,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 256,
    workflow: 'creative-package',
    clientId: client?.id,
  });
  result.summary = summaryResponse.text;

  // --- Step 5: Build presentation deck ---
  if (opts.buildDeck !== false) {
    log.info('Step 5: Building creative deck...');
    try {
      const folderId = client?.drive_creatives_folder_id || client?.drive_folder_id || config.GOOGLE_DRIVE_ROOT_FOLDER_ID;

      const presentation = await googleSlides.buildCreativeDeck({
        clientName: opts.clientName,
        campaignName: opts.campaignName || `${platform} Campaign`,
        platform,
        textAds: result.textAds,
        images: result.images.filter(i => !i.error),
        videos: result.videos.filter(v => !v.error),
        summary: result.summary,
        folderId,
      });

      result.presentation = presentation;
    } catch (e) {
      log.error('Deck building failed', { error: e.message });
      result.presentation = { error: e.message };
    }
  }

  // Audit log
  auditLog({
    action: 'creative_package_generated',
    workflow: 'creative-engine',
    clientId: client?.id,
    platform,
    details: {
      textAds: result.textAds.length,
      images: result.images.filter(i => !i.error).length,
      videos: result.videos.filter(v => !v.error).length,
      hasDeck: !!result.presentation?.url,
    },
    approvedBy: 'pending',
    result: 'awaiting_approval',
  });

  log.info(`Creative package complete for ${opts.clientName}`, {
    textAds: result.textAds.length,
    images: result.images.length,
    videos: result.videos.length,
    deckUrl: result.presentation?.url,
  });

  return result;
}

export default {
  generateTextAds,
  generateImagePrompt,
  generateCreativePackage,
  PLATFORM_SPECS,
};
