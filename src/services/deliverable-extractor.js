import { askClaude } from '../api/anthropic.js';
import { createDeliverable, getTeamMemberByEmail, searchTeamMembers, logIngestion } from './team-task-tracker.js';
import logger from '../utils/logger.js';

const log = logger.child({ workflow: 'deliverable-extractor' });

const EXTRACTION_SYSTEM_PROMPT = `You are a task extraction assistant. Your job is to identify specific deliverables, action items, and commitments that people owe to the user (Diego, the business owner).

IMPORTANT: Only extract items where SOMEONE ELSE owes something TO Diego (the user). Do NOT extract:
- Things Diego needs to do himself
- Vague references without clear deliverables
- Already-completed items mentioned in past tense

For each deliverable found, output a JSON array. Each item must have:
- "title": Short, clear description of what is owed (max 80 chars)
- "description": Fuller context of what was agreed upon, including any specifications
- "assignee_name": The person's name who owes this deliverable
- "assignee_email": Their email if mentioned (null otherwise)
- "due_date": ISO date string if a deadline was mentioned (null otherwise). Use context clues like "by Friday", "end of month", "next week" to infer dates. Today's date will be provided.
- "priority": "high", "medium", or "low" based on urgency/importance signals
- "context_quote": The relevant quote or excerpt from the source that establishes this commitment

If no deliverables are found, return an empty array: []

Return ONLY valid JSON. No markdown, no explanations.`;

/**
 * Extract deliverables from arbitrary text using Claude AI.
 * @param {string} text - The source text (email, transcript, chat, notes)
 * @param {object} opts
 * @param {string} opts.sourceType - Type: 'email', 'transcript', 'whatsapp', 'manual', 'drive_doc'
 * @param {string} opts.sourceId - Unique ID of the source (email ID, file ID, etc.)
 * @param {string} opts.sourceLabel - Human-readable label ("Meeting with John 2/15")
 * @param {boolean} opts.autoCreate - Whether to auto-create deliverables (default: true)
 * @param {string} opts.todayDate - Today's date in ISO format
 * @returns {Array} Extracted deliverables
 */
export async function extractDeliverables(text, opts = {}) {
  const {
    sourceType = 'manual',
    sourceId,
    sourceLabel,
    autoCreate = true,
    todayDate = new Date().toISOString().split('T')[0],
  } = opts;

  if (!text || text.trim().length < 10) {
    log.warn('Text too short for extraction', { length: text?.length });
    return [];
  }

  // Truncate very long texts to avoid token limits
  const truncated = text.length > 15000 ? text.substring(0, 15000) + '\n\n[...truncated...]' : text;

  try {
    const response = await askClaude({
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      userMessage: `Today's date: ${todayDate}\nSource type: ${sourceType}\nSource: ${sourceLabel || 'Unknown'}\n\n--- BEGIN TEXT ---\n${truncated}\n--- END TEXT ---`,
      maxTokens: 4096,
      workflow: 'deliverable-extraction',
    });

    let items;
    try {
      // Try to parse the response as JSON — handle markdown code fences
      let jsonText = response.text.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      items = JSON.parse(jsonText);
    } catch (parseErr) {
      log.error('Failed to parse extraction response', { error: parseErr.message, raw: response.text.substring(0, 500) });
      return [];
    }

    if (!Array.isArray(items)) {
      log.warn('Extraction result is not an array', { type: typeof items });
      return [];
    }

    log.info('Extracted deliverables', { count: items.length, sourceType, sourceLabel });

    // Log the ingestion
    logIngestion({
      sourceType,
      sourceId,
      sourceLabel,
      rawText: truncated.substring(0, 5000),
      extractedCount: items.length,
    });

    if (!autoCreate) return items;

    // Auto-create deliverables in the database
    const created = [];
    for (const item of items) {
      try {
        // Try to match assignee by name or email
        let teamMember = null;
        if (item.assignee_email) {
          teamMember = getTeamMemberByEmail(item.assignee_email);
        }
        if (!teamMember && item.assignee_name) {
          const matches = searchTeamMembers(item.assignee_name);
          if (matches.length === 1) {
            teamMember = matches[0];
          } else if (matches.length > 1) {
            // Pick the best name match
            const exact = matches.find(m => m.name.toLowerCase() === item.assignee_name.toLowerCase());
            teamMember = exact || matches[0];
          }
        }

        if (!teamMember) {
          log.warn('No matching team member for deliverable — skipping', {
            assigneeName: item.assignee_name,
            title: item.title,
          });
          // Store as unmatched for manual review
          created.push({
            ...item,
            _status: 'unmatched',
            _reason: `No team member found for "${item.assignee_name}"`,
          });
          continue;
        }

        const deliverable = createDeliverable({
          title: item.title,
          description: item.description,
          assignedTo: teamMember.id,
          dueDate: item.due_date || null,
          priority: item.priority || 'medium',
          sourceType,
          sourceId,
          sourceSummary: item.context_quote || sourceLabel,
          contextNotes: item.description,
        });

        created.push({ ...deliverable, _status: 'created' });
      } catch (err) {
        log.error('Failed to create deliverable', { title: item.title, error: err.message });
        created.push({ ...item, _status: 'error', _reason: err.message });
      }
    }

    return created;
  } catch (err) {
    log.error('Extraction failed', { error: err.message, sourceType });
    throw err;
  }
}

/**
 * Extract deliverables from an email.
 */
export async function extractFromEmail({ subject, from, body, emailId, date }) {
  const text = `Email from: ${from}\nSubject: ${subject}\nDate: ${date || 'unknown'}\n\n${body}`;
  return extractDeliverables(text, {
    sourceType: 'email',
    sourceId: emailId,
    sourceLabel: `Email: "${subject}" from ${from}`,
  });
}

/**
 * Extract deliverables from a meeting transcript.
 */
export async function extractFromTranscript({ title, transcript, fileId, meetingDate }) {
  const text = `Meeting: ${title}\nDate: ${meetingDate || 'unknown'}\n\n${transcript}`;
  return extractDeliverables(text, {
    sourceType: 'transcript',
    sourceId: fileId,
    sourceLabel: `Meeting: "${title}"`,
  });
}

/**
 * Extract deliverables from a WhatsApp conversation excerpt.
 */
export async function extractFromWhatsApp({ contactName, messages }) {
  const text = messages.map(m => `${m.from || 'Unknown'}: ${m.content}`).join('\n');
  return extractDeliverables(text, {
    sourceType: 'whatsapp',
    sourceLabel: `WhatsApp conversation with ${contactName}`,
  });
}

export default { extractDeliverables, extractFromEmail, extractFromTranscript, extractFromWhatsApp };
