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
    client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
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
    }, { retries: 2, label: 'DALL-E 3 image', shouldRetry: isRetryableHttpError })
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
      const formatPrompt = `${opts.prompt}. This is a ${dims.label} ad creative. The image should be perfectly composed for ${dims.width}x${dims.height} pixels. Professional advertising quality, clean composition, no text overlays.`;

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
  const model = opts.model || 'sora-2';

  return rateLimited('openai', () =>
    retry(async () => {
      log.info('Creating Sora 2 video generation job', { duration, prompt: opts.prompt?.slice(0, 100) });

      // Create video generation job
      const response = await openai.responses.create({
        model,
        input: opts.prompt,
        tools: [{
          type: 'video_generation',
          duration,
          resolution: opts.resolution || '720p',
          aspect_ratio: opts.aspectRatio || '16:9',
        }],
      });

      // Extract the video generation output
      const videoOutput = response.output?.find(o => o.type === 'video_generation_call');
      if (!videoOutput) {
        throw new Error('No video generation output returned from Sora 2');
      }

      // Poll for completion
      let videoResult = null;
      const maxWaitMs = 300000; // 5 min max
      const pollIntervalMs = 10000;
      let waited = 0;

      while (waited < maxWaitMs) {
        await sleep(pollIntervalMs);
        waited += pollIntervalMs;

        try {
          const status = await openai.responses.retrieve(response.id);
          const completed = status.output?.find(
            o => o.type === 'video_generation_call' && o.status === 'completed'
          );
          if (completed) {
            videoResult = completed;
            break;
          }
          const failed = status.output?.find(
            o => o.type === 'video_generation_call' && o.status === 'failed'
          );
          if (failed) {
            throw new Error(`Sora 2 video generation failed: ${failed.error || 'Unknown error'}`);
          }
        } catch (e) {
          if (e.message.includes('failed')) throw e;
          log.debug('Polling Sora 2 status...', { waited });
        }
      }

      if (!videoResult) {
        throw new Error('Sora 2 video generation timed out after 5 minutes');
      }

      // Track cost (Sora 2 Standard: $0.10/sec = 10 cents/sec)
      const costPerSecond = model === 'sora-2-pro' ? 30 : 10;
      const costCents = duration * costPerSecond;
      recordCost({
        platform: 'openai',
        model,
        workflow: opts.workflow || 'video-generation',
        clientId: opts.clientId,
        costCentsOverride: costCents,
        metadata: { duration, resolution: opts.resolution || '720p' },
      });

      log.info('Sora 2 video generated', { duration, id: response.id });
      return {
        videoUrl: videoResult.url,
        id: response.id,
        status: 'completed',
        duration,
        prompt: opts.prompt,
        resolution: opts.resolution || '720p',
        aspectRatio: opts.aspectRatio || '16:9',
      };
    }, { retries: 1, label: 'Sora 2 video', shouldRetry: isRetryableHttpError })
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
