import { google } from 'googleapis';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';
import fs from 'fs';

const log = logger.child({ platform: 'google-calendar' });

let auth;
let calendarClient;

function getAuth() {
  if (!auth) {
    const credPath = config.GOOGLE_APPLICATION_CREDENTIALS || 'config/google-service-account.json';
    if (fs.existsSync(credPath)) {
      auth = new google.auth.GoogleAuth({
        keyFile: credPath,
        scopes: [
          'https://www.googleapis.com/auth/calendar.readonly',
        ],
      });
    } else {
      log.error('Google credentials MISSING', { credPath });
      throw new Error(
        `Google service account credentials not found at "${credPath}". ` +
        `To fix: 1) Enable Calendar API in Google Cloud Console, ` +
        `2) Share your team calendars with the service account email, ` +
        `3) Ensure the service account JSON is at ${credPath}`
      );
    }
  }
  return auth;
}

function getCalendar() {
  if (!calendarClient) {
    calendarClient = google.calendar({ version: 'v3', auth: getAuth() });
  }
  return calendarClient;
}

// --- Calendar IDs ---

/**
 * Get the list of calendar IDs from env or DB config.
 * GOOGLE_CALENDAR_IDS can be comma-separated list of calendar IDs.
 * If not set, uses 'primary' (the service account's own calendar).
 */
function getCalendarIds() {
  const ids = config.GOOGLE_CALENDAR_IDS;
  if (ids) return ids.split(',').map(id => id.trim()).filter(Boolean);
  return ['primary'];
}

// --- Events ---

/**
 * Get events from a single calendar within a date range.
 */
export async function getEvents(calendarId, { timeMin, timeMax, maxResults = 50 } = {}) {
  return rateLimited('google', () =>
    retry(async () => {
      const now = new Date();
      const res = await getCalendar().events.list({
        calendarId,
        timeMin: timeMin || now.toISOString(),
        timeMax: timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults,
      });
      return (res.data.items || []).map(formatEvent);
    }, { retries: 3, label: `Calendar events ${calendarId}`, shouldRetry: isRetryableHttpError })
  );
}

/**
 * Get today's events across all configured calendars.
 */
export async function getTodayEvents() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const calendarIds = getCalendarIds();
  const allEvents = [];

  for (const calId of calendarIds) {
    try {
      const events = await getEvents(calId, {
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
      });
      allEvents.push(...events);
    } catch (e) {
      log.warn(`Failed to get events from calendar ${calId}`, { error: e.message });
    }
  }

  // Sort by start time and deduplicate by event ID
  const seen = new Set();
  return allEvents
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
    .filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
}

/**
 * Get events for the next N days across all calendars.
 */
export async function getUpcomingEvents(daysAhead = 7) {
  const now = new Date();
  const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  const calendarIds = getCalendarIds();
  const allEvents = [];

  for (const calId of calendarIds) {
    try {
      const events = await getEvents(calId, {
        timeMin: now.toISOString(),
        timeMax: future.toISOString(),
      });
      allEvents.push(...events);
    } catch (e) {
      log.warn(`Failed to get upcoming events from calendar ${calId}`, { error: e.message });
    }
  }

  const seen = new Set();
  return allEvents
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
    .filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
}

/**
 * Get a daily schedule summary — events grouped by person/calendar.
 */
export async function getDailySchedule(date) {
  const targetDate = date ? new Date(date) : new Date();
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  const calendarIds = getCalendarIds();
  const schedule = {};

  for (const calId of calendarIds) {
    try {
      const events = await getEvents(calId, {
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
      });
      schedule[calId] = events;
    } catch (e) {
      log.warn(`Failed to get schedule from ${calId}`, { error: e.message });
      schedule[calId] = [];
    }
  }

  return schedule;
}

/**
 * List available calendars the service account can see.
 */
export async function listCalendars() {
  return rateLimited('google', () =>
    retry(async () => {
      const res = await getCalendar().calendarList.list();
      return (res.data.items || []).map(cal => ({
        id: cal.id,
        summary: cal.summary,
        description: cal.description,
        timeZone: cal.timeZone,
        accessRole: cal.accessRole,
      }));
    }, { retries: 3, label: 'Calendar list', shouldRetry: isRetryableHttpError })
  );
}

// --- Helpers ---

function formatEvent(event) {
  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date;
  const isAllDay = !event.start?.dateTime;

  return {
    id: event.id,
    title: event.summary || '(No title)',
    description: event.description || null,
    startTime: start,
    endTime: end,
    isAllDay,
    location: event.location || null,
    attendees: (event.attendees || []).map(a => ({
      email: a.email,
      name: a.displayName || a.email,
      status: a.responseStatus,
    })),
    organizer: event.organizer?.displayName || event.organizer?.email || null,
    status: event.status,
    meetLink: event.hangoutLink || event.conferenceData?.entryPoints?.[0]?.uri || null,
    calendarId: event.organizer?.email,
  };
}

/**
 * Format events into a WhatsApp-readable schedule string.
 */
export function formatScheduleForBriefing(events) {
  if (!events || events.length === 0) return 'No events scheduled';

  return events.map(e => {
    const time = e.isAllDay
      ? '(All day)'
      : new Date(e.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const attendeeCount = e.attendees?.length || 0;
    const attendeeStr = attendeeCount > 0 ? ` (${attendeeCount} attendees)` : '';
    return `- ${time}: ${e.title}${attendeeStr}`;
  }).join('\n');
}

export default {
  getEvents, getTodayEvents, getUpcomingEvents,
  getDailySchedule, listCalendars, formatScheduleForBriefing,
};
