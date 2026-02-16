import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import logger from '../utils/logger.js';

const log = logger.child({ workflow: 'knowledge-base' });
const DB_PATH = process.env.KB_DB_PATH || 'data/knowledge.db';

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        hubspot_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),

        -- Business info
        industry TEXT,
        website TEXT,
        description TEXT,
        target_audience TEXT,
        competitors TEXT, -- JSON array

        -- Brand guidelines
        brand_voice TEXT,
        brand_colors TEXT, -- JSON array
        brand_fonts TEXT,
        logo_drive_id TEXT,
        brand_book_drive_id TEXT,

        -- Goals & Budgets
        monthly_budget_cents INTEGER DEFAULT 0,
        target_roas REAL DEFAULT 0,
        target_cpa_cents INTEGER DEFAULT 0,
        primary_kpi TEXT,
        goals TEXT, -- JSON

        -- Account IDs
        meta_ad_account_id TEXT,
        google_ads_customer_id TEXT,
        tiktok_advertiser_id TEXT,
        twitter_ads_account_id TEXT,

        -- Drive folders
        drive_root_folder_id TEXT,
        drive_reports_folder_id TEXT,
        drive_creatives_folder_id TEXT,
        drive_plans_folder_id TEXT,

        -- ClickUp
        clickup_list_id TEXT,

        -- Status
        status TEXT DEFAULT 'active',
        onboarding_complete INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS campaign_history (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        campaign_name TEXT,
        objective TEXT,
        start_date TEXT,
        end_date TEXT,
        budget_cents INTEGER,
        spend_cents INTEGER,
        impressions INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        conversions REAL DEFAULT 0,
        conversion_value_cents INTEGER DEFAULT 0,
        roas REAL DEFAULT 0,
        cpa_cents INTEGER DEFAULT 0,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (client_id) REFERENCES clients(id)
      );

      CREATE TABLE IF NOT EXISTS creative_library (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        platform TEXT,
        campaign_id TEXT,
        creative_type TEXT, -- image, video, text, carousel
        headline TEXT,
        body_copy TEXT,
        cta TEXT,
        image_url TEXT,
        drive_file_id TEXT,
        impressions INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        conversions REAL DEFAULT 0,
        ctr REAL DEFAULT 0,
        cpa_cents INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active', -- active, paused, fatigued, archived
        days_running INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (client_id) REFERENCES clients(id)
      );

      CREATE TABLE IF NOT EXISTS test_results (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        platform TEXT,
        test_type TEXT, -- creative, audience, placement, bid
        test_name TEXT,
        hypothesis TEXT,
        variant_a TEXT,
        variant_b TEXT,
        winner TEXT,
        confidence REAL,
        metric_name TEXT,
        metric_a REAL,
        metric_b REAL,
        improvement_pct REAL,
        start_date TEXT,
        end_date TEXT,
        status TEXT DEFAULT 'running', -- running, complete, inconclusive
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (client_id) REFERENCES clients(id)
      );

      CREATE TABLE IF NOT EXISTS competitor_intel (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        competitor_name TEXT NOT NULL,
        date_collected TEXT DEFAULT (date('now')),
        ad_themes TEXT, -- JSON array of themes
        offers TEXT,
        creative_approach TEXT,
        landing_page_url TEXT,
        notes TEXT,
        FOREIGN KEY (client_id) REFERENCES clients(id)
      );

      CREATE TABLE IF NOT EXISTS benchmarks (
        id TEXT PRIMARY KEY,
        industry TEXT NOT NULL,
        platform TEXT NOT NULL,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        source TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS client_contacts (
        id TEXT PRIMARY KEY,
        client_id TEXT,
        phone TEXT UNIQUE,
        name TEXT,
        email TEXT,
        role TEXT DEFAULT 'owner',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (client_id) REFERENCES clients(id)
      );

      CREATE TABLE IF NOT EXISTS onboarding_sessions (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        status TEXT DEFAULT 'in_progress',
        current_step TEXT DEFAULT 'name',
        answers TEXT DEFAULT '{}',
        client_id TEXT,
        leadsie_invite_id TEXT,
        drive_folder_url TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (client_id) REFERENCES clients(id)
      );

      CREATE TABLE IF NOT EXISTS pending_clients (
        id TEXT PRIMARY KEY,
        token TEXT UNIQUE NOT NULL,
        email TEXT,
        plan TEXT,
        name TEXT,
        status TEXT DEFAULT 'pending',
        channel TEXT,
        chat_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        activated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'whatsapp',
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_campaign_client ON campaign_history(client_id);
      CREATE INDEX IF NOT EXISTS idx_creative_client ON creative_library(client_id);
      CREATE INDEX IF NOT EXISTS idx_test_client ON test_results(client_id);
      CREATE INDEX IF NOT EXISTS idx_competitor_client ON competitor_intel(client_id);
      CREATE INDEX IF NOT EXISTS idx_contact_phone ON client_contacts(phone);
      CREATE INDEX IF NOT EXISTS idx_contact_client ON client_contacts(client_id);
      CREATE INDEX IF NOT EXISTS idx_onboarding_phone ON onboarding_sessions(phone);
      CREATE INDEX IF NOT EXISTS idx_pending_token ON pending_clients(token);
      CREATE INDEX IF NOT EXISTS idx_convo_chat ON conversation_history(chat_id);
    `);

    // Safe migration: add channel column to onboarding_sessions if missing
    try { db.exec("ALTER TABLE onboarding_sessions ADD COLUMN channel TEXT DEFAULT 'whatsapp'"); } catch (e) { /* already exists */ }
  }
  return db;
}

// --- Client Contacts ---

export function getContactByPhone(phone) {
  const d = getDb();
  const normalized = phone?.replace(/[^0-9]/g, '');
  return d.prepare('SELECT * FROM client_contacts WHERE REPLACE(REPLACE(phone, "+", ""), " ", "") = ?').get(normalized);
}

export function createContact(data) {
  const d = getDb();
  const id = uuid();
  d.prepare(`
    INSERT INTO client_contacts (id, client_id, phone, name, email, role)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, data.clientId || null, data.phone, data.name || null, data.email || null, data.role || 'owner');
  return { id, ...data };
}

export function updateContact(phone, updates) {
  const d = getDb();
  const normalized = phone?.replace(/[^0-9]/g, '');
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${dbKey} = ?`);
    values.push(value);
  }
  values.push(normalized);
  d.prepare(`UPDATE client_contacts SET ${fields.join(', ')} WHERE REPLACE(REPLACE(phone, "+", ""), " ", "") = ?`).run(...values);
}

// --- Onboarding Sessions ---

export function getOnboardingSession(phone) {
  const d = getDb();
  const normalized = phone?.replace(/[^0-9]/g, '');
  const row = d.prepare("SELECT * FROM onboarding_sessions WHERE REPLACE(REPLACE(phone, '+', ''), ' ', '') = ? AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1").get(normalized);
  if (row) {
    row.answers = row.answers ? JSON.parse(row.answers) : {};
  }
  return row;
}

export function createOnboardingSession(phone, channel = 'whatsapp') {
  const d = getDb();
  const id = uuid();
  d.prepare('INSERT INTO onboarding_sessions (id, phone, status, current_step, answers, channel) VALUES (?, ?, ?, ?, ?, ?)').run(id, phone, 'in_progress', 'name', '{}', channel);
  return { id, phone, status: 'in_progress', currentStep: 'name', answers: {}, channel };
}

export function updateOnboardingSession(id, updates) {
  const d = getDb();
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${dbKey} = ?`);
    values.push(typeof value === 'object' ? JSON.stringify(value) : value);
  }
  fields.push("updated_at = datetime('now')");
  values.push(id);
  d.prepare(`UPDATE onboarding_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

// --- Client CRUD ---

export function createClient(data) {
  const d = getDb();
  const id = uuid();
  const competitors = data.competitors ? JSON.stringify(data.competitors) : null;
  const goals = data.goals ? JSON.stringify(data.goals) : null;

  d.prepare(`
    INSERT INTO clients (id, name, hubspot_id, industry, website, description, target_audience,
      competitors, brand_voice, monthly_budget_cents, target_roas, target_cpa_cents, primary_kpi, goals,
      meta_ad_account_id, google_ads_customer_id, tiktok_advertiser_id, twitter_ads_account_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.name, data.hubspotId || null, data.industry || null, data.website || null,
    data.description || null, data.targetAudience || null, competitors, data.brandVoice || null,
    data.monthlyBudgetCents || 0, data.targetRoas || 0, data.targetCpaCents || 0,
    data.primaryKpi || null, goals,
    data.metaAdAccountId || null, data.googleAdsCustomerId || null,
    data.tiktokAdvertiserId || null, data.twitterAdsAccountId || null,
    data.status || 'active',
  );

  log.info(`Created client: ${data.name}`, { id });
  return { id, ...data };
}

export function getClient(idOrName) {
  const d = getDb();
  let row = d.prepare('SELECT * FROM clients WHERE id = ?').get(idOrName);
  if (!row) {
    row = d.prepare('SELECT * FROM clients WHERE LOWER(name) = LOWER(?)').get(idOrName);
  }
  if (row) {
    row.competitors = row.competitors ? JSON.parse(row.competitors) : [];
    row.goals = row.goals ? JSON.parse(row.goals) : {};
  }
  return row;
}

export function getAllClients(status = 'active') {
  const d = getDb();
  const rows = d.prepare('SELECT * FROM clients WHERE status = ? ORDER BY name').all(status);
  return rows.map(r => ({
    ...r,
    competitors: r.competitors ? JSON.parse(r.competitors) : [],
    goals: r.goals ? JSON.parse(r.goals) : {},
  }));
}

export function updateClient(id, updates) {
  const d = getDb();
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${dbKey} = ?`);
    values.push(typeof value === 'object' ? JSON.stringify(value) : value);
  }
  fields.push("updated_at = datetime('now')");
  values.push(id);

  d.prepare(`UPDATE clients SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  log.info(`Updated client: ${id}`);
}

export function searchClients(query) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM clients
    WHERE LOWER(name) LIKE LOWER(?)
    OR LOWER(industry) LIKE LOWER(?)
    OR LOWER(description) LIKE LOWER(?)
    ORDER BY name
  `).all(`%${query}%`, `%${query}%`, `%${query}%`);
}

// --- Campaign History ---

export function recordCampaignPerformance(data) {
  const d = getDb();
  d.prepare(`
    INSERT INTO campaign_history (id, client_id, platform, campaign_id, campaign_name, objective,
      start_date, end_date, budget_cents, spend_cents, impressions, clicks, conversions,
      conversion_value_cents, roas, cpa_cents, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(), data.clientId, data.platform, data.campaignId, data.campaignName || '',
    data.objective || '', data.startDate || '', data.endDate || '',
    data.budgetCents || 0, data.spendCents || 0, data.impressions || 0,
    data.clicks || 0, data.conversions || 0, data.conversionValueCents || 0,
    data.roas || 0, data.cpaCents || 0, data.notes || '',
  );
}

export function getClientCampaignHistory(clientId, limit = 50) {
  const d = getDb();
  return d.prepare('SELECT * FROM campaign_history WHERE client_id = ? ORDER BY created_at DESC LIMIT ?').all(clientId, limit);
}

// --- Creative Library ---

export function saveCreative(data) {
  const d = getDb();
  const id = uuid();
  d.prepare(`
    INSERT INTO creative_library (id, client_id, platform, campaign_id, creative_type,
      headline, body_copy, cta, image_url, drive_file_id, impressions, clicks, conversions,
      ctr, cpa_cents, status, days_running)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.clientId, data.platform || '', data.campaignId || '', data.creativeType || 'text',
    data.headline || '', data.bodyCopy || '', data.cta || '', data.imageUrl || '',
    data.driveFileId || '', data.impressions || 0, data.clicks || 0, data.conversions || 0,
    data.ctr || 0, data.cpaCents || 0, data.status || 'active', data.daysRunning || 0,
  );
  return id;
}

export function getTopCreatives(clientId, limit = 10) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM creative_library
    WHERE client_id = ? AND conversions > 0
    ORDER BY ctr DESC, conversions DESC
    LIMIT ?
  `).all(clientId, limit);
}

// --- Test Results ---

export function recordTestResult(data) {
  const d = getDb();
  d.prepare(`
    INSERT INTO test_results (id, client_id, platform, test_type, test_name, hypothesis,
      variant_a, variant_b, winner, confidence, metric_name, metric_a, metric_b,
      improvement_pct, start_date, end_date, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(), data.clientId, data.platform || '', data.testType || '', data.testName || '',
    data.hypothesis || '', data.variantA || '', data.variantB || '',
    data.winner || '', data.confidence || 0, data.metricName || '',
    data.metricA || 0, data.metricB || 0, data.improvementPct || 0,
    data.startDate || '', data.endDate || '', data.status || 'running', data.notes || '',
  );
}

// --- Benchmarks ---

export function getBenchmark(industry, platform, metric) {
  const d = getDb();
  return d.prepare('SELECT * FROM benchmarks WHERE industry = ? AND platform = ? AND metric = ?').get(industry, platform, metric);
}

export function setBenchmark(industry, platform, metric, value, source) {
  const d = getDb();
  const existing = getBenchmark(industry, platform, metric);
  if (existing) {
    d.prepare("UPDATE benchmarks SET value = ?, source = ?, updated_at = datetime('now') WHERE id = ?").run(value, source || '', existing.id);
  } else {
    d.prepare('INSERT INTO benchmarks (id, industry, platform, metric, value, source) VALUES (?, ?, ?, ?, ?, ?)').run(uuid(), industry, platform, metric, value, source || '');
  }
}

/**
 * Build a context string about a client for Claude prompts.
 */
export function buildClientContext(clientId) {
  const client = getClient(clientId);
  if (!client) return 'Client not found.';

  const history = getClientCampaignHistory(clientId, 20);
  const topCreatives = getTopCreatives(clientId, 5);

  let context = `## Client Profile: ${client.name}\n`;
  context += `Industry: ${client.industry || 'N/A'}\n`;
  context += `Website: ${client.website || 'N/A'}\n`;
  context += `Description: ${client.description || 'N/A'}\n`;
  context += `Target Audience: ${client.target_audience || 'N/A'}\n`;
  context += `Monthly Budget: $${((client.monthly_budget_cents || 0) / 100).toFixed(0)}\n`;
  context += `Target ROAS: ${client.target_roas || 'N/A'}\n`;
  context += `Target CPA: $${((client.target_cpa_cents || 0) / 100).toFixed(2)}\n`;
  context += `Primary KPI: ${client.primary_kpi || 'N/A'}\n`;
  context += `Brand Voice: ${client.brand_voice || 'N/A'}\n`;
  context += `Competitors: ${(client.competitors || []).join(', ') || 'N/A'}\n`;

  if (history.length > 0) {
    context += `\n## Recent Campaign History (last ${history.length}):\n`;
    for (const h of history.slice(0, 10)) {
      context += `- ${h.campaign_name} (${h.platform}): Spend $${(h.spend_cents / 100).toFixed(0)}, `;
      context += `ROAS ${h.roas.toFixed(2)}, CPA $${(h.cpa_cents / 100).toFixed(2)}, `;
      context += `${h.conversions} conversions\n`;
    }
  }

  if (topCreatives.length > 0) {
    context += `\n## Top Performing Creatives:\n`;
    for (const c of topCreatives) {
      context += `- "${c.headline}" (${c.creative_type}): CTR ${(c.ctr * 100).toFixed(2)}%, ${c.conversions} conversions\n`;
    }
  }

  return context;
}

// --- Pending Clients (from website payment) ---

export function createPendingClient(data) {
  const d = getDb();
  const id = uuid();
  d.prepare(`
    INSERT INTO pending_clients (id, token, email, plan, name, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(id, data.token, data.email || null, data.plan || null, data.name || null);
  log.info('Created pending client', { id, token: data.token });
  return { id, token: data.token, ...data };
}

export function getPendingClientByToken(token) {
  const d = getDb();
  return d.prepare("SELECT * FROM pending_clients WHERE token = ? AND status = 'pending'").get(token);
}

export function activatePendingClient(token, chatId, channel) {
  const d = getDb();
  d.prepare(`
    UPDATE pending_clients
    SET status = 'activated', chat_id = ?, channel = ?, activated_at = datetime('now')
    WHERE token = ?
  `).run(chatId, channel, token);
  log.info('Activated pending client', { token, chatId, channel });
}

// --- Persistent Conversation History ---

export function saveMessage(chatId, channel, role, content) {
  const d = getDb();
  d.prepare('INSERT INTO conversation_history (chat_id, channel, role, content) VALUES (?, ?, ?, ?)').run(chatId, channel, role, content);
}

export function getMessages(chatId, limit = 40) {
  const d = getDb();
  const rows = d.prepare('SELECT role, content FROM conversation_history WHERE chat_id = ? ORDER BY id DESC LIMIT ?').all(chatId, limit);
  return rows.reverse(); // oldest first
}

export function clearMessages(chatId) {
  const d = getDb();
  d.prepare('DELETE FROM conversation_history WHERE chat_id = ?').run(chatId);
}

export default {
  createClient, getClient, getAllClients, updateClient, searchClients,
  recordCampaignPerformance, getClientCampaignHistory,
  saveCreative, getTopCreatives,
  recordTestResult,
  getBenchmark, setBenchmark,
  buildClientContext,
  getContactByPhone, createContact, updateContact,
  getOnboardingSession, createOnboardingSession, updateOnboardingSession,
  createPendingClient, getPendingClientByToken, activatePendingClient,
  saveMessage, getMessages, clearMessages,
};
