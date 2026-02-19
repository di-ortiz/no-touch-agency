import Anthropic from '@anthropic-ai/sdk';
import config from '../config.js';
import logger from '../utils/logger.js';
import { recordCost } from '../services/cost-tracker.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'anthropic' });

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/**
 * Send a message to Claude and return the response.
 * Tracks cost and applies rate limiting and retry logic.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt - System prompt
 * @param {string} opts.userMessage - User message
 * @param {string} opts.model - Model to use (default: claude-haiku-4-5-20251001)
 * @param {number} opts.maxTokens - Max tokens (default: 4096)
 * @param {string} opts.workflow - Workflow name for cost tracking
 * @param {string} opts.clientId - Client ID for cost tracking
 * @param {Array} opts.tools - Tool definitions for tool use
 */
const CLAUDE_API_TIMEOUT_MS = 90_000; // 90s timeout per API call (includes retries)

export async function askClaude({
  systemPrompt,
  userMessage,
  model = 'claude-haiku-4-5-20251001',
  maxTokens = 4096,
  workflow,
  clientId,
  tools,
  messages,
}) {
  return Promise.race([
    rateLimited('anthropic', async () => {
      return retry(async () => {
        const params = {
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: messages || [{ role: 'user', content: userMessage }],
        };

        if (tools) {
          params.tools = tools;
        }

        const response = await client.messages.create(params);

        const inputTokens = response.usage?.input_tokens || 0;
        const outputTokens = response.usage?.output_tokens || 0;

        recordCost({
          platform: 'anthropic',
          model,
          workflow,
          clientId,
          inputTokens,
          outputTokens,
        });

        log.debug('Claude response', {
          model,
          inputTokens,
          outputTokens,
          stopReason: response.stop_reason,
        });

        // Extract text content
        const textBlocks = response.content.filter(b => b.type === 'text');
        const text = textBlocks.map(b => b.text).join('\n');

        // Extract tool use blocks
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

        return {
          text,
          toolUse: toolUseBlocks,
          stopReason: response.stop_reason,
          usage: { inputTokens, outputTokens },
          raw: response,
        };
      }, {
        retries: 3,
        label: 'Claude API call',
        shouldRetry: isRetryableHttpError,
      });
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Claude API call timed out after ${CLAUDE_API_TIMEOUT_MS / 1000}s`)), CLAUDE_API_TIMEOUT_MS)
    ),
  ]);
}

/**
 * Convenience: quick analysis using Haiku (fast/cheap) for simple tasks.
 */
export async function quickAnalysis({ prompt, workflow, clientId }) {
  return askClaude({
    systemPrompt: 'You are a PPC advertising analyst. Be concise and data-driven.',
    userMessage: prompt,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
    workflow,
    clientId,
  });
}

/**
 * Deep analysis using Sonnet for complex strategic tasks.
 */
export async function deepAnalysis({ systemPrompt, prompt, workflow, clientId }) {
  return askClaude({
    systemPrompt: systemPrompt || 'You are a senior PPC strategist with 10+ years of experience managing large-scale campaigns across Meta, Google, and TikTok. Provide detailed, actionable analysis.',
    userMessage: prompt,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 8192,
    workflow,
    clientId,
  });
}

export default { askClaude, quickAnalysis, deepAnalysis };
