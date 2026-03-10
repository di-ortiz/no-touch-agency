/**
 * SOP Registry — Standard Operating Procedures, timelines, and procedural compliance.
 *
 * This codifies the agency's standard docs, procedures, and expected cadences so
 * Sofia can compare what SHOULD be happening (per SOP) vs what IS happening
 * (per ClickUp tasks + Google Calendar + deliverables).
 */
import logger from '../utils/logger.js';
import {
  getAllClients, getClientDeliverables, getOverdueDeliverables,
} from './knowledge-base.js';

const log = logger.child({ service: 'sop-registry' });

// ==========================================================================
// Standard Operating Procedures — Agency-Wide
// ==========================================================================

export const SOPS = {
  // ---- Client Onboarding ----
  onboarding: {
    id: 'SOP-ONB',
    name: 'Client Onboarding',
    description: 'New client activation from signed contract to live campaigns',
    owner: 'Account Manager',
    maxDays: 15,
    steps: [
      { day: 0, action: 'Contract signed, client record created', gate: 'client_created' },
      { day: 1, action: 'Kick-off call scheduled and held', gate: 'kickoff_call' },
      { day: 3, action: 'Brand assets received (logo, guidelines, fonts, colors)', gate: 'brand_assets' },
      { day: 3, action: 'Platform access requests sent (Leadsie)', gate: 'access_requested' },
      { day: 5, action: 'Account audit completed and documented', gate: 'account_audit' },
      { day: 7, action: 'Tracking & pixel setup verified', gate: 'tracking_setup' },
      { day: 10, action: '90-day strategic plan delivered', gate: 'strategic_plan' },
      { day: 14, action: 'Campaign build complete, creatives approved', gate: 'campaign_build' },
      { day: 14, action: 'Reporting dashboard configured', gate: 'reporting_setup' },
      { day: 15, action: 'Client approval obtained, campaigns live', gate: 'go_live' },
    ],
  },

  // ---- Weekly Cadence ----
  weekly: {
    id: 'SOP-WKL',
    name: 'Weekly Operations Cadence',
    description: 'Standard weekly tasks every active client should receive',
    owner: 'PPC Specialist',
    cadenceDays: 7,
    tasks: [
      { name: 'Performance report', dayOfWeek: 'Friday', description: 'Weekly performance report with WoW trends sent to client', requiredDeliverable: 'Weekly performance report' },
      { name: 'Optimization pass', dayOfWeek: 'Wednesday', description: 'Bid adjustments, negative keywords, audience refinements, budget reallocation', requiredDeliverable: 'Weekly optimization pass' },
      { name: 'Creative review', dayOfWeek: 'Tuesday', description: 'Check frequency, CTR decay, creative fatigue indicators' },
      { name: 'Search term review', dayOfWeek: 'Thursday', description: 'Review search term reports, add negatives, find new keywords' },
      { name: 'Internal standup', dayOfWeek: 'Monday', description: 'Team standup — priorities for the week, blockers, wins' },
    ],
  },

  // ---- Monthly Cadence ----
  monthly: {
    id: 'SOP-MTH',
    name: 'Monthly Operations Cadence',
    description: 'Monthly strategic and maintenance tasks per client',
    owner: 'Account Manager',
    cadenceDays: 30,
    tasks: [
      { name: 'Strategic review meeting', weekOfMonth: 4, description: 'Full performance review, strategy adjustments, next month plan', requiredDeliverable: 'Monthly strategic review' },
      { name: 'Creative refresh', weekOfMonth: 3, description: 'New ad creatives, copy variations, A/B test setup', requiredDeliverable: 'Monthly creative refresh' },
      { name: 'Budget reconciliation', weekOfMonth: 1, description: 'Actual vs planned spend analysis, next month budget plan', requiredDeliverable: 'Monthly budget reconciliation' },
      { name: 'Competitor intel update', weekOfMonth: 2, description: 'Pull latest competitor ads, identify new angles' },
      { name: 'Landing page review', weekOfMonth: 2, description: 'Check conversion rates, page speed, mobile experience' },
    ],
  },

  // ---- Quarterly Cadence ----
  quarterly: {
    id: 'SOP-QTR',
    name: 'Quarterly Business Review',
    description: 'Strategic review with client stakeholders',
    owner: 'Account Director',
    cadenceDays: 90,
    tasks: [
      { name: 'QBR presentation', description: 'QoQ performance, strategic roadmap, budget recommendations', requiredDeliverable: 'Quarterly business review' },
      { name: 'Annual goal check-in', description: 'Assess progress toward annual KPI targets' },
      { name: 'Contract health check', description: 'Review scope, deliverables, satisfaction' },
    ],
  },

  // ---- Campaign Launch ----
  campaignLaunch: {
    id: 'SOP-CMP',
    name: 'Campaign Launch Checklist',
    description: 'Pre-launch verification for any new campaign',
    owner: 'PPC Specialist',
    steps: [
      { action: 'Tracking pixels verified on all landing pages', critical: true },
      { action: 'UTM parameters configured and tested', critical: true },
      { action: 'Ad copy proofread, compliant with platform policies', critical: true },
      { action: 'Creative specs match platform requirements', critical: false },
      { action: 'Audience targeting reviewed (no overlap with existing campaigns)', critical: true },
      { action: 'Budget and bid strategy set per media plan', critical: true },
      { action: 'Negative keyword lists applied', critical: false },
      { action: 'Conversion actions mapped correctly', critical: true },
      { action: 'Client approval obtained (if required by contract)', critical: true },
      { action: 'Automated rules/alerts configured', critical: false },
    ],
  },

  // ---- Incident Response ----
  incidentResponse: {
    id: 'SOP-INC',
    name: 'Performance Incident Response',
    description: 'What to do when a campaign or account has a critical performance drop',
    owner: 'PPC Specialist',
    sla: '4 hours',
    steps: [
      { action: 'Identify anomaly (auto-detected or manual)', timeframe: 'Immediate' },
      { action: 'Pause affected campaigns if spend is at risk', timeframe: '30 min' },
      { action: 'Root cause analysis (platform issue, tracking, creative, external)', timeframe: '2 hours' },
      { action: 'Implement fix or workaround', timeframe: '4 hours' },
      { action: 'Client notification (if significant budget impact)', timeframe: '4 hours' },
      { action: 'Post-incident review and process update', timeframe: '24 hours' },
    ],
  },
};

// ==========================================================================
// Compliance Checking
// ==========================================================================

/**
 * Check weekly SOP compliance for a specific client.
 * Compares expected weekly tasks against ClickUp tasks and deliverables.
 */
export function checkWeeklyCompliance(clientClickUpTasks, clientDeliverables) {
  const today = new Date();
  const dayOfWeek = today.toLocaleDateString('en-US', { weekday: 'long' });
  const gaps = [];

  for (const task of SOPS.weekly.tasks) {
    // Check if there's a matching deliverable
    if (task.requiredDeliverable) {
      const matchingDeliverable = clientDeliverables.find(d =>
        d.name.toLowerCase().includes(task.requiredDeliverable.toLowerCase()) &&
        d.status !== 'completed'
      );
      if (!matchingDeliverable) {
        gaps.push({
          sop: SOPS.weekly.id,
          task: task.name,
          expectedDay: task.dayOfWeek,
          issue: 'no_deliverable_tracked',
          severity: 'warning',
          message: `No active "${task.requiredDeliverable}" deliverable found`,
        });
      }
    }

    // On the expected day, check if there's a matching ClickUp task
    if (task.dayOfWeek === dayOfWeek) {
      const matchingCUTask = clientClickUpTasks.find(t =>
        t.name?.toLowerCase().includes(task.name.toLowerCase())
      );
      if (!matchingCUTask) {
        gaps.push({
          sop: SOPS.weekly.id,
          task: task.name,
          expectedDay: task.dayOfWeek,
          issue: 'no_clickup_task',
          severity: 'info',
          message: `Today is ${dayOfWeek} — "${task.name}" expected per SOP but no matching ClickUp task found`,
        });
      }
    }
  }

  return gaps;
}

/**
 * Check onboarding SOP compliance for a client.
 * Compare days since client creation vs expected milestones.
 */
export function checkOnboardingCompliance(client, deliverables) {
  if (client.onboarding_complete === 1) return { status: 'completed', gaps: [] };

  const createdAt = new Date(client.created_at);
  const now = new Date();
  const daysSinceCreation = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
  const gaps = [];

  for (const step of SOPS.onboarding.steps) {
    if (daysSinceCreation >= step.day) {
      // This step should be done by now — check deliverables
      const matching = deliverables.find(d =>
        d.name.toLowerCase().includes(step.action.toLowerCase().substring(0, 20)) &&
        d.status === 'completed'
      );
      if (!matching) {
        const daysLate = daysSinceCreation - step.day;
        gaps.push({
          sop: SOPS.onboarding.id,
          step: step.action,
          expectedDay: step.day,
          actualDay: daysSinceCreation,
          daysLate,
          severity: daysLate > 5 ? 'critical' : daysLate > 2 ? 'warning' : 'info',
          message: `"${step.action}" was due by day ${step.day} — now day ${daysSinceCreation} (${daysLate} days late)`,
        });
      }
    }
  }

  return {
    status: daysSinceCreation > SOPS.onboarding.maxDays ? 'overdue' : 'in_progress',
    daysSinceCreation,
    maxDays: SOPS.onboarding.maxDays,
    gaps,
  };
}

/**
 * Run a full SOP compliance audit across all active clients.
 * Returns a structured report of what's on track and what's falling behind.
 */
export function runComplianceAudit() {
  const clients = getAllClients();
  const report = {
    date: new Date().toISOString().split('T')[0],
    totalClients: clients.length,
    overallGaps: [],
    clientReports: [],
  };

  for (const client of clients) {
    try {
      const deliverables = getClientDeliverables(client.id);
      const clientReport = {
        clientName: client.name,
        plan: client.plan,
        onboardingComplete: client.onboarding_complete === 1,
        gaps: [],
      };

      // Check onboarding compliance if not yet complete
      if (!client.onboarding_complete) {
        const onbCheck = checkOnboardingCompliance(client, deliverables);
        if (onbCheck.gaps.length > 0) {
          clientReport.gaps.push(...onbCheck.gaps);
        }
      }

      // Check overdue deliverables
      const today = new Date().toISOString().split('T')[0];
      const overdue = deliverables.filter(d =>
        d.due_date && d.due_date < today && ['pending', 'in_progress'].includes(d.status)
      );
      for (const d of overdue) {
        clientReport.gaps.push({
          sop: 'DELIVERABLE',
          task: d.name,
          issue: 'overdue',
          severity: 'critical',
          message: `"${d.name}" was due ${d.due_date} — still ${d.status}`,
        });
      }

      report.clientReports.push(clientReport);
      report.overallGaps.push(...clientReport.gaps);
    } catch (e) {
      log.warn(`SOP compliance check failed for ${client.name}`, { error: e.message });
    }
  }

  report.criticalCount = report.overallGaps.filter(g => g.severity === 'critical').length;
  report.warningCount = report.overallGaps.filter(g => g.severity === 'warning').length;
  report.infoCount = report.overallGaps.filter(g => g.severity === 'info').length;

  return report;
}

/**
 * Format the compliance audit for WhatsApp briefing.
 */
export function formatComplianceForBriefing(report) {
  if (!report || report.overallGaps.length === 0) {
    return 'All clients on track — no SOP gaps detected';
  }

  const lines = [];
  if (report.criticalCount > 0) {
    lines.push(`CRITICAL: ${report.criticalCount} items`);
    const criticals = report.overallGaps.filter(g => g.severity === 'critical').slice(0, 5);
    for (const g of criticals) {
      const client = report.clientReports.find(r => r.gaps.includes(g));
      lines.push(`- [${client?.clientName || '?'}] ${g.message}`);
    }
  }
  if (report.warningCount > 0) {
    lines.push(`WARNINGS: ${report.warningCount} items`);
    const warnings = report.overallGaps.filter(g => g.severity === 'warning').slice(0, 3);
    for (const g of warnings) {
      const client = report.clientReports.find(r => r.gaps.includes(g));
      lines.push(`- [${client?.clientName || '?'}] ${g.message}`);
    }
  }

  return lines.join('\n') || 'No SOP gaps detected';
}

/**
 * Get a specific SOP by ID.
 */
export function getSOP(sopId) {
  for (const [, sop] of Object.entries(SOPS)) {
    if (sop.id === sopId) return sop;
  }
  return null;
}

/**
 * List all SOPs with summary info.
 */
export function listSOPs() {
  return Object.entries(SOPS).map(([key, sop]) => ({
    key,
    id: sop.id,
    name: sop.name,
    description: sop.description,
    owner: sop.owner,
    stepCount: sop.steps?.length || sop.tasks?.length || 0,
  }));
}

export default {
  SOPS, listSOPs, getSOP,
  checkWeeklyCompliance, checkOnboardingCompliance,
  runComplianceAudit, formatComplianceForBriefing,
};
