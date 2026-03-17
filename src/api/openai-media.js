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
    client = new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: 45000 });
  }
  return client;
}

// ============================================================
// Platform-specific ad dimensions
// ============================================================

// gpt-image-1 sizes: 1024x1024, 1536x1024 (landscape), 1024x1536 (portrait), auto
// dall-e-3 sizes:    1024x1024, 1792x1024 (landscape), 1024x1792 (portrait)
export const AD_DIMENSIONS = {
  meta_feed:       { width: 1200, height: 628,  label: 'Meta Feed (1200x628)',       size: '1536x1024', dalleSize: '1792x1024' },
  meta_square:     { width: 1080, height: 1080, label: 'Meta Square (1080x1080)',     size: '1024x1024', dalleSize: '1024x1024' },
  meta_story:      { width: 1080, height: 1920, label: 'Meta Story/Reel (1080x1920)', size: '1024x1536', dalleSize: '1024x1792' },
  instagram_feed:  { width: 1080, height: 1080, label: 'Instagram Feed (1080x1080)',  size: '1024x1024', dalleSize: '1024x1024' },
  instagram_story: { width: 1080, height: 1920, label: 'Instagram Story (1080x1920)', size: '1024x1536', dalleSize: '1024x1792' },
  google_display:  { width: 1200, height: 628,  label: 'Google Display (1200x628)',   size: '1536x1024', dalleSize: '1792x1024' },
  google_square:   { width: 1200, height: 1200, label: 'Google Square (1200x1200)',   size: '1024x1024', dalleSize: '1024x1024' },
  tiktok:          { width: 1080, height: 1920, label: 'TikTok (1080x1920)',          size: '1024x1536', dalleSize: '1024x1792' },
  general:         { width: 1024, height: 1024, label: 'General (1024x1024)',         size: '1024x1024', dalleSize: '1024x1024' },
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
 * Generate an ad creative image using OpenAI (gpt-image-1 or dall-e-3).
 *
 * gpt-image-1 is the default (newer, better quality). Returns base64.
 * dall-e-3 is the fallback. Returns URLs (expire after 60 min).
 *
 * @param {object} opts
 * @param {string} opts.prompt - Image generation prompt
 * @param {string} opts.format - Ad format key from AD_DIMENSIONS (default: 'general')
 * @param {string} opts.quality - 'low'|'medium'|'high'|'auto' for gpt-image-1; 'standard'|'hd' for dall-e-3
 * @param {string} opts.style - 'vivid' or 'natural' (dall-e-3 only, ignored for gpt-image-1)
 * @param {string} opts.model - 'gpt-image-1' (default) or 'dall-e-3'
 * @param {string} opts.workflow - Workflow name for cost tracking
 * @param {string} opts.clientId - Client ID for cost tracking
 * @returns {object} { url, base64, mimeType, revisedPrompt, format, dimensions, provider }
 */
export async function generateImage(opts = {}) {
  const openai = getClient();
  const format = opts.format || 'general';
  const dims = AD_DIMENSIONS[format] || AD_DIMENSIONS.general;
  const model = opts.model || 'gpt-image-1';
  const isDalle = model === 'dall-e-3';

  return rateLimited('openai', () =>
    retry(async () => {
      log.info(`Generating ${model} image`, { format, prompt: opts.prompt?.slice(0, 100) });

      const params = {
        model,
        prompt: opts.prompt,
        n: 1,
        size: isDalle ? dims.dalleSize : dims.size,
      };

      if (isDalle) {
        // DALL-E 3 specific params
        params.quality = opts.quality || 'hd';
        params.style = opts.style || 'natural';
        params.response_format = 'url';
      } else {
        // gpt-image-1 specific params — returns base64 only
        params.quality = opts.quality || 'high';
      }

      const response = await openai.images.generate(params);
      const image = response.data[0];

      // Build result based on model
      let url, base64Data, mimeType;

      if (isDalle) {
        url = image.url;
      } else {
        // gpt-image-1 returns b64_json
        base64Data = image.b64_json;
        mimeType = 'image/png';
        url = `data:${mimeType};base64,${base64Data}`;
      }

      // Track cost — gpt-image-1 is token-based but roughly:
      // Low ~2¢, Medium ~5¢, High ~8¢ per 1024x1024
      const costMap = isDalle
        ? { hd: 8.0, standard: 4.0 }
        : { high: 8.0, medium: 5.0, low: 2.0, auto: 5.0 };
      const qualityKey = isDalle ? (opts.quality || 'hd') : (opts.quality || 'high');
      const costCents = costMap[qualityKey] || 5.0;

      recordCost({
        platform: 'openai',
        model,
        workflow: opts.workflow || 'creative-generation',
        clientId: opts.clientId,
        costCentsOverride: costCents,
        metadata: { format, quality: qualityKey },
      });

      log.info(`${model} image generated`, { format });
      return {
        url,
        base64: base64Data,
        mimeType,
        revisedPrompt: image.revised_prompt,
        format,
        dimensions: dims,
        provider: 'openai',
      };
    }, { retries: 1, label: `${model} image`, shouldRetry: isRetryableHttpError })
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
      const formatPrompt = `${opts.prompt}. This is a ${dims.label} ad creative. The image should be perfectly composed for ${dims.width}x${dims.height} pixels. Professional advertising quality, clean composition with space for text overlay in the lower third.`;

      const image = await generateImage({
        ...opts,
        prompt: formatPrompt,
        format,
      });
      results.push(image);
    } catch (e) {
      log.error(`Failed to generate image for format ${format}`, { error: e.message });
      results.push({ format, error: e.message, provider: 'openai' });
    }
  }

  return results;
}

// ============================================================
// Sora 2 Video Generation (OpenAI Videos API)
// ============================================================

// Map aspect ratios to Sora 2 video sizes
const VIDEO_SIZES = {
  '16:9': '1280x720',
  '9:16': '720x1280',
  'landscape': '1280x720',
  'portrait': '720x1280',
};

/**
 * Generate a short ad video using OpenAI's Sora 2 model.
 *
 * Uses the dedicated Videos API: POST /v1/videos → poll GET /v1/videos/{id}
 *
 * @param {object} opts
 * @param {string} opts.prompt - Video generation prompt
 * @param {number} opts.duration - Duration in seconds: 4, 8, or 12 (default: 8)
 * @param {string} opts.aspectRatio - '16:9' or '9:16' (default: '16:9')
 * @param {string} opts.model - 'sora-2' (default) or 'sora-2-pro'
 * @param {string} opts.workflow - Workflow name
 * @param {string} opts.clientId - Client ID
 * @param {Function} opts.onProgress - Optional progress callback
 * @returns {object} { videoUrl, id, status, duration, prompt, aspectRatio }
 */
export async function generateVideo(opts = {}) {
  const openai = getClient();
  const seconds = opts.duration || 8;
  const model = opts.model || 'sora-2';
  const size = VIDEO_SIZES[opts.aspectRatio] || VIDEO_SIZES['16:9'];

  return rateLimited('openai', () =>
    retry(async () => {
      log.info('Creating Sora 2 video generation job', { seconds, size, prompt: opts.prompt?.slice(0, 100) });

      // Create video generation job via dedicated Videos API
      const video = await openai.videos.create({
        model,
        prompt: opts.prompt,
        seconds,
        size,
      });

      if (!video?.id) {
        throw new Error('No video ID returned from Sora 2 API');
      }

      log.info('Sora 2 job created', { id: video.id, status: video.status });

      // Poll for completion
      const maxWaitMs = 300_000; // 5 min max
      const pollIntervalMs = 15_000; // 15s between polls
      let waited = 0;
      const onProgress = opts.onProgress;

      while (waited < maxWaitMs) {
        await sleep(pollIntervalMs);
        waited += pollIntervalMs;

        // Send progress updates via callback (every ~60s)
        if (onProgress && waited > 0 && waited % 60000 < pollIntervalMs) {
          try { await onProgress({ waited, maxWait: maxWaitMs, status: 'generating' }); } catch (_) {}
        }

        try {
          const status = await openai.videos.retrieve(video.id);
          log.debug('Polling Sora 2 status', { id: video.id, status: status.status, progress: status.progress, waited });

          if (status.status === 'completed') {
            // Track cost (Sora 2 Standard: $0.10/sec, Pro: $0.30/sec)
            const costPerSecond = model.includes('pro') ? 30 : 10;
            const costCents = seconds * costPerSecond;
            recordCost({
              platform: 'openai',
              model,
              workflow: opts.workflow || 'video-generation',
              clientId: opts.clientId,
              costCentsOverride: costCents,
              metadata: { seconds, size },
            });

            log.info('Sora 2 video completed', { id: video.id, seconds });

            // Download the video content to get the URL
            let videoUrl = null;
            try {
              const downloadResponse = await openai.videos.downloadContent(video.id, { variant: 'video' });
              videoUrl = downloadResponse.url;
            } catch (dlErr) {
              log.warn('Failed to get download URL, using video ID for reference', { error: dlErr.message });
            }

            return {
              videoUrl,
              id: video.id,
              status: 'completed',
              duration: seconds,
              prompt: opts.prompt,
              aspectRatio: opts.aspectRatio || '16:9',
              size,
            };
          }

          if (status.status === 'failed') {
            const errorDetail = status.error?.message || status.error?.code || 'Unknown error';
            throw new Error(`Sora 2 video generation failed: ${errorDetail}. This can happen due to content policy violations, high demand, or an unsupported prompt. Job ID: ${video.id}`);
          }
        } catch (e) {
          if (e.message.includes('failed')) throw e;
          // Handle rate limiting during polling
          if (e.status === 429 || e.response?.status === 429) {
            log.warn('Rate limited while polling Sora 2, waiting longer...', { waited });
            await sleep(30_000);
            waited += 30_000;
            continue;
          }
          log.debug('Polling Sora 2 (transient error)', { waited, error: e.message });
        }
      }

      throw new Error(`Sora 2 video generation timed out after ${maxWaitMs / 60000} minutes. The video may still be generating. Job ID: ${video.id}. You can try again with a different prompt.`);
    }, { retries: 1, label: 'Sora 2 video', shouldRetry: isRetryableHttpError })
  );
}

/**
 * Generate a platform-specific ad video.
 * Sora 2 supports 16:9 (1280x720) and 9:16 (720x1280).
 */
export async function generateAdVideo(opts = {}) {
  const platformAspectRatios = {
    meta_feed:       '16:9',
    meta_story:      '9:16',
    instagram_feed:  '16:9',  // Sora 2 doesn't support 1:1, use landscape
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
