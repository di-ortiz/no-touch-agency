import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { recordCost } from '../services/cost-tracker.js';
import { rateLimited } from '../utils/rate-limiter.js';

const log = logger.child({ platform: 'kling' });

const KLING_BASE = 'https://api.klingai.com/v1';

function getHeaders() {
  return {
    Authorization: `Bearer ${config.KLING_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Check if Kling AI is configured.
 */
export function isConfigured() {
  return !!config.KLING_API_KEY;
}

/**
 * Generate a video from a static image using Kling AI.
 *
 * @param {object} opts
 * @param {string} opts.imageUrl - URL of the input image
 * @param {string} opts.prompt - Motion prompt describing desired animation
 * @param {number} opts.duration - Duration in seconds (default: 5)
 * @param {string} opts.aspectRatio - Aspect ratio: '9:16', '16:9', '1:1' (default: '9:16')
 * @param {string} opts.workflow - Workflow name for cost tracking
 * @param {string} opts.clientId - Client ID for cost tracking
 * @param {Function} opts.onProgress - Optional progress callback
 * @returns {object} { videoUrl, id, status, duration, aspectRatio }
 */
export async function generateVideoFromImage(opts = {}) {
  if (!isConfigured()) throw new Error('KLING_API_KEY not configured. Set it in Railway environment variables.');

  const {
    imageUrl,
    prompt,
    duration = 5,
    aspectRatio = '9:16',
    workflow = 'video-generation',
    clientId,
    onProgress,
  } = opts;

  if (!imageUrl) throw new Error('imageUrl is required for video generation');
  if (!prompt) throw new Error('prompt is required for video generation');

  log.info('Starting Kling AI video generation', {
    imageUrl: imageUrl.slice(0, 80),
    prompt: prompt.slice(0, 100),
    duration,
    aspectRatio,
  });

  // Step 1: Create the video generation task
  const createResponse = await rateLimited('kling', async () => {
    return axios.post(
      `${KLING_BASE}/videos/image2video`,
      {
        model_name: 'kling-v1',
        image: imageUrl,
        prompt,
        cfg_scale: 0.5,
        duration: String(duration),
        aspect_ratio: aspectRatio,
      },
      { headers: getHeaders(), timeout: 30000 },
    );
  });

  const taskId = createResponse.data?.data?.task_id;
  if (!taskId) {
    log.error('Kling AI did not return a task ID', { response: JSON.stringify(createResponse.data).slice(0, 300) });
    throw new Error('Kling AI did not return a task ID');
  }

  log.info('Kling AI task created', { taskId });

  // Step 2: Poll for completion
  const POLL_INTERVAL_MS = 5000;
  const MAX_WAIT_MS = 180000; // 3 minutes max
  const startTime = Date.now();
  let lastProgressUpdate = 0;

  while (Date.now() - startTime < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log.info('Kling AI polling', { taskId, elapsed: `${elapsed}s` });

    let statusResponse;
    try {
      statusResponse = await rateLimited('kling', async () => {
        return axios.get(
          `${KLING_BASE}/videos/image2video/${taskId}`,
          { headers: getHeaders(), timeout: 15000 },
        );
      });
    } catch (e) {
      log.warn('Kling AI poll request failed, retrying', { error: e.message });
      continue;
    }

    const taskData = statusResponse.data?.data;
    const status = taskData?.task_status;

    // Send progress updates every 15 seconds
    if (onProgress && Date.now() - lastProgressUpdate > 15000) {
      onProgress({ status, elapsed, taskId });
      lastProgressUpdate = Date.now();
    }

    if (status === 'succeed') {
      const videoUrl = taskData?.task_result?.videos?.[0]?.url;
      if (!videoUrl) {
        throw new Error('Kling AI task completed but no video URL returned');
      }

      // Track cost (~$0.14 per 5s video)
      const costCents = duration <= 5 ? 14 : 28;
      recordCost({
        platform: 'kling',
        model: 'kling-v1',
        workflow,
        clientId,
        costCentsOverride: costCents,
        metadata: { duration, aspectRatio, taskId },
      });

      log.info('Kling AI video generated', { taskId, videoUrl: videoUrl.slice(0, 80), elapsed: `${elapsed}s` });

      return {
        videoUrl,
        id: taskId,
        status: 'completed',
        duration,
        aspectRatio,
        prompt,
      };
    }

    if (status === 'failed') {
      const errorMsg = taskData?.task_status_msg || 'Unknown error';
      log.error('Kling AI task failed', { taskId, error: errorMsg });
      throw new Error(`Kling AI video generation failed: ${errorMsg}`);
    }

    // Still processing — continue polling
  }

  throw new Error(`Kling AI video generation timed out after ${MAX_WAIT_MS / 1000}s`);
}

/**
 * Generate a video from an image with brand-aware motion prompt.
 *
 * @param {object} opts
 * @param {string} opts.imageUrl - Source image URL
 * @param {object} opts.brandDNA - Brand DNA for context
 * @param {string} opts.userInstruction - User's description of desired motion
 * @param {string} opts.aspectRatio - '9:16', '16:9', or '1:1'
 * @param {string} opts.clientId - Client ID
 * @param {Function} opts.onProgress - Progress callback
 * @returns {object} Video generation result
 */
export async function generateBrandedVideo(opts = {}) {
  const { brandDNA, userInstruction, imageUrl, aspectRatio = '9:16', clientId, onProgress } = opts;

  // Build motion prompt from Brand DNA context
  const brandName = brandDNA?.business_name || 'the brand';
  const ctaStyle = brandDNA?.cta_style || 'professional';
  const audience = brandDNA?.target_audience || 'the target audience';

  const prompt = userInstruction
    ? `${userInstruction}. Smooth, professional motion for a ${ctaStyle} ad for ${brandName}. Target audience: ${audience}. Keep movement natural and attractive.`
    : `Animate this image naturally and attractively for a ${ctaStyle} ad for ${brandName}. Target audience: ${audience}. Keep movement smooth and professional.`;

  return generateVideoFromImage({
    imageUrl,
    prompt,
    duration: 5,
    aspectRatio,
    workflow: 'branded-video-generation',
    clientId,
    onProgress,
  });
}

export default { generateVideoFromImage, generateBrandedVideo, isConfigured };
