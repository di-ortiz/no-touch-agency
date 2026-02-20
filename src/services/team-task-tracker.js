import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import logger from '../utils/logger.js';

const log = logger.child({ workflow: 'team-task-tracker' });
const DB_PATH = process.env.TRACKER_DB_PATH || 'data/tracker.db';

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        whatsapp_phone TEXT,
        role TEXT,
        department TEXT,
        language TEXT DEFAULT 'en',
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS deliverables (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        assigned_to TEXT NOT NULL,
        due_date TEXT,
        status TEXT DEFAULT 'pending',
        priority TEXT DEFAULT 'medium',
        source_type TEXT,
        source_id TEXT,
        source_summary TEXT,
        context_notes TEXT,
        public_token TEXT UNIQUE,
        completed_at TEXT,
        snoozed_until TEXT,
        reminder_count INTEGER DEFAULT 0,
        last_reminder_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (assigned_to) REFERENCES team_members(id)
      );

      CREATE TABLE IF NOT EXISTS deliverable_comments (
        id TEXT PRIMARY KEY,
        deliverable_id TEXT NOT NULL,
        author_type TEXT NOT NULL,
        author_name TEXT,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (deliverable_id) REFERENCES deliverables(id)
      );

      CREATE TABLE IF NOT EXISTS ingestion_log (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT,
        source_label TEXT,
        raw_text TEXT,
        extracted_count INTEGER DEFAULT 0,
        processed_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_deliverables_assigned ON deliverables(assigned_to);
      CREATE INDEX IF NOT EXISTS idx_deliverables_status ON deliverables(status);
      CREATE INDEX IF NOT EXISTS idx_deliverables_due ON deliverables(due_date);
      CREATE INDEX IF NOT EXISTS idx_deliverables_token ON deliverables(public_token);
      CREATE INDEX IF NOT EXISTS idx_comments_deliverable ON deliverable_comments(deliverable_id);
      CREATE INDEX IF NOT EXISTS idx_team_email ON team_members(email);
      CREATE INDEX IF NOT EXISTS idx_team_phone ON team_members(phone);
    `);
    log.info('Tracker database initialized', { path: DB_PATH });
  }
  return db;
}

// ─── Team Members ───────────────────────────────────────────────────────────

export function createTeamMember({ name, email, phone, whatsappPhone, role, department, language }) {
  const d = getDb();
  const id = uuid();
  d.prepare(`
    INSERT INTO team_members (id, name, email, phone, whatsapp_phone, role, department, language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, email || null, phone || null, whatsappPhone || null, role || null, department || null, language || 'en');
  log.info('Team member created', { id, name });
  return getTeamMember(id);
}

export function getTeamMember(id) {
  return getDb().prepare('SELECT * FROM team_members WHERE id = ?').get(id);
}

export function getTeamMemberByEmail(email) {
  return getDb().prepare('SELECT * FROM team_members WHERE email = ? COLLATE NOCASE').get(email);
}

export function getTeamMemberByPhone(phone) {
  const normalized = phone?.replace(/[^0-9]/g, '');
  return getDb().prepare('SELECT * FROM team_members WHERE phone = ? OR whatsapp_phone = ?').get(normalized, normalized);
}

export function searchTeamMembers(query) {
  return getDb().prepare(`
    SELECT * FROM team_members
    WHERE active = 1 AND (name LIKE ? OR email LIKE ? OR department LIKE ?)
    ORDER BY name
  `).all(`%${query}%`, `%${query}%`, `%${query}%`);
}

export function getAllTeamMembers(activeOnly = true) {
  if (activeOnly) {
    return getDb().prepare('SELECT * FROM team_members WHERE active = 1 ORDER BY name').all();
  }
  return getDb().prepare('SELECT * FROM team_members ORDER BY name').all();
}

export function updateTeamMember(id, updates) {
  const d = getDb();
  const allowed = ['name', 'email', 'phone', 'whatsapp_phone', 'role', 'department', 'language', 'active'];
  const sets = [];
  const vals = [];
  for (const [key, val] of Object.entries(updates)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (allowed.includes(col)) {
      sets.push(`${col} = ?`);
      vals.push(val);
    }
  }
  if (sets.length === 0) return getTeamMember(id);
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  d.prepare(`UPDATE team_members SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getTeamMember(id);
}

export function deleteTeamMember(id) {
  getDb().prepare('UPDATE team_members SET active = 0, updated_at = datetime(\'now\') WHERE id = ?').run(id);
}

// ─── Deliverables ───────────────────────────────────────────────────────────

function generateToken() {
  return uuid().replace(/-/g, '').substring(0, 16);
}

export function createDeliverable({ title, description, assignedTo, dueDate, priority, sourceType, sourceId, sourceSummary, contextNotes }) {
  const d = getDb();
  const id = uuid();
  const publicToken = generateToken();
  d.prepare(`
    INSERT INTO deliverables (id, title, description, assigned_to, due_date, priority, source_type, source_id, source_summary, context_notes, public_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, description || null, assignedTo, dueDate || null, priority || 'medium', sourceType || null, sourceId || null, sourceSummary || null, contextNotes || null, publicToken);
  log.info('Deliverable created', { id, title, assignedTo });
  return getDeliverable(id);
}

export function getDeliverable(id) {
  return getDb().prepare(`
    SELECT d.*, tm.name as assignee_name, tm.email as assignee_email, tm.whatsapp_phone as assignee_whatsapp
    FROM deliverables d
    JOIN team_members tm ON d.assigned_to = tm.id
    WHERE d.id = ?
  `).get(id);
}

export function getDeliverableByToken(token) {
  return getDb().prepare(`
    SELECT d.*, tm.name as assignee_name, tm.email as assignee_email
    FROM deliverables d
    JOIN team_members tm ON d.assigned_to = tm.id
    WHERE d.public_token = ?
  `).get(token);
}

export function updateDeliverable(id, updates) {
  const d = getDb();
  const allowed = ['title', 'description', 'assigned_to', 'due_date', 'status', 'priority', 'context_notes', 'snoozed_until', 'reminder_count', 'last_reminder_at', 'completed_at'];
  const sets = [];
  const vals = [];
  for (const [key, val] of Object.entries(updates)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (allowed.includes(col)) {
      sets.push(`${col} = ?`);
      vals.push(val);
    }
  }
  if (sets.length === 0) return getDeliverable(id);
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  d.prepare(`UPDATE deliverables SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getDeliverable(id);
}

export function completeDeliverable(id) {
  return updateDeliverable(id, { status: 'completed', completed_at: new Date().toISOString() });
}

export function deleteDeliverable(id) {
  getDb().prepare('DELETE FROM deliverables WHERE id = ?').run(id);
}

export function getDeliverablesByAssignee(teamMemberId, statusFilter) {
  let sql = `
    SELECT d.*, tm.name as assignee_name, tm.email as assignee_email, tm.whatsapp_phone as assignee_whatsapp
    FROM deliverables d
    JOIN team_members tm ON d.assigned_to = tm.id
    WHERE d.assigned_to = ?
  `;
  const params = [teamMemberId];
  if (statusFilter) {
    sql += ' AND d.status = ?';
    params.push(statusFilter);
  }
  sql += ' ORDER BY d.due_date ASC NULLS LAST, d.priority DESC';
  return getDb().prepare(sql).all(...params);
}

export function getAllDeliverables({ status, assignedTo, overdue, dueSoon } = {}) {
  let sql = `
    SELECT d.*, tm.name as assignee_name, tm.email as assignee_email, tm.whatsapp_phone as assignee_whatsapp
    FROM deliverables d
    JOIN team_members tm ON d.assigned_to = tm.id
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    sql += ' AND d.status = ?';
    params.push(status);
  }
  if (assignedTo) {
    sql += ' AND d.assigned_to = ?';
    params.push(assignedTo);
  }
  if (overdue) {
    sql += " AND d.due_date < date('now') AND d.status NOT IN ('completed', 'cancelled')";
  }
  if (dueSoon) {
    sql += " AND d.due_date BETWEEN date('now') AND date('now', '+3 days') AND d.status NOT IN ('completed', 'cancelled')";
  }

  sql += ' ORDER BY d.due_date ASC NULLS LAST, d.priority DESC';
  return getDb().prepare(sql).all(...params);
}

export function getPendingDeliverablesSummary() {
  const d = getDb();
  const total = d.prepare("SELECT COUNT(*) as count FROM deliverables WHERE status NOT IN ('completed', 'cancelled')").get();
  const overdue = d.prepare("SELECT COUNT(*) as count FROM deliverables WHERE due_date < date('now') AND status NOT IN ('completed', 'cancelled')").get();
  const dueToday = d.prepare("SELECT COUNT(*) as count FROM deliverables WHERE due_date = date('now') AND status NOT IN ('completed', 'cancelled')").get();
  const dueThisWeek = d.prepare("SELECT COUNT(*) as count FROM deliverables WHERE due_date BETWEEN date('now') AND date('now', '+7 days') AND status NOT IN ('completed', 'cancelled')").get();
  const noDueDate = d.prepare("SELECT COUNT(*) as count FROM deliverables WHERE due_date IS NULL AND status NOT IN ('completed', 'cancelled')").get();

  return {
    total: total.count,
    overdue: overdue.count,
    dueToday: dueToday.count,
    dueThisWeek: dueThisWeek.count,
    noDueDate: noDueDate.count,
  };
}

export function getDeliverablesByPerson() {
  const d = getDb();
  const members = getAllTeamMembers();
  const result = [];

  for (const member of members) {
    const pending = getDeliverablesByAssignee(member.id, 'pending');
    const inProgress = getDeliverablesByAssignee(member.id, 'in_progress');
    const overdue = d.prepare(`
      SELECT COUNT(*) as count FROM deliverables
      WHERE assigned_to = ? AND due_date < date('now') AND status NOT IN ('completed', 'cancelled')
    `).get(member.id);

    if (pending.length > 0 || inProgress.length > 0) {
      result.push({
        member,
        pending,
        inProgress,
        overdueCount: overdue.count,
        totalActive: pending.length + inProgress.length,
      });
    }
  }

  return result.sort((a, b) => b.overdueCount - a.overdueCount);
}

// ─── Comments ───────────────────────────────────────────────────────────────

export function addComment({ deliverableId, authorType, authorName, content }) {
  const d = getDb();
  const id = uuid();
  d.prepare(`
    INSERT INTO deliverable_comments (id, deliverable_id, author_type, author_name, content)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, deliverableId, authorType, authorName || null, content);
  return d.prepare('SELECT * FROM deliverable_comments WHERE id = ?').get(id);
}

export function getComments(deliverableId) {
  return getDb().prepare('SELECT * FROM deliverable_comments WHERE deliverable_id = ? ORDER BY created_at ASC').all(deliverableId);
}

// ─── Ingestion Log ──────────────────────────────────────────────────────────

export function logIngestion({ sourceType, sourceId, sourceLabel, rawText, extractedCount }) {
  const d = getDb();
  const id = uuid();
  d.prepare(`
    INSERT INTO ingestion_log (id, source_type, source_id, source_label, raw_text, extracted_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, sourceType, sourceId || null, sourceLabel || null, rawText || null, extractedCount || 0);
  return id;
}

export function getRecentIngestions(limit = 20) {
  return getDb().prepare('SELECT * FROM ingestion_log ORDER BY processed_at DESC LIMIT ?').all(limit);
}

export default {
  createTeamMember, getTeamMember, getTeamMemberByEmail, getTeamMemberByPhone,
  searchTeamMembers, getAllTeamMembers, updateTeamMember, deleteTeamMember,
  createDeliverable, getDeliverable, getDeliverableByToken, updateDeliverable,
  completeDeliverable, deleteDeliverable, getDeliverablesByAssignee, getAllDeliverables,
  getPendingDeliverablesSummary, getDeliverablesByPerson,
  addComment, getComments,
  logIngestion, getRecentIngestions,
};
