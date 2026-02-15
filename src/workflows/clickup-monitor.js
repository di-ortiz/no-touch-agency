import logger from '../utils/logger.js';
import { sendAlert, sendWhatsApp } from '../api/whatsapp.js';
import * as clickup from '../api/clickup.js';
import config from '../config.js';

const log = logger.child({ workflow: 'clickup-monitor' });

/**
 * ClickUp Task Monitoring System
 * Tracks deadlines, sends escalating reminders, and generates daily standup reports.
 */

/**
 * Run the full task monitoring check.
 * Called by the scheduler multiple times a day.
 */
export async function runTaskMonitor() {
  log.info('Running ClickUp task monitor');

  const spaceId = config.CLICKUP_PPC_SPACE_ID;
  if (!spaceId) {
    log.warn('CLICKUP_PPC_SPACE_ID not configured');
    return;
  }

  const [overdue, dueToday, dueSoon] = await Promise.all([
    clickup.getOverdueTasks(spaceId).catch(e => ({ tasks: [] })),
    clickup.getTasksDueToday(spaceId).catch(e => ({ tasks: [] })),
    clickup.getTasksDueSoon(spaceId, 3).catch(e => ({ tasks: [] })),
  ]);

  const overdueTasks = overdue.tasks || [];
  const todayTasks = dueToday.tasks || [];
  const soonTasks = dueSoon.tasks || [];

  // Send overdue alerts
  if (overdueTasks.length > 0) {
    const overdueMessages = overdueTasks.map(t => {
      const dueDate = t.due_date ? new Date(parseInt(t.due_date)) : null;
      const daysOverdue = dueDate ? Math.floor((Date.now() - dueDate.getTime()) / (1000 * 60 * 60 * 24)) : 0;
      const assignee = t.assignees?.[0]?.username || 'Unassigned';
      return `• *${t.name}*\n  Assignee: ${assignee} | ${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} overdue | Status: ${t.status?.status || 'unknown'}`;
    });

    await sendAlert('critical', `${overdueTasks.length} Overdue Task${overdueTasks.length !== 1 ? 's' : ''}`, overdueMessages.join('\n\n'));
  }

  // Check for tasks due today without progress
  const stuckTasks = todayTasks.filter(t => {
    const status = t.status?.status?.toLowerCase() || '';
    return !status.includes('progress') && !status.includes('review') && !status.includes('complete');
  });

  if (stuckTasks.length > 0) {
    const messages = stuckTasks.map(t => {
      const assignee = t.assignees?.[0]?.username || 'Unassigned';
      return `• *${t.name}* (${assignee}) - Status: ${t.status?.status || 'not started'}`;
    });

    await sendAlert('warning', `${stuckTasks.length} Task${stuckTasks.length !== 1 ? 's' : ''} Due Today Not In Progress`, messages.join('\n'));
  }

  // Check task dependencies (simplified version)
  await checkDependencies(todayTasks);

  return {
    overdue: overdueTasks.length,
    dueToday: todayTasks.length,
    dueSoon: soonTasks.length,
    stuckToday: stuckTasks.length,
  };
}

/**
 * Generate daily standup report.
 */
export async function generateDailyStandup() {
  log.info('Generating daily standup');

  const spaceId = config.CLICKUP_PPC_SPACE_ID;
  if (!spaceId) return;

  const [overdue, dueToday, dueSoon] = await Promise.all([
    clickup.getOverdueTasks(spaceId).catch(() => ({ tasks: [] })),
    clickup.getTasksDueToday(spaceId).catch(() => ({ tasks: [] })),
    clickup.getTasksDueSoon(spaceId, 7).catch(() => ({ tasks: [] })),
  ]);

  const overdueTasks = overdue.tasks || [];
  const todayTasks = dueToday.tasks || [];
  const soonTasks = dueSoon.tasks || [];

  // Group by assignee
  const byAssignee = {};
  for (const task of [...overdueTasks, ...todayTasks]) {
    const assignee = task.assignees?.[0]?.username || 'Unassigned';
    if (!byAssignee[assignee]) byAssignee[assignee] = { overdue: [], today: [] };
    if (overdueTasks.includes(task)) {
      byAssignee[assignee].overdue.push(task.name);
    } else {
      byAssignee[assignee].today.push(task.name);
    }
  }

  let message = `📋 *Daily Standup Report*\n${new Date().toLocaleDateString()}\n\n`;
  message += `📊 *Summary:*\n`;
  message += `• Overdue: ${overdueTasks.length}\n`;
  message += `• Due Today: ${todayTasks.length}\n`;
  message += `• Coming Up (7 days): ${soonTasks.length}\n\n`;

  for (const [assignee, tasks] of Object.entries(byAssignee)) {
    message += `👤 *${assignee}:*\n`;
    if (tasks.overdue.length > 0) {
      message += `  🔴 Overdue: ${tasks.overdue.join(', ')}\n`;
    }
    if (tasks.today.length > 0) {
      message += `  🟡 Today: ${tasks.today.join(', ')}\n`;
    }
    message += '\n';
  }

  // Capacity analysis
  const totalOpen = overdueTasks.length + todayTasks.length + soonTasks.length;
  const uniqueAssignees = Object.keys(byAssignee).filter(a => a !== 'Unassigned').length;
  const avgLoad = uniqueAssignees > 0 ? (totalOpen / uniqueAssignees).toFixed(1) : 'N/A';

  message += `📈 *Capacity:*\n`;
  message += `• Active team members: ${uniqueAssignees}\n`;
  message += `• Avg tasks per person: ${avgLoad}\n`;

  if (parseFloat(avgLoad) > 10) {
    message += `⚠️ *Team is overloaded. Consider pausing new client intake.*\n`;
  }

  await sendWhatsApp(message);
  return { overdue: overdueTasks.length, today: todayTasks.length, capacity: avgLoad };
}

/**
 * Check task dependencies (simplified).
 * Alerts if a campaign launch task exists without required prerequisites.
 */
async function checkDependencies(tasks) {
  const launchTasks = tasks.filter(t =>
    t.name.toLowerCase().includes('launch') ||
    t.name.toLowerCase().includes('go live'),
  );

  for (const task of launchTasks) {
    // Check if there are pending prerequisite tasks in same list
    const tags = (task.tags || []).map(t => t.name.toLowerCase());
    const warnings = [];

    // Simple heuristic: check if common prerequisites are in the task's description or comments
    if (!tags.includes('brief-approved') && !task.description?.toLowerCase().includes('brief approved')) {
      warnings.push('Brief may not be approved');
    }
    if (!tags.includes('creative-approved') && !task.description?.toLowerCase().includes('creative approved')) {
      warnings.push('Creative may not be approved');
    }
    if (!tags.includes('tracking-verified') && !task.description?.toLowerCase().includes('tracking verified')) {
      warnings.push('Tracking may not be verified');
    }

    if (warnings.length > 0) {
      await sendAlert('warning', `Launch Task Dependency Check: ${task.name}`,
        `The following prerequisites may be missing:\n${warnings.map(w => `• ${w}`).join('\n')}\n\nPlease verify before launching.`);
    }
  }
}

/**
 * Send escalating reminder for a specific task.
 * @param {object} task - ClickUp task
 * @param {number} daysUntilDue - Negative = overdue
 */
export async function sendReminder(task, daysUntilDue) {
  const assignee = task.assignees?.[0]?.username || 'Unassigned';
  let level, title;

  if (daysUntilDue <= -1) {
    level = 'critical';
    title = `OVERDUE: ${task.name}`;
  } else if (daysUntilDue === 0) {
    level = 'warning';
    title = `DUE TODAY: ${task.name}`;
  } else if (daysUntilDue === 1) {
    level = 'warning';
    title = `Due Tomorrow: ${task.name}`;
  } else {
    level = 'info';
    title = `Due in ${daysUntilDue} days: ${task.name}`;
  }

  await sendAlert(level, title,
    `Assignee: ${assignee}\nStatus: ${task.status?.status || 'unknown'}\nList: ${task.list?.name || 'unknown'}`);
}

export default { runTaskMonitor, generateDailyStandup, sendReminder };
