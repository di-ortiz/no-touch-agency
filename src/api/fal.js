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

// Model cost map (cents per image)
const MODEL_COSTS = {
  'fal-ai/flux/schnell':    0.3,   // ~$0.003
  'fal-ai/flux-pro/v1.1':   4.0,   // ~$0.04
};

/**
 * Call a single fal.ai model. Used internally by generateImage for racing.
 */
async function callFalModel(model, prompt, imageSize, format, opts) {
  return rateLimited('fal', async () => {
    log.info('Generating fal.ai image', { model, format, prompt: prompt?.slice(0, 100) });

    const payload = {
      prompt,
      image_size: imageSize,
      num_images: 1,
      enable_safety_checker: true,
      output_format: 'jpeg',
      ...(model.includes('schnell') ? {} : { guidance_scale: 3.5 }),
    };

    const response = await axios.post(
      `${FAL_BASE}/${model}`,
      payload,
      { headers: getHeaders(), timeout: 90000 },
    );

    const image = response.data?.images?.[0];
    if (!image?.url) throw new Error(`No image URL returned from fal.ai (${model})`);

    const cost = MODEL_COSTS[model] || 4.0;
    recordCost({
      platform: 'fal',
      model,
      workflow: opts.workflow || 'creative-generation',
      clientId: opts.clientId,
      costCentsOverride: cost,
      metadata: { format },
    });

    log.info('fal.ai image generated', { model, format, url: image.url?.slice(0, 80) });
    return {
      url: image.url,
      format,
      dimensions: { ...imageSize, label: FORMAT_LABELS[format] || format },
      provider: 'fal',
      model,
    };
  });
}

/**
 * Generate an image using fal.ai — races Flux Schnell (fast, ~5s) vs
 * Flux Pro (higher quality, ~15-30s). Returns whichever finishes first.
 * If both fail, throws the last error for fallback to next provider.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Image generation prompt
 * @param {string} opts.format - Ad format key (default: 'general')
 * @param {string} opts.model - Force a specific model (skips racing)
 * @param {string} opts.workflow - Workflow name for cost tracking
 * @param {string} opts.clientId - Client ID for cost tracking
 * @returns {object} { url, format, dimensions, provider }
 */
export async function generateImage(opts = {}) {
  if (!isConfigured()) throw new Error('FAL_API_KEY not configured');

  const format = opts.format || 'general';
  const imageSize = FORMAT_SIZE_MAP[format] || FORMAT_SIZE_MAP.general;

  // If a specific model is requested, use it directly
  if (opts.model) {
    return callFalModel(opts.model, opts.prompt, imageSize, format, opts);
  }

  // Race Flux Schnell (fast, ~5s) vs Flux Pro (quality, ~15-30s)
  // Promise.any returns the FIRST to resolve — true racing
  const models = ['fal-ai/flux/schnell', 'fal-ai/flux-pro/v1.1'];
  try {
    return await Promise.any(
      models.map(model => callFalModel(model, opts.prompt, imageSize, format, opts))
    );
  } catch (aggError) {
    // AggregateError — all models failed
    const firstError = aggError.errors?.[0];
    throw firstError || new Error('All fal.ai models failed');
  }
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
      const formatPrompt = `${opts.prompt}. This is a ${FORMAT_LABELS[format] || format} ad creative. Professional advertising quality, clean composition. No text, no words, no letters, no typography, no captions. Clean background visual only. Space for text overlay at the bottom third.`;

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

/**
 * Generate an image using a specific fal.ai model (no racing).
 * Used by the multi-candidate router to get distinct candidates from different models.
 */
export async function generateImageWithModel(model, opts = {}) {
  if (!isConfigured()) throw new Error('FAL_API_KEY not configured');
  const format = opts.format || 'general';
  const imageSize = FORMAT_SIZE_MAP[format] || FORMAT_SIZE_MAP.general;
  return callFalModel(model, opts.prompt, imageSize, format, opts);
}

/**
 * List available fal.ai model keys for multi-candidate generation.
 */
export const FAL_MODELS = {
  fluxSchnell:  'fal-ai/flux/schnell',
  fluxPro:      'fal-ai/flux-pro/v1.1',
};

// ============================================================
// Kling Video Generation via fal.ai (image-to-video)
// ============================================================

const KLING_VIDEO_MODEL = 'fal-ai/kling-video/v2/master/image-to-video';
const KLING_VIDEO_COST_CENTS = 20; // ~$0.20 per video via fal.ai

/**
 * Generate a video from a static image using Kling AI via fal.ai.
 * Uses the queue API for long-running video generation.
 *
 * @param {object} opts
 * @param {string} opts.imageUrl - URL of the source image
 * @param {string} opts.prompt - Motion/animation prompt
 * @param {number} opts.duration - Duration in seconds (5 or 10, default: 5)
 * @param {string} opts.aspectRatio - '9:16', '16:9', '1:1' (default: '9:16')
 * @param {string} opts.workflow - Workflow name for cost tracking
 * @param {string} opts.clientId - Client ID for cost tracking
 * @returns {object} { videoUrl, id, status, duration, aspectRatio }
 */
export async function generateVideoFromImage(opts = {}) {
  if (!isConfigured()) throw new Error('FAL_API_KEY not configured');

  const {
    imageUrl,
    prompt,
    duration = 5,
    aspectRatio = '9:16',
    workflow = 'video-generation',
    clientId,
  } = opts;

  if (!imageUrl) throw new Error('imageUrl is required');
  if (!prompt) throw new Error('prompt is required');

  log.info('Starting Kling video via fal.ai', {
    model: KLING_VIDEO_MODEL,
    imageUrl: imageUrl.slice(0, 80),
    prompt: prompt.slice(0, 100),
    duration,
    aspectRatio,
  });

  // Step 1: Submit to fal.ai queue
  const submitResponse = await rateLimited('fal', async () => {
    return axios.post(
      `${FAL_QUEUE}/${KLING_VIDEO_MODEL}`,
      {
        image_url: imageUrl,
        prompt,
        duration: String(duration),
        aspect_ratio: aspectRatio,
      },
      { headers: getHeaders(), timeout: 30000 },
    );
  });

  const requestId = submitResponse.data?.request_id;
  if (!requestId) {
    log.error('fal.ai Kling did not return request_id', { response: JSON.stringify(submitResponse.data).slice(0, 300) });
    throw new Error('fal.ai Kling did not return a request ID');
  }

  log.info('fal.ai Kling video queued', { requestId });

  // Step 2: Poll for completion
  const POLL_INTERVAL_MS = 5000;
  const MAX_WAIT_MS = 180000; // 3 minutes
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const elapsed = Math.round((Date.now() - startTime) / 1000);

    try {
      const statusResponse = await axios.get(
        `${FAL_QUEUE}/${KLING_VIDEO_MODEL}/requests/${requestId}/status`,
        { headers: getHeaders(), timeout: 15000 },
      );

      const status = statusResponse.data?.status;
      log.info('fal.ai Kling polling', { requestId, status, elapsed: `${elapsed}s` });

      if (status === 'COMPLETED') {
        // Fetch result
        const resultResponse = await axios.get(
          `${FAL_QUEUE}/${KLING_VIDEO_MODEL}/requests/${requestId}`,
          { headers: getHeaders(), timeout: 15000 },
        );

        const videoUrl = resultResponse.data?.video?.url;
        if (!videoUrl) {
          throw new Error('fal.ai Kling completed but no video URL returned');
        }

        recordCost({
          platform: 'fal',
          model: KLING_VIDEO_MODEL,
          workflow,
          clientId,
          costCentsOverride: KLING_VIDEO_COST_CENTS,
          metadata: { duration, aspectRatio, requestId },
        });

        log.info('fal.ai Kling video generated', { requestId, videoUrl: videoUrl.slice(0, 80), elapsed: `${elapsed}s` });

        return {
          videoUrl,
          id: requestId,
          status: 'completed',
          duration,
          aspectRatio,
          provider: 'fal-kling',
        };
      }

      if (status === 'FAILED') {
        const errorMsg = statusResponse.data?.error || 'Unknown error';
        log.error('fal.ai Kling video failed', { requestId, error: errorMsg });
        throw new Error(`fal.ai Kling video generation failed: ${errorMsg}`);
      }

      // IN_QUEUE or IN_PROGRESS — keep polling
    } catch (e) {
      if (e.message.includes('failed') || e.message.includes('FAILED')) throw e;
      log.warn('fal.ai Kling poll error, retrying', { error: e.message, elapsed: `${elapsed}s` });
    }
  }

  throw new Error(`fal.ai Kling video generation timed out after ${MAX_WAIT_MS / 1000}s`);
}

export default { generateImage, generateImageWithModel, generateAdImages, generateVideoFromImage, isConfigured, FAL_MODELS };
