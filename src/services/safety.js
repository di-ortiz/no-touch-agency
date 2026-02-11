import config from '../config.js';
import logger from '../utils/logger.js';
import { auditLog } from './cost-tracker.js';

const log = logger.child({ workflow: 'safety' });

/**
 * Safety approval levels for different operations.
 */
export const ApprovalLevel = {
  AUTO: 'auto',
  REQUIRES_APPROVAL: 'requires_approval',
  ALWAYS_REQUIRES_APPROVAL: 'always_requires_approval',
};

/**
 * Determine the approval level for a budget change.
 * @param {number} dailyChangeCents - Absolute daily budget change in cents
 * @param {number} totalClientBudgetCents - Total client budget
 */
export function getBudgetChangeApproval(dailyChangeCents, totalClientBudgetCents) {
  // >20% of total client budget always needs approval
  if (totalClientBudgetCents > 0 && dailyChangeCents > totalClientBudgetCents * 0.2) {
    return ApprovalLevel.ALWAYS_REQUIRES_APPROVAL;
  }
  // >$50/day needs approval
  if (dailyChangeCents > config.AUTO_APPROVE_BUDGET_CHANGE_LIMIT) {
    return ApprovalLevel.REQUIRES_APPROVAL;
  }
  return ApprovalLevel.AUTO;
}

/**
 * Determine if a bid adjustment can be auto-approved.
 */
export function getBidChangeApproval(changePercent) {
  if (Math.abs(changePercent) <= config.AUTO_APPROVE_BID_CHANGE_PCT) {
    return ApprovalLevel.AUTO;
  }
  return ApprovalLevel.REQUIRES_APPROVAL;
}

/**
 * Check if a campaign should be auto-paused for safety.
 */
export function shouldAutoPause(campaign) {
  const { roas, roasTarget, cpa, cpaTarget, spend, conversions, daysRunning } = campaign;

  // Auto-pause if ROAS < 0.2x target for 3+ days
  if (roasTarget > 0 && roas < roasTarget * config.AUTO_PAUSE_ROAS_THRESHOLD && daysRunning >= 3) {
    return { pause: true, reason: `ROAS ${roas.toFixed(2)} is below safety threshold (${(roasTarget * config.AUTO_PAUSE_ROAS_THRESHOLD).toFixed(2)}) for ${daysRunning} days` };
  }

  // Auto-pause if CPA > 3x target
  if (cpaTarget > 0 && cpa > cpaTarget * config.AUTO_PAUSE_CPA_MULTIPLIER) {
    return { pause: true, reason: `CPA $${(cpa / 100).toFixed(2)} exceeds ${config.AUTO_PAUSE_CPA_MULTIPLIER}x target ($${(cpaTarget / 100).toFixed(2)})` };
  }

  // Alert if significant spend with zero conversions
  if (spend > config.ZERO_CONVERSION_SPEND_ALERT && conversions === 0) {
    return { pause: true, reason: `$${(spend / 100).toFixed(2)} spent with zero conversions` };
  }

  return { pause: false };
}

/**
 * Validate a campaign action before execution.
 * Returns { allowed, level, reason }.
 */
export function validateAction(action) {
  const BLOCKED_ACTIONS = ['delete_campaign', 'remove_payment', 'change_access', 'modify_contract'];

  if (BLOCKED_ACTIONS.includes(action.type)) {
    log.error(`Blocked dangerous action: ${action.type}`, action);
    return {
      allowed: false,
      level: 'blocked',
      reason: `Action "${action.type}" is permanently blocked for safety. Only pause operations are allowed.`,
    };
  }

  // Campaign launch always needs approval
  if (action.type === 'launch_campaign') {
    return { allowed: false, level: ApprovalLevel.ALWAYS_REQUIRES_APPROVAL, reason: 'Campaign launches require human approval' };
  }

  // Budget changes
  if (action.type === 'change_budget') {
    const level = getBudgetChangeApproval(action.amountCents, action.totalClientBudgetCents || 0);
    if (level === ApprovalLevel.AUTO) {
      return { allowed: true, level, reason: `Budget change of $${(action.amountCents / 100).toFixed(2)} within auto-approve limit` };
    }
    return { allowed: false, level, reason: `Budget change of $${(action.amountCents / 100).toFixed(2)} requires approval` };
  }

  // Bid changes
  if (action.type === 'change_bid') {
    const level = getBidChangeApproval(action.changePercent);
    if (level === ApprovalLevel.AUTO) {
      return { allowed: true, level, reason: `Bid change of ${action.changePercent}% within auto-approve limit` };
    }
    return { allowed: false, level, reason: `Bid change of ${action.changePercent}% requires approval` };
  }

  // Pause is always safe
  if (action.type === 'pause_campaign' || action.type === 'pause_adset' || action.type === 'pause_ad') {
    return { allowed: true, level: ApprovalLevel.AUTO, reason: 'Pause actions are always safe' };
  }

  // Default: require approval for unknown actions
  return { allowed: false, level: ApprovalLevel.REQUIRES_APPROVAL, reason: `Unknown action type "${action.type}" requires approval` };
}

/**
 * Execute an action with safety checks and audit logging.
 */
export async function safeExecute(action, executeFn) {
  const validation = validateAction(action);

  auditLog({
    action: action.type,
    workflow: action.workflow,
    clientId: action.clientId,
    platform: action.platform,
    details: { action, validation },
    approvedBy: validation.allowed ? 'auto' : 'pending',
    result: validation.allowed ? 'executing' : 'awaiting_approval',
  });

  if (!validation.allowed) {
    log.info(`Action requires approval: ${action.type}`, { reason: validation.reason, level: validation.level });
    return { executed: false, ...validation };
  }

  try {
    log.info(`Auto-executing: ${action.type}`, { reason: validation.reason });
    const result = await executeFn();

    auditLog({
      action: action.type,
      workflow: action.workflow,
      clientId: action.clientId,
      platform: action.platform,
      details: { action, result },
      approvedBy: 'auto',
      result: 'success',
      rollbackData: action.rollbackData,
    });

    return { executed: true, result, ...validation };
  } catch (error) {
    log.error(`Action failed: ${action.type}`, { error: error.message });
    auditLog({
      action: action.type,
      workflow: action.workflow,
      clientId: action.clientId,
      platform: action.platform,
      details: { action, error: error.message },
      approvedBy: 'auto',
      result: 'failed',
    });
    return { executed: false, error: error.message, ...validation };
  }
}
