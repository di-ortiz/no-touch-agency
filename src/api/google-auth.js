/**
 * Shared Google authentication helper.
 *
 * Prefers OAuth2 (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN)
 * for user-level access to Analytics, Sheets, Drive, Slides, GSC, GTM.
 * Falls back to service account (GOOGLE_APPLICATION_CREDENTIALS) if OAuth2 not configured.
 */
import { google } from 'googleapis';
import config from '../config.js';
import logger from '../utils/logger.js';
import fs from 'fs';

const log = logger.child({ service: 'google-auth' });

let oauthClient;

/**
 * Get a Google auth client. Tries OAuth2 first, then service account.
 * @param {string[]} scopes - Required OAuth scopes
 * @returns {import('googleapis').Auth.OAuth2Client | import('googleapis').Auth.GoogleAuth | null}
 */
export function getGoogleAuth(scopes) {
  // Prefer OAuth2 if configured
  if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REFRESH_TOKEN) {
    if (!oauthClient) {
      oauthClient = new google.auth.OAuth2(
        config.GOOGLE_CLIENT_ID,
        config.GOOGLE_CLIENT_SECRET,
      );
      oauthClient.setCredentials({ refresh_token: config.GOOGLE_REFRESH_TOKEN });
      log.info('Google OAuth2 client initialized');
    }
    return oauthClient;
  }

  // Fall back to service account
  const credPath = config.GOOGLE_APPLICATION_CREDENTIALS || 'config/google-service-account.json';
  if (fs.existsSync(credPath)) {
    log.info('Using Google service account credentials', { credPath });
    return new google.auth.GoogleAuth({ keyFile: credPath, scopes });
  }

  return null;
}

export default { getGoogleAuth };
