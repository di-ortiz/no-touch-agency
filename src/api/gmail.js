import { google } from 'googleapis';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry } from '../utils/retry.js';
import fs from 'fs';
import path from 'path';

const log = logger.child({ platform: 'gmail' });

let oauth2Client;
let gmailClient;

/**
 * Gmail uses OAuth2 (not service account) because it needs access to the user's
 * personal mailbox. The flow:
 * 1. User visits /api/tracker/auth/google to get the consent URL
 * 2. After consent, Google redirects to /api/tracker/auth/google/callback with a code
 * 3. We exchange the code for tokens and store them in data/gmail-tokens.json
 * 4. Tokens auto-refresh via googleapis client
 */

const TOKEN_PATH = 'data/gmail-tokens.json';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
];

function getOAuth2Client() {
  if (!oauth2Client) {
    const clientId = config.GMAIL_CLIENT_ID;
    const clientSecret = config.GMAIL_CLIENT_SECRET;
    const redirectUri = config.GMAIL_REDIRECT_URI || `http://localhost:${config.PORT}/api/tracker/auth/google/callback`;

    if (!clientId || !clientSecret) {
      throw new Error('GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set for Gmail integration');
    }

    oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    // Load saved tokens if they exist
    if (fs.existsSync(TOKEN_PATH)) {
      try {
        const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
        oauth2Client.setCredentials(tokens);
        log.info('Gmail tokens loaded from disk');
      } catch (e) {
        log.warn('Failed to load Gmail tokens', { error: e.message });
      }
    }

    // Auto-save tokens when they refresh
    oauth2Client.on('tokens', (tokens) => {
      try {
        const existing = fs.existsSync(TOKEN_PATH) ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8')) : {};
        const merged = { ...existing, ...tokens };
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
        log.info('Gmail tokens refreshed and saved');
      } catch (e) {
        log.error('Failed to save refreshed tokens', { error: e.message });
      }
    });
  }
  return oauth2Client;
}

/**
 * Get the Gmail authorization URL for the user to visit.
 */
export function getAuthUrl() {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

/**
 * Exchange an authorization code for tokens. Called by the OAuth callback route.
 */
export async function handleAuthCallback(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  log.info('Gmail OAuth tokens saved');
  return tokens;
}

/**
 * Check if Gmail is authenticated.
 */
export function isAuthenticated() {
  try {
    const client = getOAuth2Client();
    return !!client.credentials?.access_token || !!client.credentials?.refresh_token;
  } catch {
    return false;
  }
}

function getGmail() {
  if (!gmailClient) {
    gmailClient = google.gmail({ version: 'v1', auth: getOAuth2Client() });
  }
  return gmailClient;
}

/**
 * Fetch recent emails from the user's inbox.
 * @param {object} opts
 * @param {string} opts.query - Gmail search query (e.g. "is:unread", "from:john@example.com")
 * @param {number} opts.maxResults - Max emails to return (default: 20)
 * @param {string} opts.after - Only emails after this date (YYYY/MM/DD)
 */
export async function fetchEmails({ query = '', maxResults = 20, after } = {}) {
  const gmail = getGmail();
  let q = query;
  if (after) {
    q += ` after:${after}`;
  }

  return rateLimited('google', async () => {
    return retry(async () => {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: q.trim(),
        maxResults,
      });

      const messages = listRes.data.messages || [];
      if (messages.length === 0) return [];

      // Fetch full message details
      const emails = [];
      for (const msg of messages) {
        try {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full',
          });

          const headers = detail.data.payload?.headers || [];
          const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

          const body = extractBody(detail.data.payload);

          emails.push({
            id: msg.id,
            threadId: msg.threadId,
            subject: getHeader('Subject'),
            from: getHeader('From'),
            to: getHeader('To'),
            date: getHeader('Date'),
            snippet: detail.data.snippet,
            body,
            labelIds: detail.data.labelIds || [],
          });
        } catch (err) {
          log.warn('Failed to fetch email detail', { id: msg.id, error: err.message });
        }
      }

      log.info('Fetched emails', { count: emails.length, query: q });
      return emails;
    }, { retries: 3, label: 'Gmail fetch' });
  });
}

/**
 * Extract plain text body from Gmail message payload.
 */
function extractBody(payload) {
  if (!payload) return '';

  // Direct body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  // Multipart — look for text/plain first, then text/html
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
    }

    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      const html = Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8');
      return stripHtml(html);
    }

    // Nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return '';
}

/**
 * Basic HTML to text conversion.
 */
function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Send an email via Gmail API.
 * @param {object} opts
 * @param {string} opts.to - Recipient email
 * @param {string} opts.subject - Email subject
 * @param {string} opts.body - Plain text body
 * @param {string} opts.html - HTML body (optional, overrides body)
 */
export async function sendEmail({ to, subject, body, html }) {
  const gmail = getGmail();

  const contentType = html ? 'text/html' : 'text/plain';
  const content = html || body;

  const raw = Buffer.from(
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `Content-Type: ${contentType}; charset=utf-8\r\n` +
    `\r\n` +
    `${content}`
  ).toString('base64url');

  return rateLimited('google', async () => {
    return retry(async () => {
      const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw },
      });
      log.info('Email sent', { to, subject, messageId: res.data.id });
      return res.data;
    }, { retries: 3, label: 'Gmail send' });
  });
}

/**
 * Fetch upcoming calendar events (uses the same OAuth2 client).
 */
export async function getUpcomingEvents({ maxResults = 10, daysAhead = 7 } = {}) {
  const calendar = google.calendar({ version: 'v3', auth: getOAuth2Client() });
  const now = new Date();
  const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  return rateLimited('google', async () => {
    return retry(async () => {
      const res = await calendar.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax: future.toISOString(),
        maxResults,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = (res.data.items || []).map(ev => ({
        id: ev.id,
        summary: ev.summary,
        description: ev.description,
        start: ev.start?.dateTime || ev.start?.date,
        end: ev.end?.dateTime || ev.end?.date,
        attendees: (ev.attendees || []).map(a => ({ email: a.email, name: a.displayName, status: a.responseStatus })),
        meetLink: ev.hangoutLink || ev.conferenceData?.entryPoints?.[0]?.uri,
      }));

      log.info('Fetched calendar events', { count: events.length });
      return events;
    }, { retries: 3, label: 'Calendar fetch' });
  });
}

export default { getAuthUrl, handleAuthCallback, isAuthenticated, fetchEmails, sendEmail, getUpcomingEvents };
