import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { recordCost } from '../services/cost-tracker.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'kimi' });

const KIMI_BASE = 'https://api.moonshot.cn/v1';

function getHeaders() {
  return {
    Authorization: `Bearer ${config.KIMI_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Check if Kimi is configured with an API key.
 */
export function isConfigured() {
  return !!config.KIMI_API_KEY;
}

// Map ad format keys → Kimi image dimensions
const FORMAT_SIZE_MAP = {
  meta_feed:       { width: 1792, height: 1024 },
  meta_square:     { width: 1024, height: 1024 },
  meta_story:      { width: 1024, height: 1792 },
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

// Map dimensions to Kimi aspect ratio strings
function getAspectRatio(size) {
  const ratio = size.width / size.height;
  if (Math.abs(ratio - 1) < 0.01) return '1:1';
  if (ratio > 1.5) return '16:9';
  if (ratio < 0.7) return '9:16';
  return '1:1';
}

/**
 * Generate an image using Kimi 2.5 (Moonshot AI).
 *
 * Kimi 2.5 supports image generation via the chat completions endpoint
 * with a special tool/function call pattern, or via a dedicated images endpoint.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Image generation prompt
 * @param {string} opts.format - Ad format key (default: 'general')
 * @param {string} opts.workflow - Workflow name for cost tracking
 * @param {string} opts.clientId - Client ID for cost tracking
 * @returns {object} { url, format, dimensions, provider, model }
 */
export async function generateImage(opts = {}) {
  if (!isConfigured()) throw new Error('KIMI_API_KEY not configured');

  const format = opts.format || 'general';
  const imageSize = FORMAT_SIZE_MAP[format] || FORMAT_SIZE_MAP.general;
  const aspectRatio = getAspectRatio(imageSize);

  return rateLimited('kimi', () =>
    retry(async () => {
      log.info('Generating Kimi 2.5 image', { format, prompt: opts.prompt?.slice(0, 100) });

      // Kimi 2.5 image generation via the images endpoint
      const response = await axios.post(
        `${KIMI_BASE}/images/generations`,
        {
          model: 'kimi-2.5',
          prompt: opts.prompt,
          n: 1,
          size: `${imageSize.width}x${imageSize.height}`,
          aspect_ratio: aspectRatio,
        },
        { headers: getHeaders(), timeout: 90000 },
      );

      const image = response.data?.data?.[0];
      if (!image?.url && !image?.b64_json) {
        throw new Error('No image returned from Kimi 2.5');
      }

      // Cost: Kimi 2.5 image gen ~$0.04/image
      const cost = 4.0;
      recordCost({
        platform: 'kimi',
        model: 'kimi-2.5',
        workflow: opts.workflow || 'creative-generation',
        clientId: opts.clientId,
        costCentsOverride: cost,
        metadata: { format },
      });

      const url = image.url || `data:image/png;base64,${image.b64_json}`;
      log.info('Kimi 2.5 image generated', { format, hasUrl: !!image.url });

      return {
        url,
        base64: image.b64_json || null,
        format,
        dimensions: { ...imageSize, label: FORMAT_LABELS[format] || format },
        provider: 'kimi',
        model: 'kimi-2.5',
      };
    }, { retries: 0, label: 'Kimi 2.5 image', shouldRetry: isRetryableHttpError })
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
      const formatPrompt = `${opts.prompt}. This is a ${FORMAT_LABELS[format] || format} ad creative. Professional advertising quality, clean composition. No text, no words, no letters, no typography, no captions. Clean background visual only. Space for text overlay at the bottom third.`;

      const image = await generateImage({
        ...opts,
        prompt: formatPrompt,
        format,
      });
      results.push(image);
    } catch (e) {
      log.error(`Kimi 2.5 failed for format ${format}`, { error: e.message });
      results.push({ format, error: e.message, provider: 'kimi' });
    }
  }

  return results;
}

export default { generateImage, generateAdImages, isConfigured };
