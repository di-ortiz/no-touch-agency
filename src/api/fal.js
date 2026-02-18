import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { recordCost } from '../services/cost-tracker.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'fal' });

const FAL_BASE = 'https://fal.run';
const FAL_QUEUE = 'https://queue.fal.run';

function getHeaders() {
  return {
    Authorization: `Key ${config.FAL_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Check if fal.ai is configured with an API key.
 */
export function isConfigured() {
  return !!config.FAL_API_KEY;
}

// Map ad format keys → fal.ai image_size presets
const FORMAT_SIZE_MAP = {
  meta_feed:       { width: 1792, height: 1024 },  // ~16:9
  meta_square:     { width: 1024, height: 1024 },
  meta_story:      { width: 1024, height: 1792 },  // ~9:16
  instagram_feed:  { width: 1024, height: 1024 },
  instagram_story: { width: 1024, height: 1792 },
  google_display:  { width: 1792, height: 1024 },
  google_square:   { width: 1024, height: 1024 },
  tiktok:          { width: 1024, height: 1792 },
  general:         { width: 1024, height: 1024 },
};

const FORMAT_LABELS = {
  meta_feed:       'Meta Feed (1792x1024)',
  meta_square:     'Meta Square (1024x1024)',
  meta_story:      'Meta Story/Reel (1024x1792)',
  instagram_feed:  'Instagram Feed (1024x1024)',
  instagram_story: 'Instagram Story (1024x1792)',
  google_display:  'Google Display (1792x1024)',
  google_square:   'Google Square (1024x1024)',
  tiktok:          'TikTok (1024x1792)',
  general:         'General (1024x1024)',
};

/**
 * Generate an image using fal.ai Flux Pro v1.1.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Image generation prompt
 * @param {string} opts.format - Ad format key (default: 'general')
 * @param {string} opts.model - Flux model variant (default: 'fal-ai/flux-pro/v1.1')
 * @param {string} opts.workflow - Workflow name for cost tracking
 * @param {string} opts.clientId - Client ID for cost tracking
 * @returns {object} { url, format, dimensions, provider }
 */
export async function generateImage(opts = {}) {
  if (!isConfigured()) throw new Error('FAL_API_KEY not configured');

  const format = opts.format || 'general';
  const imageSize = FORMAT_SIZE_MAP[format] || FORMAT_SIZE_MAP.general;
  const model = opts.model || 'fal-ai/flux-pro/v1.1';

  return rateLimited('fal', () =>
    retry(async () => {
      log.info('Generating fal.ai image', { model, format, prompt: opts.prompt?.slice(0, 100) });

      const response = await axios.post(
        `${FAL_BASE}/${model}`,
        {
          prompt: opts.prompt,
          image_size: imageSize,
          num_images: 1,
          enable_safety_checker: true,
          output_format: 'jpeg',
          guidance_scale: 3.5,
        },
        { headers: getHeaders(), timeout: 120000 },
      );

      const image = response.data?.images?.[0];
      if (!image?.url) throw new Error('No image URL returned from fal.ai');

      // Flux Pro v1.1 costs ~$0.04 per image
      recordCost({
        platform: 'fal',
        model,
        workflow: opts.workflow || 'creative-generation',
        clientId: opts.clientId,
        costCentsOverride: 4.0,
        metadata: { format },
      });

      log.info('fal.ai image generated', { format, url: image.url?.slice(0, 80) });
      return {
        url: image.url,
        format,
        dimensions: { ...imageSize, label: FORMAT_LABELS[format] || format },
        provider: 'fal',
      };
    }, { retries: 2, label: 'fal.ai image', shouldRetry: isRetryableHttpError })
  );
}

/**
 * Generate ad images for multiple platform formats.
 */
export async function generateAdImages(opts = {}) {
  const PLATFORM_DEFAULTS = {
    meta:      ['meta_feed', 'meta_square', 'meta_story'],
    instagram: ['instagram_feed', 'instagram_story'],
    google:    ['google_display', 'google_square'],
    tiktok:    ['tiktok'],
  };

  const formats = opts.formats || PLATFORM_DEFAULTS[opts.platform] || ['general'];
  const results = [];

  for (const format of formats) {
    try {
      const dims = FORMAT_SIZE_MAP[format] || FORMAT_SIZE_MAP.general;
      const formatPrompt = `${opts.prompt}. This is a ${FORMAT_LABELS[format] || format} ad creative. Professional advertising quality, clean composition, no text overlays.`;

      const image = await generateImage({
        ...opts,
        prompt: formatPrompt,
        format,
      });
      results.push(image);
    } catch (e) {
      log.error(`fal.ai failed for format ${format}`, { error: e.message });
      results.push({ format, error: e.message, provider: 'fal' });
    }
  }

  return results;
}

export default { generateImage, generateAdImages, isConfigured };
