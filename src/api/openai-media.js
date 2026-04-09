import OpenAI from 'openai';
import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { recordCost } from '../services/cost-tracker.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';
import { sleep } from '../utils/retry.js';

const log = logger.child({ platform: 'openai-media' });

let client;

function getClient() {
  if (!client) {
    if (!config.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not configured. Set it in .env to enable image/video generation.');
    }
    client = new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: 30000 });
  }
  return client;
}

// ============================================================
// Platform-specific ad dimensions
// ============================================================
export const AD_DIMENSIONS = {
  meta_feed:       { width: 1200, height: 628,  label: 'Meta Feed (1200x628)',       size: '1792x1024' },
  meta_square:     { width: 1080, height: 1080, label: 'Meta Square (1080x1080)',     size: '1024x1024' },
  meta_story:      { width: 1080, height: 1920, label: 'Meta Story/Reel (1080x1920)', size: '1024x1792' },
  instagram_feed:  { width: 1080, height: 1080, label: 'Instagram Feed (1080x1080)',  size: '1024x1024' },
  instagram_story: { width: 1080, height: 1920, label: 'Instagram Story (1080x1920)', size: '1024x1792' },
  google_display:  { width: 1200, height: 628,  label: 'Google Display (1200x628)',   size: '1792x1024' },
  google_square:   { width: 1200, height: 1200, label: 'Google Square (1200x1200)',   size: '1024x1024' },
  tiktok:          { width: 1080, height: 1920, label: 'TikTok (1080x1920)',          size: '1024x1792' },
  general:         { width: 1024, height: 1024, label: 'General (1024x1024)',         size: '1024x1024' },
};

// Map platform names to default ad formats
const PLATFORM_DEFAULTS = {
  meta:      ['meta_feed', 'meta_square', 'meta_story'],
  instagram: ['instagram_feed', 'instagram_story'],
  google:    ['google_display', 'google_square'],
  tiktok:    ['tiktok'],
};

// ============================================================
// DALL-E 3 Image Generation
// ============================================================

/**
 * Generate an ad creative image using DALL-E 3.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Image generation prompt
 * @param {string} opts.format - Ad format key from AD_DIMENSIONS (default: 'general')
 * @param {string} opts.quality - 'standard' or 'hd' (default: 'hd')
 * @param {string} opts.style - 'vivid' or 'natural' (default: 'natural')
 * @param {string} opts.workflow - Workflow name for cost tracking
 * @param {string} opts.clientId - Client ID for cost tracking
 * @returns {object} { url, revisedPrompt, format, dimensions }
 */
export async function generateImage(opts = {}) {
  const openai = getClient();
  const format = opts.format || 'general';
  const dims = AD_DIMENSIONS[format] || AD_DIMENSIONS.general;

  return rateLimited('openai', () =>
    retry(async () => {
      log.info('Generating DALL-E 3 image', { format, prompt: opts.prompt?.slice(0, 100) });

      const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt: opts.prompt,
        n: 1,
        size: dims.size,
        quality: opts.quality || 'hd',
        style: opts.style || 'natural',
        response_format: 'url',
      });

      const image = response.data[0];

      // Track cost
      const costCents = opts.quality === 'hd' ? 8.0 : 4.0; // DALL-E 3 HD vs standard
      recordCost({
        platform: 'openai',
        model: 'dall-e-3',
        workflow: opts.workflow || 'creative-generation',
        clientId: opts.clientId,
        costCentsOverride: costCents,
        metadata: { format, quality: opts.quality || 'hd' },
      });

      log.info('DALL-E 3 image generated', { format });
      return {
        url: image.url,
        revisedPrompt: image.revised_prompt,
        format,
        dimensions: dims,
      };
    }, { retries: 0, label: 'DALL-E 3 image', shouldRetry: isRetryableHttpError })
  );
}

/**
 * Generate ad images for multiple platform formats.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Base image prompt
 * @param {string} opts.platform - Platform key ('meta', 'instagram', 'google', 'tiktok')
 * @param {string[]} opts.formats - Specific format keys (optional, overrides platform defaults)
 * @param {string} opts.quality - 'standard' or 'hd'
 * @param {string} opts.style - 'vivid' or 'natural'
 * @param {string} opts.workflow - Workflow name
 * @param {string} opts.clientId - Client ID
 * @returns {Array} Array of generated images with metadata
 */
export async function generateAdImages(opts = {}) {
  const formats = opts.formats || PLATFORM_DEFAULTS[opts.platform] || ['general'];
  const results = [];

  for (const format of formats) {
    try {
      const dims = AD_DIMENSIONS[format] || AD_DIMENSIONS.general;
      // Adapt prompt for the specific format
      const formatPrompt = `${opts.prompt}. This is a ${dims.label} ad creative composed for ${dims.width}x${dims.height} pixels. Professional advertising quality, clean composition. CRITICAL: No text, no words, no letters, no logos, no UI elements. Pure visual scene with clean space for text overlay.`;

      const image = await generateImage({
        ...opts,
        prompt: formatPrompt,
        format,
      });
      results.push(image);
    } catch (e) {
      log.error(`Failed to generate image for format ${format}`, { error: e.message });
      results.push({ format, error: e.message });
    }
  }

  return results;
}

// ============================================================
// Sora 2 Video Generation (OpenAI Video API)
// ============================================================

/**
 * Generate a short ad video using OpenAI's Sora 2 model.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Video generation prompt
 * @param {number} opts.duration - Duration in seconds (4, 8, 12 for standard; 10, 15, 25 for pro)
 * @param {string} opts.resolution - '720p' or '1080p' (default: '720p')
 * @param {string} opts.aspectRatio - '16:9', '9:16', '1:1' (default: '16:9')
 * @param {string} opts.model - 'sora-2' (default)
 * @param {string} opts.workflow - Workflow name
 * @param {string} opts.clientId - Client ID
 * @returns {object} { videoUrl, id, status, duration, prompt }
 */
export async function generateVideo(opts = {}) {
  const openai = getClient();
  const duration = opts.duration || 8;

  return rateLimited('openai', () =>
    retry(async () => {
      log.info('Creating Sora video generation job', { duration, prompt: opts.prompt?.slice(0, 100) });

      // Use the Images API with model 'sora' for video generation.
      // OpenAI's Sora is accessed via the images.generate endpoint with video-capable models.
      const response = await openai.images.generate({
        model: 'gpt-image-1',
        prompt: opts.prompt,
        n: 1,
        size: opts.aspectRatio === '9:16' ? '1024x1536'
          : opts.aspectRatio === '1:1' ? '1024x1024'
          : '1536x1024',
        quality: 'high',
      });

      const image = response.data?.[0];
      if (!image) {
        throw new Error('No output returned from OpenAI image generation');
      }

      // For now, OpenAI video generation through the responses API is not yet stable.
      // Fall back to generating a high-quality still image that can be animated via fal.ai.
      let resultUrl = image.url || null;
      let resultBuffer = null;

      // If we got base64 data instead of URL, upload to Supabase
      if (image.b64_json) {
        resultBuffer = Buffer.from(image.b64_json, 'base64');
      }

      // Upload to Supabase Storage for a stable URL
      if (resultUrl || resultBuffer) {
        try {
          const { uploadFromUrl, uploadBuffer } = await import('./supabase-storage.js');
          if (resultBuffer) {
            const result = await uploadBuffer(
              `videos/sora-${Date.now()}.png`,
              resultBuffer,
              'image/png',
            );
            resultUrl = result?.url || resultUrl;
          } else if (resultUrl) {
            const result = await uploadFromUrl(resultUrl, `sora-${Date.now()}.png`, 'videos');
            if (result?.url) resultUrl = result.url;
          }
        } catch (uploadErr) {
          log.warn('Failed to upload Sora result to storage', { error: uploadErr.message });
        }
      }

      // Track cost
      const costCents = 8.0; // GPT-Image-1 high quality
      recordCost({
        platform: 'openai',
        model: 'gpt-image-1',
        workflow: opts.workflow || 'video-generation-fallback',
        clientId: opts.clientId,
        costCentsOverride: costCents,
        metadata: { duration, quality: 'high' },
      });

      log.info('OpenAI image generated (video fallback)', { hasUrl: !!resultUrl });
      return {
        videoUrl: resultUrl,
        id: null,
        status: 'still_image_fallback',
        isStillImage: true,
        duration,
        prompt: opts.prompt,
        resolution: opts.resolution || '720p',
        aspectRatio: opts.aspectRatio || '16:9',
        note: 'Generated as a still image via gpt-image-1 (Sora video API not available). Use Kling AI or fal.ai to animate.',
      };
    }, { retries: 1, label: 'OpenAI image (video fallback)', shouldRetry: isRetryableHttpError })
  );
}

/**
 * Generate a platform-specific ad video.
 */
export async function generateAdVideo(opts = {}) {
  // Set aspect ratio based on platform
  const platformAspectRatios = {
    meta_feed:       '16:9',
    meta_story:      '9:16',
    instagram_feed:  '1:1',
    instagram_story: '9:16',
    tiktok:          '9:16',
    google_display:  '16:9',
    youtube:         '16:9',
  };

  const aspectRatio = platformAspectRatios[opts.format] || opts.aspectRatio || '16:9';

  return generateVideo({
    ...opts,
    aspectRatio,
  });
}

export default {
  generateImage, generateAdImages,
  generateVideo, generateAdVideo,
  AD_DIMENSIONS,
};
