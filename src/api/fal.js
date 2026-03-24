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

// ============================================================
// Format Maps
// ============================================================

// Map ad format keys → fal.ai image_size presets
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

// Map format → aspect ratio string (for models that use aspect ratio instead of pixel dims)
const FORMAT_ASPECT_MAP = {
  meta_feed:       '16:9',
  meta_square:     '1:1',
  meta_story:      '9:16',
  instagram_feed:  '1:1',
  instagram_story: '9:16',
  google_display:  '16:9',
  google_square:   '1:1',
  tiktok:          '9:16',
  general:         '1:1',
};

// ============================================================
// Model Registry
// ============================================================

/**
 * IMAGE MODELS
 *
 * draft    → flux/schnell       Fast, cheap. Good for previews. ~$0.003/image
 * standard → flux-pro/v1.1      Quality baseline for client deliverables. ~$0.04/image
 * premium  → nano-banana-2      Google's latest. Best quality + speed. ~$0.01/image
 * premium+ → flux-2-flex        Best typography rendering. ~$0.04/image
 *
 * EDITING MODELS (require a source imageUrl)
 * edit     → nano-banana-pro    Edit existing image via prompt. ~$0.04/image
 * edit     → flux-pro/kontext   Natural-language image editing. ~$0.04/image
 */
export const FAL_MODELS = {
  // Text-to-image
  fluxSchnell:    'fal-ai/flux/schnell',           // draft: fast, cheap
  fluxPro:        'fal-ai/flux-pro/v1.1',          // standard: quality
  nanoBanana2:    'fal-ai/nano-banana-2',           // premium: Google's latest — 4x faster, better quality
  flux2Flex:      'fal-ai/flux-2-flex',             // premium+: best text rendering

  // Image editing (requires source image)
  nanoProEdit:    'fal-ai/nano-banana-pro/edit',    // edit mode: modify existing images
  fluxKontext:    'fal-ai/flux-pro/kontext',        // edit mode: natural-language editing

  // Video (image-to-video)
  klingV3Pro:     'fal-ai/kling-video/v3/pro/image-to-video',        // standard video
  klingO3:        'fal-ai/kling-video/o3/standard/image-to-video',   // start+end frame video
  ltx23:          'fal-ai/ltx-2.3/image-to-video',                   // draft: fast + cheap
  veo31:          'fal-ai/veo3.1/reference-to-video',                // premium: best quality

  // Utility
  bgRemoval:      'fal-ai/birefnet',                // background removal
  tts:            'fal-ai/elevenlabs/tts/multilingual-v2', // Portuguese voiceovers
};

// Cost map in cents
const MODEL_COSTS = {
  'fal-ai/flux/schnell':                              0.3,   // ~$0.003
  'fal-ai/flux-pro/v1.1':                             4.0,   // ~$0.04
  'fal-ai/nano-banana-2':                             1.0,   // ~$0.01
  'fal-ai/flux-2-flex':                               4.0,   // ~$0.04
  'fal-ai/nano-banana-pro/edit':                      4.0,   // ~$0.04
  'fal-ai/flux-pro/kontext':                          4.0,   // ~$0.04
  'fal-ai/kling-video/v3/pro/image-to-video':        28.0,   // ~$0.28 per 5s
  'fal-ai/kling-video/o3/standard/image-to-video':   28.0,   // ~$0.28
  'fal-ai/ltx-2.3/image-to-video':                    5.0,   // ~$0.05 (fast + cheap)
  'fal-ai/veo3.1/reference-to-video':                50.0,   // ~$0.50 (premium)
  'fal-ai/birefnet':                                   0.2,  // ~$0.002
  'fal-ai/elevenlabs/tts/multilingual-v2':            30.0,  // ~$0.30
};

// ============================================================
// Shared Queue Polling Helper
// ============================================================

/**
 * Submit a job to the fal.ai queue and poll until complete.
 * Used by all video + utility models that require async processing.
 *
 * @param {string} model - fal.ai model ID
 * @param {object} payload - Request payload
 * @param {object} opts - { workflow, clientId, maxWaitMs, pollIntervalMs, resultKey }
 * @returns {object} Full result data from fal.ai
 */
async function submitAndPoll(model, payload, opts = {}) {
  const {
    workflow = 'fal-generation',
    clientId,
    maxWaitMs = 240000,   // 4 minutes default
    pollIntervalMs = 5000,
    resultKey = null,      // top-level key to extract from result (e.g. 'video', 'image')
  } = opts;

  // Step 1: Submit to queue
  const submitResponse = await rateLimited('fal', async () => {
    return axios.post(
      `${FAL_QUEUE}/${model}`,
      payload,
      { headers: getHeaders(), timeout: 30000 },
    );
  });

  const requestId = submitResponse.data?.request_id;
  if (!requestId) {
    log.error('fal.ai did not return request_id', {
      model,
      response: JSON.stringify(submitResponse.data).slice(0, 300),
    });
    throw new Error(`fal.ai ${model} did not return a request ID`);
  }

  log.info('fal.ai job queued', { model, requestId });

  // Step 2: Poll for completion
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    try {
      const statusResponse = await axios.get(
        `${FAL_QUEUE}/${model}/requests/${requestId}/status`,
        { headers: getHeaders(), timeout: 15000 },
      );

      const status = statusResponse.data?.status;
      log.info('fal.ai polling', { model, requestId, status, elapsed: `${elapsed}s` });

      if (status === 'COMPLETED') {
        const resultResponse = await axios.get(
          `${FAL_QUEUE}/${model}/requests/${requestId}`,
          { headers: getHeaders(), timeout: 15000 },
        );

        const data = resultResponse.data;

        const cost = MODEL_COSTS[model] || 10.0;
        recordCost({
          platform: 'fal',
          model,
          workflow,
          clientId,
          costCentsOverride: cost,
          metadata: { requestId },
        });

        log.info('fal.ai job completed', { model, requestId, elapsed: `${elapsed}s` });
        return resultKey ? data?.[resultKey] : data;
      }

      if (status === 'FAILED') {
        const errorMsg = statusResponse.data?.error || 'Unknown error';
        log.error('fal.ai job failed', { model, requestId, error: errorMsg });
        throw new Error(`fal.ai ${model} failed: ${errorMsg}`);
      }

      // IN_QUEUE or IN_PROGRESS — keep polling
    } catch (e) {
      if (e.message.includes('failed') || e.message.includes('FAILED')) throw e;
      log.warn('fal.ai poll error, retrying', { model, error: e.message, elapsed: `${elapsed}s` });
    }
  }

  throw new Error(`fal.ai ${model} timed out after ${maxWaitMs / 1000}s`);
}

// ============================================================
// IMAGE GENERATION — Text to Image
// ============================================================

/**
 * Build the correct payload per model.
 * Each model has slightly different param names/shapes.
 */
function buildImagePayload(model, prompt, imageSize) {
  const base = {
    prompt,
    num_images: 1,
    enable_safety_checker: true,
    output_format: 'jpeg',
  };

  switch (model) {
    case 'fal-ai/flux/schnell':
      return {
        ...base,
        image_size: imageSize,
        num_inference_steps: 4,   // schnell is optimised for 1-4 steps
      };

    case 'fal-ai/flux-pro/v1.1':
      return {
        ...base,
        image_size: imageSize,
        guidance_scale: 3.5,
        num_inference_steps: 28,
        safety_tolerance: '2',
      };

    case 'fal-ai/nano-banana-2':
      return {
        ...base,
        image_size: imageSize,
        guidance_scale: 5.0,
        num_inference_steps: 20,  // nano-banana is optimised for speed at 20 steps
      };

    case 'fal-ai/flux-2-flex':
      return {
        ...base,
        image_size: imageSize,
        guidance_scale: 3.5,
        num_inference_steps: 28,
      };

    default:
      return {
        ...base,
        image_size: imageSize,
        guidance_scale: 3.5,
        num_inference_steps: 28,
      };
  }
}

/**
 * Call a single fal.ai text-to-image model synchronously.
 */
async function callFalModel(model, prompt, imageSize, format, opts) {
  return rateLimited('fal', async () => {
    log.info('Generating fal.ai image', { model, format, prompt: prompt?.slice(0, 100) });

    const payload = buildImagePayload(model, prompt, imageSize);

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
 * Generate an image using fal.ai.
 *
 * Modes:
 *   draft    → flux/schnell       (~$0.003, ~3s)   — quick previews
 *   standard → flux-pro/v1.1      (~$0.04, ~15s)   — DEFAULT, client deliverables
 *   premium  → nano-banana-2      (~$0.01, ~8s)    — Google's latest, best quality/cost ratio
 *   premium+ → flux-2-flex        (~$0.04, ~15s)   — best when ad copy needs text rendering
 *
 * @param {object} opts
 * @param {string} opts.prompt       - Image generation prompt
 * @param {string} opts.format       - Ad format key (default: 'general')
 * @param {string} opts.mode         - 'draft' | 'standard' | 'premium' | 'premium+' (default: 'standard')
 * @param {string} opts.model        - Force a specific model ID (overrides mode)
 * @param {string} opts.workflow     - Workflow name for cost tracking
 * @param {string} opts.clientId     - Client ID for cost tracking
 * @returns {object} { url, format, dimensions, provider, model }
 */
export async function generateImage(opts = {}) {
  if (!isConfigured()) throw new Error('FAL_API_KEY not configured');

  const format = opts.format || 'general';
  const imageSize = FORMAT_SIZE_MAP[format] || FORMAT_SIZE_MAP.general;

  // Explicit model override
  if (opts.model) {
    return callFalModel(opts.model, opts.prompt, imageSize, format, opts);
  }

  // Mode-based model selection — quality-first, not speed-first
  const modeModelMap = {
    draft:      'fal-ai/flux/schnell',
    standard:   'fal-ai/flux-pro/v1.1',
    premium:    'fal-ai/nano-banana-2',
    'premium+': 'fal-ai/flux-2-flex',
  };

  const mode = opts.mode || 'standard';
  const selectedModel = modeModelMap[mode] || modeModelMap.standard;

  log.info('fal.ai image generation', { mode, model: selectedModel, format });
  return callFalModel(selectedModel, opts.prompt, imageSize, format, opts);
}

/**
 * Generate ad images for multiple platform formats.
 *
 * @param {object} opts
 * @param {string} opts.prompt    - Base prompt
 * @param {string} opts.platform  - 'meta' | 'instagram' | 'google' | 'tiktok'
 * @param {string} opts.mode      - 'draft' | 'standard' | 'premium' | 'premium+'
 * @param {string[]} opts.formats - Override specific formats
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
      const formatPrompt = `${opts.prompt}. ${FORMAT_LABELS[format] || format} ad creative. Professional advertising quality, clean composition. No text, no words, no letters, no typography. Clean background visual only. Leave space at the bottom third for text overlay.`;

      const image = await generateImage({ ...opts, prompt: formatPrompt, format });
      results.push(image);
    } catch (e) {
      log.error(`fal.ai failed for format ${format}`, { error: e.message });
      results.push({ format, error: e.message, provider: 'fal' });
    }
  }

  return results;
}

/**
 * Generate an image using a specific fal.ai model (no mode logic).
 * Used by the multi-candidate router.
 */
export async function generateImageWithModel(model, opts = {}) {
  if (!isConfigured()) throw new Error('FAL_API_KEY not configured');
  const format = opts.format || 'general';
  const imageSize = FORMAT_SIZE_MAP[format] || FORMAT_SIZE_MAP.general;
  return callFalModel(model, opts.prompt, imageSize, format, opts);
}

// ============================================================
// IMAGE EDITING — Modify existing images via prompt
// ============================================================

/**
 * Edit an existing image using a text prompt.
 * Use this when a client uploads a photo and wants modifications.
 *
 * Models:
 *   nano-banana-pro → general editing, style changes, background swaps
 *   flux-pro/kontext → precise natural-language edits ("change shirt to red")
 *
 * @param {object} opts
 * @param {string} opts.imageUrl    - Source image URL (must be public HTTPS)
 * @param {string} opts.prompt      - Edit instruction ("make the background a sunny beach")
 * @param {string} opts.model       - 'nano-banana-pro' | 'flux-kontext' (default: 'nano-banana-pro')
 * @param {string} opts.format      - Ad format key (default: 'general')
 * @param {string} opts.workflow    - Workflow name
 * @param {string} opts.clientId    - Client ID
 * @returns {object} { url, format, dimensions, provider, model }
 */
export async function editImage(opts = {}) {
  if (!isConfigured()) throw new Error('FAL_API_KEY not configured');
  if (!opts.imageUrl) throw new Error('imageUrl is required for image editing');
  if (!opts.prompt) throw new Error('prompt (edit instruction) is required');

  const format = opts.format || 'general';
  const imageSize = FORMAT_SIZE_MAP[format] || FORMAT_SIZE_MAP.general;

  const modelMap = {
    'nano-banana-pro': 'fal-ai/nano-banana-pro/edit',
    'flux-kontext':    'fal-ai/flux-pro/kontext',
  };
  const model = modelMap[opts.model] || modelMap['nano-banana-pro'];

  log.info('fal.ai image editing', { model, format, prompt: opts.prompt?.slice(0, 100) });

  return rateLimited('fal', async () => {
    const response = await axios.post(
      `${FAL_BASE}/${model}`,
      {
        prompt: opts.prompt,
        image_url: opts.imageUrl,
        image_size: imageSize,
        num_images: 1,
        output_format: 'jpeg',
      },
      { headers: getHeaders(), timeout: 90000 },
    );

    const image = response.data?.images?.[0];
    if (!image?.url) throw new Error(`No image URL returned from fal.ai edit (${model})`);

    const cost = MODEL_COSTS[model] || 4.0;
    recordCost({
      platform: 'fal',
      model,
      workflow: opts.workflow || 'image-editing',
      clientId: opts.clientId,
      costCentsOverride: cost,
      metadata: { format },
    });

    log.info('fal.ai image edit complete', { model, format });
    return {
      url: image.url,
      format,
      dimensions: { ...imageSize, label: FORMAT_LABELS[format] || format },
      provider: 'fal',
      model,
    };
  });
}

// ============================================================
// VIDEO GENERATION — Image to Video
// ============================================================

/**
 * Generate a video from a static image.
 *
 * Modes:
 *   draft    → LTX-2.3          (~$0.05, ~30s)   — quick client previews
 *   standard → Kling v3 Pro     (~$0.28, ~90s)   — DEFAULT, client deliverables
 *   premium  → Veo 3.1          (~$0.50, ~120s)  — best quality, use for hero videos
 *
 * @param {object} opts
 * @param {string} opts.imageUrl    - Public HTTPS URL of source image (required)
 * @param {string} opts.prompt      - Motion/animation description (required)
 * @param {number} opts.duration    - Duration in seconds (default: 5)
 * @param {string} opts.aspectRatio - '9:16' | '16:9' | '1:1' (default: '9:16')
 * @param {string} opts.mode        - 'draft' | 'standard' | 'premium' (default: 'standard')
 * @param {string} opts.model       - Force a specific model ID (overrides mode)
 * @param {string} opts.workflow    - Workflow name for cost tracking
 * @param {string} opts.clientId    - Client ID
 * @returns {object} { videoUrl, id, status, duration, aspectRatio, provider, model }
 */
export async function generateVideoFromImage(opts = {}) {
  if (!isConfigured()) throw new Error('FAL_API_KEY not configured');
  if (!opts.imageUrl) throw new Error('imageUrl is required');
  if (!opts.prompt) throw new Error('prompt is required');

  const {
    imageUrl,
    prompt,
    duration = 5,
    aspectRatio = '9:16',
    workflow = 'video-generation',
    clientId,
  } = opts;

  // Model selection
  const modeModelMap = {
    draft:    FAL_MODELS.ltx23,       // fast, cheap
    standard: FAL_MODELS.klingV3Pro,  // default
    premium:  FAL_MODELS.veo31,       // best quality
  };
  const mode = opts.mode || 'standard';
  const model = opts.model || modeModelMap[mode] || modeModelMap.standard;

  log.info('Starting fal.ai video generation', {
    model,
    mode,
    imageUrl: imageUrl.slice(0, 80),
    prompt: prompt.slice(0, 100),
    duration,
    aspectRatio,
  });

  // Build payload per model
  let payload;
  if (model === FAL_MODELS.veo31) {
    // Veo 3.1 uses 'reference_image_url' and 'aspect_ratio'
    payload = {
      reference_image_url: imageUrl,
      prompt,
      aspect_ratio: aspectRatio,
      duration_seconds: duration,
    };
  } else if (model === FAL_MODELS.ltx23) {
    // LTX-2.3 uses 'image_url' and 'aspect_ratio'
    payload = {
      image_url: imageUrl,
      prompt,
      aspect_ratio: aspectRatio,
      duration: String(duration),
    };
  } else {
    // Kling v3 Pro + Kling O3 — same shape
    payload = {
      image_url: imageUrl,
      prompt,
      duration: String(duration),
      aspect_ratio: aspectRatio,
    };
  }

  const resultData = await submitAndPoll(model, payload, {
    workflow,
    clientId,
    maxWaitMs: mode === 'premium' ? 300000 : 240000, // Veo gets 5 min, others 4 min
    pollIntervalMs: 5000,
  });

  // Extract video URL — each model has a slightly different response shape
  const videoUrl =
    resultData?.video?.url ||          // Kling v3, LTX-2.3
    resultData?.video_url ||           // Veo 3.1
    resultData?.output?.video?.url;    // fallback

  if (!videoUrl) {
    log.error('fal.ai video complete but no URL found', {
      model,
      responseKeys: Object.keys(resultData || {}),
    });
    throw new Error(`fal.ai ${model} completed but returned no video URL`);
  }

  log.info('fal.ai video generated', { model, mode, videoUrl: videoUrl.slice(0, 80) });
  return {
    videoUrl,
    id: resultData?.request_id || null,
    status: 'completed',
    duration,
    aspectRatio,
    provider: 'fal',
    model,
    mode,
  };
}

/**
 * Generate a video using start frame + end frame animation (Kling O3 only).
 * Unique capability — animates the transition between two images.
 *
 * @param {object} opts
 * @param {string} opts.startImageUrl - URL of the first frame
 * @param {string} opts.endImageUrl   - URL of the last frame
 * @param {string} opts.prompt        - Style/scene guidance
 * @param {string} opts.aspectRatio   - '9:16' | '16:9' | '1:1'
 * @param {string} opts.workflow
 * @param {string} opts.clientId
 */
export async function generateVideoFromFrames(opts = {}) {
  if (!isConfigured()) throw new Error('FAL_API_KEY not configured');
  if (!opts.startImageUrl) throw new Error('startImageUrl is required');
  if (!opts.endImageUrl) throw new Error('endImageUrl is required');

  const model = FAL_MODELS.klingO3;

  log.info('Starting fal.ai Kling O3 frame-to-frame video', {
    startImageUrl: opts.startImageUrl.slice(0, 80),
    endImageUrl: opts.endImageUrl.slice(0, 80),
    prompt: opts.prompt?.slice(0, 100),
  });

  const payload = {
    start_image_url: opts.startImageUrl,
    end_image_url: opts.endImageUrl,
    prompt: opts.prompt || 'Smooth cinematic transition between frames',
    aspect_ratio: opts.aspectRatio || '9:16',
  };

  const resultData = await submitAndPoll(model, payload, {
    workflow: opts.workflow || 'frame-video-generation',
    clientId: opts.clientId,
    maxWaitMs: 240000,
  });

  const videoUrl = resultData?.video?.url || resultData?.video_url;
  if (!videoUrl) throw new Error('Kling O3 completed but returned no video URL');

  return {
    videoUrl,
    status: 'completed',
    aspectRatio: opts.aspectRatio || '9:16',
    provider: 'fal',
    model,
  };
}

// ============================================================
// UTILITY — Background Removal
// ============================================================

/**
 * Remove the background from an image.
 * Use before ad generation to isolate products/people from photos.
 *
 * @param {object} opts
 * @param {string} opts.imageUrl  - Public HTTPS URL of source image
 * @param {string} opts.workflow
 * @param {string} opts.clientId
 * @returns {object} { url, provider, model }
 */
export async function removeBackground(opts = {}) {
  if (!isConfigured()) throw new Error('FAL_API_KEY not configured');
  if (!opts.imageUrl) throw new Error('imageUrl is required');

  const model = FAL_MODELS.bgRemoval;

  log.info('fal.ai background removal', { imageUrl: opts.imageUrl.slice(0, 80) });

  return rateLimited('fal', async () => {
    const response = await axios.post(
      `${FAL_BASE}/${model}`,
      { image_url: opts.imageUrl },
      { headers: getHeaders(), timeout: 60000 },
    );

    const url = response.data?.image?.url || response.data?.output?.image?.url;
    if (!url) throw new Error('No URL returned from background removal');

    recordCost({
      platform: 'fal',
      model,
      workflow: opts.workflow || 'background-removal',
      clientId: opts.clientId,
      costCentsOverride: MODEL_COSTS[model] || 0.2,
    });

    log.info('fal.ai background removal complete');
    return { url, provider: 'fal', model };
  });
}

// ============================================================
// UTILITY — Text to Speech (Portuguese voiceovers)
// ============================================================

/**
 * Generate a voiceover audio file from text.
 * Supports Portuguese (Brazilian) for SOFIA's SMB clients.
 *
 * @param {object} opts
 * @param {string} opts.text       - Text to speak (required)
 * @param {string} opts.voiceId    - ElevenLabs voice ID (default: Rachel)
 * @param {string} opts.language   - Language code (default: 'pt' for Brazilian Portuguese)
 * @param {string} opts.workflow
 * @param {string} opts.clientId
 * @returns {object} { audioUrl, provider, model }
 */
export async function generateVoiceover(opts = {}) {
  if (!isConfigured()) throw new Error('FAL_API_KEY not configured');
  if (!opts.text) throw new Error('text is required');

  const model = FAL_MODELS.tts;

  log.info('fal.ai TTS voiceover', { language: opts.language || 'pt', textLength: opts.text.length });

  return rateLimited('fal', async () => {
    const response = await axios.post(
      `${FAL_BASE}/${model}`,
      {
        text: opts.text,
        voice_id: opts.voiceId || 'Rachel',
        language: opts.language || 'pt',
      },
      { headers: getHeaders(), timeout: 60000 },
    );

    const audioUrl = response.data?.audio?.url || response.data?.audio_url;
    if (!audioUrl) throw new Error('No audio URL returned from TTS');

    recordCost({
      platform: 'fal',
      model,
      workflow: opts.workflow || 'voiceover-generation',
      clientId: opts.clientId,
      costCentsOverride: MODEL_COSTS[model] || 30.0,
      metadata: { language: opts.language || 'pt', chars: opts.text.length },
    });

    log.info('fal.ai voiceover generated');
    return { audioUrl, provider: 'fal', model };
  });
}

// ============================================================
// Default Export
// ============================================================

export default {
  // Image
  generateImage,
  generateImageWithModel,
  generateAdImages,
  editImage,

  // Video
  generateVideoFromImage,
  generateVideoFromFrames,

  // Utility
  removeBackground,
  generateVoiceover,

  // Config
  isConfigured,
  FAL_MODELS,
  MODEL_COSTS,
  FORMAT_SIZE_MAP,
  FORMAT_LABELS,
};
