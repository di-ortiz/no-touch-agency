import axios from 'axios';
import { v4 as uuid } from 'uuid';
import config from '../config.js';
import logger from '../utils/logger.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ service: 'supabase-content-queue' });

function getHeaders() {
  return {
    apikey: config.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${config.SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

function getBaseUrl() {
  return config.SUPABASE_URL.replace(/\/+$/, '');
}

function isConfigured() {
  return !!(config.SUPABASE_URL && config.SUPABASE_ANON_KEY);
}

/**
 * Insert a new content queue item.
 * @returns {object|null} The inserted row, or null on error.
 */
export async function insertContentItem(item) {
  if (!isConfigured()) {
    log.warn('Supabase not configured, cannot insert content item');
    return null;
  }

  try {
    const row = {
      id: uuid(),
      client_id: item.client_id,
      client_whatsapp: item.client_whatsapp,
      content_type: item.content_type,
      platform: item.platform || null,
      content_text: item.content_text || null,
      image_url: item.image_url || null,
      headline: item.headline || null,
      cta_url: item.cta_url || null,
      target_audience: item.target_audience || null,
      scheduled_at: item.scheduled_at,
      timezone: item.timezone || 'America/Sao_Paulo',
      status: 'pending_approval',
      client_original_request: item.client_original_request || null,
      sofia_preview_message: item.sofia_preview_message || null,
    };

    const data = await retry(async () => {
      const res = await axios.post(
        `${getBaseUrl()}/rest/v1/content_queue`,
        row,
        { headers: getHeaders(), timeout: 10000 },
      );
      return res.data;
    }, { retries: 2, label: 'Supabase insert content_queue', shouldRetry: isRetryableHttpError });

    log.info('Content item inserted', { id: row.id, type: item.content_type, scheduledAt: item.scheduled_at });
    return Array.isArray(data) ? data[0] : data;
  } catch (error) {
    log.error('Failed to insert content item', { error: error.message });
    return null;
  }
}

/**
 * Update a content queue item by ID.
 * @returns {object|null} The updated row, or null on error.
 */
export async function updateContentItem(id, updates) {
  if (!isConfigured()) return null;

  try {
    updates.updated_at = new Date().toISOString();
    const data = await retry(async () => {
      const res = await axios.patch(
        `${getBaseUrl()}/rest/v1/content_queue?id=eq.${id}`,
        updates,
        { headers: getHeaders(), timeout: 10000 },
      );
      return res.data;
    }, { retries: 2, label: `Supabase update content_queue ${id}`, shouldRetry: isRetryableHttpError });

    log.debug('Content item updated', { id, updates: Object.keys(updates) });
    return Array.isArray(data) ? data[0] : data;
  } catch (error) {
    log.error('Failed to update content item', { id, error: error.message });
    return null;
  }
}

/**
 * Find the most recent pending_approval item for a given WhatsApp number.
 * @returns {object|null}
 */
export async function findPendingApproval(clientWhatsapp) {
  if (!isConfigured()) return null;

  try {
    const data = await retry(async () => {
      const res = await axios.get(
        `${getBaseUrl()}/rest/v1/content_queue?client_whatsapp=eq.${encodeURIComponent(clientWhatsapp)}&status=eq.pending_approval&order=created_at.desc&limit=1`,
        { headers: getHeaders(), timeout: 10000 },
      );
      return res.data;
    }, { retries: 2, label: 'Supabase find pending approval', shouldRetry: isRetryableHttpError });

    return data && data.length > 0 ? data[0] : null;
  } catch (error) {
    log.error('Failed to find pending approval', { clientWhatsapp, error: error.message });
    return null;
  }
}

/**
 * Find items by status and scheduled date range.
 * @param {string} status
 * @param {string} from - ISO date (gte)
 * @param {string} to - ISO date (lte)
 * @returns {Array}
 */
export async function findByStatusAndDateRange(status, from, to) {
  if (!isConfigured()) return [];

  try {
    const data = await retry(async () => {
      const res = await axios.get(
        `${getBaseUrl()}/rest/v1/content_queue?status=eq.${status}&scheduled_at=gte.${encodeURIComponent(from)}&scheduled_at=lte.${encodeURIComponent(to)}&order=scheduled_at.asc`,
        { headers: getHeaders(), timeout: 10000 },
      );
      return res.data;
    }, { retries: 2, label: `Supabase query content_queue status=${status}`, shouldRetry: isRetryableHttpError });

    return data || [];
  } catch (error) {
    log.error('Failed to query content items by status/date', { status, error: error.message });
    return [];
  }
}

/**
 * Find stale awaiting_confirmation items (confirmation sent before cutoff).
 * @param {string} cutoffIso - ISO date; items confirmed before this are stale
 * @returns {Array}
 */
export async function findStaleConfirmations(cutoffIso) {
  if (!isConfigured()) return [];

  try {
    const data = await retry(async () => {
      const res = await axios.get(
        `${getBaseUrl()}/rest/v1/content_queue?status=eq.awaiting_confirmation&confirmation_sent_at=lt.${encodeURIComponent(cutoffIso)}&order=scheduled_at.asc`,
        { headers: getHeaders(), timeout: 10000 },
      );
      return res.data;
    }, { retries: 2, label: 'Supabase find stale confirmations', shouldRetry: isRetryableHttpError });

    return data || [];
  } catch (error) {
    log.error('Failed to query stale confirmations', { error: error.message });
    return [];
  }
}

/**
 * Find confirmed items that are due for publishing.
 * @param {string} from - ISO date (gte)
 * @param {string} to - ISO date (lte)
 * @returns {Array}
 */
export async function findDueForPublishing(from, to) {
  return findByStatusAndDateRange('confirmed', from, to);
}

export default {
  insertContentItem,
  updateContentItem,
  findPendingApproval,
  findByStatusAndDateRange,
  findStaleConfirmations,
  findDueForPublishing,
};
