/**
 * Unified chat loop — runs the tool-use conversation loop for both
 * WhatsApp and Telegram, owner and client modes.
 * Eliminates 4x duplicated loop logic from the original monolith.
 */
import { askClaude } from '../api/anthropic.js';
import { sendWhatsApp } from '../api/whatsapp.js';
import { sendTelegram } from '../api/telegram.js';
import {
  sendThinkingIndicator, truncateToolResult, stripBinaryBuffers,
  deliverMediaInline, summarizeToolDeliverables, addToHistory,
  TOOL_PROGRESS_MESSAGES,
} from './helpers.js';
import { executeCSAToolWithTimeout } from './csa-tool-executor.js';
import logger from '../utils/logger.js';

const log = logger.child({ module: 'chat-loop' });

/**
 * Scan conversation messages (newest first) for the most recent uploaded image URL.
 * Returns the URL if found, or null.
 */
function extractLastUploadedImageUrl(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
        : '';
    const match = content.match(/\[SYSTEM: The uploaded image is available at this URL for tool use: (\S+)/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Run a conversational tool-use loop with Claude.
 *
 * @param {Object} options
 * @param {string} options.systemPrompt - System prompt for Claude
 * @param {Array}  options.messages - Conversation messages (mutated in place)
 * @param {Array}  options.tools - Tool definitions to provide
 * @param {string} options.channel - 'whatsapp' or 'telegram'
 * @param {string} options.chatId - Chat ID for sending messages
 * @param {string} options.historyKey - Key for saving to conversation history
 * @param {string} options.workflow - Workflow name for cost tracking
 * @param {Object} [options.clientContext] - Client context for auto-injecting clientName
 * @param {string} [options.contactName] - Contact name for logging
 * @returns {string} Final response text
 */
export async function runChatLoop({
  systemPrompt,
  messages,
  tools,
  channel,
  chatId,
  historyKey,
  workflow,
  clientContext,
  contactName,
}) {
  const send = channel === 'telegram'
    ? (msg) => sendTelegram(msg, chatId)
    : (msg) => sendWhatsApp(msg, chatId);

  let response = await askClaude({
    systemPrompt,
    messages,
    tools,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 4096,
    workflow,
  });

  let rounds = 0;
  const toolsSummary = [];
  const allToolResults = [];

  while (response.stopReason === 'tool_use' && rounds < 10) {
    rounds++;

    // Send text from every round so user always sees progress
    if (response.text) {
      await send(response.text);
    } else if (rounds >= 2) {
      await sendThinkingIndicator(channel, chatId, 'Still working on it...');
    }

    // Execute all tool calls
    const toolResults = [];
    for (const tool of response.toolUse) {
      log.info('Executing tool', { tool: tool.name, round: rounds, client: contactName });
      toolsSummary.push(tool.name);

      // Send progress message
      const progressMsg = TOOL_PROGRESS_MESSAGES[tool.name];
      if (progressMsg) {
        await sendThinkingIndicator(channel, chatId, progressMsg);
      }

      try {
        // Auto-inject clientName for client-facing tools
        if (clientContext?.clientId && tool.input) {
          tool.input.clientName = tool.input.clientName || clientContext.clientName || contactName;
        }

        // Auto-inject uploadedImageUrl for creative tools when user uploaded a photo
        if (tool.name === 'generate_ad_creative_with_text' && tool.input && !tool.input.uploadedImageUrl) {
          const lastImageUrl = extractLastUploadedImageUrl(messages);
          if (lastImageUrl) {
            tool.input.uploadedImageUrl = lastImageUrl;
            log.info('Auto-injected uploadedImageUrl from conversation history', { url: lastImageUrl.slice(0, 80) });
          }
        }

        const result = await executeCSAToolWithTimeout(tool.name, tool.input);
        const resultJson = truncateToolResult(JSON.stringify(result, stripBinaryBuffers));
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: resultJson });
        allToolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: resultJson });

        // Deliver generated media inline (images, videos, PDFs)
        await deliverMediaInline(tool.name, result, channel, chatId);
      } catch (e) {
        log.error('Tool execution failed', { tool: tool.name, error: e.message });
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify({ error: e.message }), is_error: true });
      }
    }

    // Continue conversation with tool results
    messages.push({ role: 'assistant', content: response.raw.content });
    messages.push({ role: 'user', content: toolResults });

    response = await askClaude({
      systemPrompt,
      messages,
      tools,
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 4096,
      workflow,
    });
  }

  // Build final text
  const finalText = response.text || (rounds > 0
    ? `I ran ${toolsSummary.length} steps (${[...new Set(toolsSummary)].join(', ')}). Let me know if you'd like me to go deeper on anything!`
    : 'I\'m here to help! What would you like to work on?');

  // Save rich tool context to history
  if (rounds > 0 && toolsSummary.length > 0) {
    const toolNames = `[Used tools: ${[...new Set(toolsSummary)].join(', ')}]`;
    const deliverables = summarizeToolDeliverables(allToolResults);
    const contextBlock = deliverables ? `${toolNames}\n${deliverables}` : toolNames;
    addToHistory(historyKey, 'assistant', `${contextBlock}\n${finalText}`, channel);
  } else {
    addToHistory(historyKey, 'assistant', finalText, channel);
  }

  return finalText;
}
