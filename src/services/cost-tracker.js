import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import config from '../config.js';
import logger from '../utils/logger.js';

const DB_PATH = config.COST_DB_PATH || 'data/costs.db';

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_costs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        platform TEXT NOT NULL,
        model TEXT,
        workflow TEXT,
        client_id TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_cents REAL NOT NULL DEFAULT 0,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        action TEXT NOT NULL,
        workflow TEXT,
        client_id TEXT,
        platform TEXT,
        details TEXT,
        approved_by TEXT,
        result TEXT,
        rollback_data TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_costs_date ON api_costs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_costs_platform ON api_costs(platform);
      CREATE INDEX IF NOT EXISTS idx_costs_client ON api_costs(client_id);
      CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_client ON audit_log(client_id);
    `);
  }
  return db;
}

// --- Cost per 1K tokens in cents ---
const PRICING = {
  'claude-sonnet-4-5-20250514': { input: 0.3, output: 1.5 },
  'claude-sonnet-4-20250514': { input: 0.3, output: 1.5 },
  'claude-haiku-3-5-20241022': { input: 0.08, output: 0.4 },
  'gpt-4o': { input: 0.25, output: 1.0 },
  'dall-e-3': { perImage: 4.0 },
};

/**
 * Record an API call's cost.
 */
export function recordCost({ platform, model, workflow, clientId, inputTokens = 0, outputTokens = 0, costCentsOverride, metadata }) {
  const d = getDb();
  let costCents = costCentsOverride;

  if (costCents == null && model && PRICING[model]) {
    const p = PRICING[model];
    if (p.perImage) {
      costCents = p.perImage;
    } else {
      costCents = (inputTokens / 1000) * p.input + (outputTokens / 1000) * p.output;
    }
  }

  costCents = costCents || 0;

  d.prepare(`
    INSERT INTO api_costs (id, platform, model, workflow, client_id, input_tokens, output_tokens, cost_cents, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuid(), platform, model || '', workflow || '', clientId || '', inputTokens, outputTokens, costCents, metadata ? JSON.stringify(metadata) : null);

  return costCents;
}

/**
 * Get cost summary for a time period.
 */
export function getCostSummary(period = 'today') {
  const d = getDb();
  let whereClause;
  if (period === 'today') {
    whereClause = "WHERE date(timestamp) = date('now')";
  } else if (period === 'week') {
    whereClause = "WHERE timestamp >= datetime('now', '-7 days')";
  } else if (period === 'month') {
    whereClause = "WHERE timestamp >= datetime('now', '-30 days')";
  } else {
    whereClause = '';
  }

  const total = d.prepare(`SELECT COALESCE(SUM(cost_cents), 0) as total FROM api_costs ${whereClause}`).get();
  const byPlatform = d.prepare(`SELECT platform, COALESCE(SUM(cost_cents), 0) as total FROM api_costs ${whereClause} GROUP BY platform ORDER BY total DESC`).all();
  const byClient = d.prepare(`SELECT client_id, COALESCE(SUM(cost_cents), 0) as total FROM api_costs ${whereClause} AND client_id != '' GROUP BY client_id ORDER BY total DESC`).all();
  const byWorkflow = d.prepare(`SELECT workflow, COALESCE(SUM(cost_cents), 0) as total FROM api_costs ${whereClause} AND workflow != '' GROUP BY workflow ORDER BY total DESC`).all();

  return {
    totalCents: total.total,
    totalDollars: (total.total / 100).toFixed(2),
    byPlatform,
    byClient,
    byWorkflow,
    budgetUsedPct: ((total.total / config.MONTHLY_AI_BUDGET_CENTS) * 100).toFixed(1),
  };
}

/**
 * Check if daily cost threshold is exceeded.
 */
export function isDailyBudgetExceeded() {
  const summary = getCostSummary('today');
  return summary.totalCents >= config.DAILY_COST_ALERT_THRESHOLD_CENTS;
}

/**
 * Record an action in the audit log.
 */
export function auditLog({ action, workflow, clientId, platform, details, approvedBy, result, rollbackData }) {
  const d = getDb();
  d.prepare(`
    INSERT INTO audit_log (id, action, workflow, client_id, platform, details, approved_by, result, rollback_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(), action, workflow || '', clientId || '', platform || '',
    details ? JSON.stringify(details) : null,
    approvedBy || 'system',
    result || '',
    rollbackData ? JSON.stringify(rollbackData) : null,
  );
}

/**
 * Get recent audit log entries.
 */
export function getAuditLog(limit = 50, clientId) {
  const d = getDb();
  if (clientId) {
    return d.prepare('SELECT * FROM audit_log WHERE client_id = ? ORDER BY timestamp DESC LIMIT ?').all(clientId, limit);
  }
  return d.prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?').all(limit);
}

/**
 * Print cost report (CLI mode).
 */
export function printCostReport() {
  const today = getCostSummary('today');
  const week = getCostSummary('week');
  const month = getCostSummary('month');

  console.log('\n=== AI Cost Report ===');
  console.log(`Today:  $${today.totalDollars}`);
  console.log(`Week:   $${week.totalDollars}`);
  console.log(`Month:  $${month.totalDollars} (${month.budgetUsedPct}% of budget)`);

  if (month.byPlatform.length > 0) {
    console.log('\nBy Platform:');
    for (const p of month.byPlatform) {
      console.log(`  ${p.platform}: $${(p.total / 100).toFixed(2)}`);
    }
  }

  if (month.byWorkflow.length > 0) {
    console.log('\nBy Workflow:');
    for (const w of month.byWorkflow) {
      console.log(`  ${w.workflow}: $${(w.total / 100).toFixed(2)}`);
    }
  }
}

// CLI entry point
if (process.argv.includes('--report')) {
  printCostReport();
}

export default { recordCost, getCostSummary, isDailyBudgetExceeded, auditLog, getAuditLog };
