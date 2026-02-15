import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'leadsie' });

const BASE_URL = 'https://api.leadsie.com/v1';

function getHeaders() {
  const token = config.LEADSIE_API_KEY;
  if (!token) {
    throw new Error('LEADSIE_API_KEY not configured. Set it in .env to enable Leadsie onboarding.');
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function apiGet(endpoint) {
  return retry(async () => {
    const res = await axios.get(`${BASE_URL}${endpoint}`, {
      headers: getHeaders(),
      timeout: 15000,
    });
    return res.data;
  }, { retries: 2, label: `Leadsie GET ${endpoint}`, shouldRetry: isRetryableHttpError });
}

async function apiPost(endpoint, data) {
  return retry(async () => {
    const res = await axios.post(`${BASE_URL}${endpoint}`, data, {
      headers: getHeaders(),
      timeout: 15000,
    });
    return res.data;
  }, { retries: 2, label: `Leadsie POST ${endpoint}`, shouldRetry: isRetryableHttpError });
}

/**
 * Create a Leadsie invite link for a new client.
 * This link lets the client grant access to their ad accounts in one click.
 *
 * @param {object} opts
 * @param {string} opts.clientName - Client's business name
 * @param {string} opts.clientEmail - Client's email
 * @param {string[]} opts.platforms - Platforms to request access for ['facebook', 'google', 'tiktok']
 * @param {string} opts.message - Optional personalized message
 * @returns {object} { inviteUrl, inviteId, status }
 */
export async function createInvite(opts = {}) {
  if (!opts.clientName) throw new Error('Client name is required');

  log.info('Creating Leadsie invite', { clientName: opts.clientName, platforms: opts.platforms });

  const data = {
    client_name: opts.clientName,
    client_email: opts.clientEmail || '',
    platforms: opts.platforms || ['facebook', 'google'],
    message: opts.message || `Hi ${opts.clientName}! Please click the link below to grant us access to your ad accounts. This is a secure, one-click process powered by Leadsie.`,
  };

  const result = await apiPost('/invites', data);

  log.info('Leadsie invite created', { inviteId: result.id, url: result.invite_url });
  return {
    inviteId: result.id,
    inviteUrl: result.invite_url,
    status: result.status || 'pending',
    platforms: opts.platforms,
  };
}

/**
 * Check the status of a Leadsie invite.
 *
 * @param {string} inviteId - The invite ID
 * @returns {object} Invite status details
 */
export async function getInviteStatus(inviteId) {
  if (!inviteId) throw new Error('Invite ID is required');

  const result = await apiGet(`/invites/${inviteId}`);
  return {
    inviteId: result.id,
    clientName: result.client_name,
    status: result.status, // pending, completed, expired
    platforms: result.platforms,
    grantedAccounts: result.granted_accounts || [],
    createdAt: result.created_at,
    completedAt: result.completed_at,
  };
}

/**
 * List all Leadsie invites.
 *
 * @param {object} opts
 * @param {string} opts.status - Filter by status (pending, completed, expired)
 * @param {number} opts.limit - Max results (default: 20)
 * @returns {Array} List of invites
 */
export async function listInvites(opts = {}) {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.limit) params.set('limit', opts.limit);

  const query = params.toString() ? `?${params.toString()}` : '';
  const result = await apiGet(`/invites${query}`);

  return (result.data || result || []).map(inv => ({
    inviteId: inv.id,
    clientName: inv.client_name,
    status: inv.status,
    platforms: inv.platforms,
    inviteUrl: inv.invite_url,
    createdAt: inv.created_at,
  }));
}

/**
 * Get all granted accounts for the agency.
 *
 * @returns {Array} Connected client accounts
 */
export async function getConnectedAccounts() {
  const result = await apiGet('/accounts');
  return (result.data || result || []).map(acc => ({
    accountId: acc.id,
    clientName: acc.client_name,
    platform: acc.platform,
    accountName: acc.account_name,
    status: acc.status,
    connectedAt: acc.connected_at,
  }));
}

export default { createInvite, getInviteStatus, listInvites, getConnectedAccounts };
