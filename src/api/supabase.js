import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'supabase' });

function getHeaders() {
  return {
    apikey: config.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${config.SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };
}

function getBaseUrl() {
  return config.SUPABASE_URL.replace(/\/+$/, '');
}

/**
 * Fetch an onboarding submission from Supabase by its UUID.
 * Returns null if not found or Supabase is not configured.
 *
 * @param {string} uuid - The submission UUID from Lovable
 * @returns {object|null} Mapped submission data compatible with pending_clients, or null
 */
export async function getOnboardingSubmission(uuid) {
  if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
    log.debug('Supabase not configured, skipping submission lookup');
    return null;
  }

  log.info('Fetching onboarding submission from Supabase', { uuid });

  try {
    const data = await retry(async () => {
      const res = await axios.get(
        `${getBaseUrl()}/onboarding_submissions?id=eq.${uuid}&select=*`,
        { headers: getHeaders(), timeout: 10000 },
      );
      return res.data;
    }, { retries: 2, label: `Supabase GET submission ${uuid}`, shouldRetry: isRetryableHttpError });

    if (!data || data.length === 0) {
      log.info('Supabase submission not found', { uuid });
      return null;
    }

    const row = data[0];
    log.info('Supabase submission found', { uuid, email: row.email });

    // Map Supabase column names → local pending_clients field names
    return {
      token: row.id,
      name: row.full_name || null,
      email: row.email || null,
      plan: row.plan || null,
      language: row.language || 'en',
      phone: row.phone || null,
      website: row.company_website || null,
      business_name: row.business_name || row.company_name || null,
      business_description: row.business_description || null,
      product_service: row.product_service || null,
    };
  } catch (error) {
    log.error('Failed to fetch Supabase submission', { uuid, error: error.message });
    return null;
  }
}

export default { getOnboardingSubmission };
