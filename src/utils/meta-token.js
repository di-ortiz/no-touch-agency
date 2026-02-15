import axios from 'axios';
import config from '../config.js';
import logger from './logger.js';

const log = logger.child({ module: 'meta-token' });
const GRAPH_URL = 'https://graph.facebook.com/v22.0';

let cachedToken = null;
let tokenExpiry = 0;
let tokenValidated = false;

/**
 * Debug/validate a Meta access token. Returns token metadata including
 * expiry, scopes, and validity.
 */
export async function debugToken(token) {
  const appToken = `${config.META_APP_ID}|${config.META_APP_SECRET}`;
  const res = await axios.get(`${GRAPH_URL}/debug_token`, {
    params: { input_token: token, access_token: appToken },
    timeout: 10000,
  });
  return res.data?.data || null;
}

/**
 * Exchange a short-lived token (~1hr) for a long-lived token (~60 days).
 * Can also refresh a still-valid long-lived token.
 */
export async function exchangeForLongLived(shortLivedToken) {
  const res = await axios.get(`${GRAPH_URL}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: config.META_APP_ID,
      client_secret: config.META_APP_SECRET,
      fb_exchange_token: shortLivedToken,
    },
    timeout: 10000,
  });
  return res.data; // { access_token, token_type, expires_in }
}

/**
 * Get a valid Meta access token with auto-refresh.
 *
 * Flow:
 * 1. Return cached token if still valid (with 24hr buffer before expiry)
 * 2. Validate the configured token via debug_token
 * 3. If expiring within 7 days, attempt to exchange for a fresh long-lived token
 * 4. If expired or invalid, throw a clear error
 */
export async function getValidToken() {
  // Return cached token if validated and not near expiry
  if (cachedToken && tokenValidated && tokenExpiry > 0) {
    const bufferMs = 24 * 60 * 60 * 1000; // 24 hours
    if (Date.now() < tokenExpiry - bufferMs) {
      return cachedToken;
    }
  }

  const configToken = config.META_ACCESS_TOKEN;
  if (!configToken) {
    throw new MetaTokenError('META_ACCESS_TOKEN is not configured. Set it in .env');
  }

  // Need app credentials for validation/refresh
  const hasAppCredentials = config.META_APP_ID && config.META_APP_SECRET;

  if (!hasAppCredentials) {
    // Can't validate or refresh without app credentials — use token as-is
    log.warn('META_APP_ID/META_APP_SECRET not set — cannot validate or refresh token');
    cachedToken = configToken;
    tokenValidated = false;
    return configToken;
  }

  // Validate the current token
  try {
    const info = await debugToken(configToken);

    if (!info || !info.is_valid) {
      throw new MetaTokenError(
        'Meta access token is expired or invalid. ' +
        'Generate a new token at https://developers.facebook.com/tools/explorer/ ' +
        'or create a System User token in Meta Business Suite (Settings > System Users) for a non-expiring token.'
      );
    }

    const expiresAt = info.expires_at ? info.expires_at * 1000 : 0; // convert to ms
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    // If token expires within 7 days, try to refresh it
    if (expiresAt > 0 && expiresAt - now < sevenDaysMs) {
      log.info('Meta token expiring soon, attempting refresh', {
        expiresIn: Math.round((expiresAt - now) / 3600000) + 'h',
      });

      try {
        const refreshed = await exchangeForLongLived(configToken);
        cachedToken = refreshed.access_token;
        tokenExpiry = refreshed.expires_in
          ? now + refreshed.expires_in * 1000
          : expiresAt; // fallback to original expiry
        tokenValidated = true;

        log.info('Meta token refreshed successfully', {
          expiresIn: Math.round((tokenExpiry - now) / 86400000) + 'd',
        });

        return cachedToken;
      } catch (refreshErr) {
        log.warn('Token refresh failed, using existing token', { error: refreshErr.message });
        // Fall through to use the still-valid original token
      }
    }

    // Token is valid and not near expiry — cache it
    cachedToken = configToken;
    tokenExpiry = expiresAt;
    tokenValidated = true;
    return cachedToken;
  } catch (error) {
    if (error instanceof MetaTokenError) throw error;

    // debug_token call itself failed (network issue, etc.)
    log.warn('Token validation failed, using configured token', { error: error.message });
    cachedToken = configToken;
    tokenValidated = false;
    return configToken;
  }
}

/**
 * Check if an error is a Meta OAuth/token expiry error (code 190).
 */
export function isTokenExpiredError(error) {
  const metaError = error.response?.data?.error;
  if (metaError?.code === 190) return true;
  if (metaError?.type === 'OAuthException') return true;
  return false;
}

/**
 * Reset cached token state (e.g., after detecting token error at call time).
 */
export function invalidateCachedToken() {
  cachedToken = null;
  tokenExpiry = 0;
  tokenValidated = false;
}

export class MetaTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MetaTokenError';
  }
}

export default { getValidToken, debugToken, exchangeForLongLived, isTokenExpiredError, invalidateCachedToken, MetaTokenError };
