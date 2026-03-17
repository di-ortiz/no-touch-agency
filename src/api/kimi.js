import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';
import { recordCost } from '../services/cost-tracker.js';

const log = logger.child({ platform: 'kimi' });

const BASE_URL = 'https://api.moonshot.ai/v1';
const MODEL = 'kimi-k2-5';
const API_TIMEOUT_MS = 90_000;

/**
 * Check if Kimi API key is configured.
 */
export function isConfigured() {
  return !!config.KIMI_API_KEY;
}

/**
 * Call Kimi K2.5 for text generation (OpenAI-compatible API).
 * Significantly cheaper than Claude Haiku for bulk analysis tasks.
 *
 * Pricing: $0.60/M input tokens, $2.50/M output tokens
 * Context: 256K tokens, Max output: 65K tokens
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt - System prompt
 * @param {string} opts.userMessage - User message (or use messages array)
 * @param {Array} opts.messages - Array of {role, content} messages
 * @param {number} opts.maxTokens - Max output tokens (default: 4096)
 * @param {number} opts.temperature - Temperature 0-1 (default: 0.6)
 * @param {string} opts.workflow - Workflow name for cost tracking
 * @param {string} opts.clientId - Client ID for cost tracking
 * @returns {object} { text, usage: { inputTokens, outputTokens }, model }
 */
export async function askKimi({
  systemPrompt,
  userMessage,
  messages,
  maxTokens = 4096,
  temperature = 0.6,
  workflow,
  clientId,
}) {
  if (!isConfigured()) {
    throw new Error('KIMI_API_KEY is not configured');
  }

  const msgArray = messages || [{ role: 'user', content: userMessage }];
  const allMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...msgArray]
    : msgArray;

  return Promise.race([
    rateLimited('kimi', () =>
      retry(async () => {
        log.info('Calling Kimi K2.5', { workflow, messageCount: allMessages.length });

        const response = await axios.post(
          `${BASE_URL}/chat/completions`,
          {
            model: MODEL,
            messages: allMessages,
            max_tokens: maxTokens,
            temperature: Math.min(temperature, 1), // Kimi max temp is 1.0
            stream: false,
          },
          {
            headers: {
              'Authorization': `Bearer ${config.KIMI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            timeout: API_TIMEOUT_MS,
          }
        );

        const data = response.data;
        const choice = data.choices?.[0];
        const text = choice?.message?.content || '';
        const usage = data.usage || {};
        const inputTokens = usage.prompt_tokens || 0;
        const outputTokens = usage.completion_tokens || 0;

        // Track cost
        recordCost({
          platform: 'kimi',
          model: MODEL,
          workflow: workflow || 'kimi-generation',
          clientId,
          inputTokens,
          outputTokens,
        });

        log.info('Kimi response received', {
          workflow,
          inputTokens,
          outputTokens,
          textLength: text.length,
        });

        return {
          text,
          usage: { inputTokens, outputTokens },
          model: MODEL,
        };
      }, {
        retries: 2,
        label: 'Kimi API call',
        shouldRetry: isRetryableHttpError,
      })
    ),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Kimi API call timed out after ${API_TIMEOUT_MS / 1000}s`)), API_TIMEOUT_MS)
    ),
  ]);
}

/**
 * Analyze an image using Kimi K2.5 vision capabilities.
 * Kimi supports image URLs in message content.
 *
 * @param {object} opts
 * @param {string} opts.imageUrl - URL of image to analyze
 * @param {string} opts.prompt - Analysis prompt
 * @param {string} opts.workflow - Workflow name
 * @param {string} opts.clientId - Client ID
 * @returns {object} { analysis, usage, model }
 */
export async function analyzeImage({
  imageUrl,
  prompt = 'Analyze this image in detail. Describe the composition, colors, style, mood, text, and any marketing elements.',
  workflow,
  clientId,
}) {
  if (!isConfigured()) {
    throw new Error('KIMI_API_KEY is not configured');
  }

  const response = await askKimi({
    systemPrompt: 'You are an expert visual analyst specializing in advertising and marketing creatives. Analyze images for composition, color palette, typography, messaging, mood, and actionable creative insights.',
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        { type: 'text', text: prompt },
      ],
    }],
    maxTokens: 2048,
    workflow: workflow || 'kimi-visual-analysis',
    clientId,
  });

  return {
    analysis: response.text,
    usage: response.usage,
    model: response.model,
  };
}

/**
 * Quick text generation using Kimi — cheaper alternative to Claude for
 * bulk tasks like ad copy, content analysis, SEO recommendations.
 *
 * Cost comparison (per 1K tokens):
 *   Kimi K2.5:  $0.0006 input / $0.0025 output
 *   Claude Haiku: $0.0008 input / $0.004 output
 *   → Kimi is ~25% cheaper on input, ~37% cheaper on output
 *
 * @param {string} prompt - User prompt
 * @param {string} systemPrompt - System prompt (optional)
 * @param {object} opts - Additional options
 */
export async function quickGenerate(prompt, systemPrompt, opts = {}) {
  return askKimi({
    systemPrompt: systemPrompt || 'You are a helpful assistant specializing in digital marketing, PPC advertising, and SEO.',
    userMessage: prompt,
    maxTokens: opts.maxTokens || 2048,
    temperature: opts.temperature || 0.7,
    workflow: opts.workflow || 'kimi-quick',
    clientId: opts.clientId,
  });
}

export default {
  isConfigured,
  askKimi,
  analyzeImage,
  quickGenerate,
};
