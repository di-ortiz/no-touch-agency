import { sendWhatsApp } from '../api/whatsapp.js';
import { sendEmail, isAuthenticated as isGmailAuthenticated, fetchEmails } from '../api/gmail.js';
import { askClaude } from '../api/anthropic.js';
import {
  getAllDeliverables,
  getDeliverablesByPerson,
  getPendingDeliverablesSummary,
  getAllTeamMembers,
  updateDeliverable,
} from '../services/team-task-tracker.js';
import { extractFromEmail } from '../services/deliverable-extractor.js';
import config from '../config.js';
import logger from '../utils/logger.js';

const log = logger.child({ workflow: 'team-daily-digest' });

const APP_URL = process.env.TRACKER_APP_URL || 'http://localhost:3000';

/**
 * Main daily digest workflow. Runs every morning.
 *
 * 1. (Optional) Scan recent emails for new deliverables
 * 2. Send owner a summary digest (WhatsApp + Email)
 * 3. Send each team member their personal reminder (WhatsApp + Email)
 */
export async function runTeamDailyDigest() {
  log.info('Running team daily digest');

  // ─── Step 1: Ingest recent emails for new deliverables ────────────────
  if (isGmailAuthenticated()) {
    try {
      await ingestRecentEmails();
    } catch (err) {
      log.error('Email ingestion failed during digest', { error: err.message });
    }
  }

  // ─── Step 2: Build & send owner digest ────────────────────────────────
  try {
    await sendOwnerDigest();
  } catch (err) {
    log.error('Owner digest failed', { error: err.message });
  }

  // ─── Step 3: Send team member reminders ───────────────────────────────
  try {
    await sendTeamReminders();
  } catch (err) {
    log.error('Team reminders failed', { error: err.message });
  }

  log.info('Team daily digest completed');
}

/**
 * Ingest the last 24h of emails to auto-extract new deliverables.
 */
async function ingestRecentEmails() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const afterDate = `${yesterday.getFullYear()}/${String(yesterday.getMonth() + 1).padStart(2, '0')}/${String(yesterday.getDate()).padStart(2, '0')}`;

  const emails = await fetchEmails({
    query: 'is:inbox',
    maxResults: 30,
    after: afterDate,
  });

  log.info('Fetched recent emails for ingestion', { count: emails.length });

  let extracted = 0;
  for (const email of emails) {
    try {
      const results = await extractFromEmail({
        subject: email.subject,
        from: email.from,
        body: email.body,
        emailId: email.id,
        date: email.date,
      });
      extracted += results.filter(r => r._status === 'created').length;
    } catch (err) {
      log.debug('Email extraction skipped', { subject: email.subject, error: err.message });
    }
  }

  log.info('Email ingestion complete', { emailsProcessed: emails.length, deliverables: extracted });
}

/**
 * Send the owner a comprehensive daily digest via WhatsApp and Email.
 */
async function sendOwnerDigest() {
  const summary = getPendingDeliverablesSummary();
  const byPerson = getDeliverablesByPerson();
  const overdue = getAllDeliverables({ overdue: true });

  if (summary.total === 0) {
    const msg = "Good morning! You have no pending deliverables from your team. All clear!";
    await sendWhatsApp(msg);
    log.info('Owner digest: no pending items');
    return;
  }

  // Build the WhatsApp message
  let waMsg = `*Daily Team Tracker*\n\n`;
  waMsg += `*Overview:*\n`;
  waMsg += `Total pending: ${summary.total}\n`;
  if (summary.overdue > 0) waMsg += `Overdue: ${summary.overdue}\n`;
  if (summary.dueToday > 0) waMsg += `Due today: ${summary.dueToday}\n`;
  if (summary.dueThisWeek > 0) waMsg += `Due this week: ${summary.dueThisWeek}\n`;
  if (summary.noDueDate > 0) waMsg += `No due date: ${summary.noDueDate}\n`;

  if (overdue.length > 0) {
    waMsg += `\n*OVERDUE:*\n`;
    for (const d of overdue.slice(0, 10)) {
      const daysLate = Math.ceil((Date.now() - new Date(d.due_date).getTime()) / (1000 * 60 * 60 * 24));
      waMsg += `- ${d.assignee_name}: "${d.title}" (${daysLate}d late)\n`;
    }
    if (overdue.length > 10) waMsg += `... and ${overdue.length - 10} more\n`;
  }

  waMsg += `\n*By person:*\n`;
  for (const p of byPerson.slice(0, 15)) {
    waMsg += `\n*${p.member.name}* (${p.totalActive} items${p.overdueCount > 0 ? `, ${p.overdueCount} overdue` : ''}):\n`;
    const items = [...p.pending, ...p.inProgress].slice(0, 5);
    for (const d of items) {
      const due = d.due_date ? ` - Due: ${d.due_date}` : '';
      const flag = d.due_date && new Date(d.due_date) < new Date() ? ' *OVERDUE*' : '';
      waMsg += `  ${d.title}${due}${flag}\n`;
    }
    const remaining = p.totalActive - items.length;
    if (remaining > 0) waMsg += `  ... +${remaining} more\n`;
  }

  waMsg += `\nFull dashboard: ${APP_URL}/api/tracker/dashboard`;

  await sendWhatsApp(waMsg);

  // Also send email digest if Gmail is connected
  if (isGmailAuthenticated()) {
    try {
      const emailHtml = await buildOwnerEmailDigest(summary, byPerson, overdue);
      await sendEmail({
        to: config.TRACKER_OWNER_EMAIL || '',
        subject: `Team Tracker: ${summary.total} pending (${summary.overdue} overdue) - ${new Date().toLocaleDateString()}`,
        html: emailHtml,
      });
    } catch (err) {
      log.warn('Failed to send owner email digest', { error: err.message });
    }
  }

  log.info('Owner digest sent', { total: summary.total, overdue: summary.overdue });
}

/**
 * Send personalized reminders to each team member with pending deliverables.
 */
async function sendTeamReminders() {
  const byPerson = getDeliverablesByPerson();
  const ownerName = config.TRACKER_OWNER_NAME || 'Diego';
  let sent = 0;

  for (const p of byPerson) {
    const { member, pending, inProgress, overdueCount } = p;
    const allItems = [...pending, ...inProgress];
    if (allItems.length === 0) continue;

    // ─── WhatsApp reminder ──────────────────────────────────────────
    if (member.whatsapp_phone) {
      try {
        let msg = `Hi, ${member.name}! Friendly reminder of things to send to ${ownerName} and their due dates:\n\n`;

        allItems.forEach((d, i) => {
          const due = d.due_date ? `Due: ${d.due_date}` : 'No due date';
          const flag = d.due_date && new Date(d.due_date) < new Date() ? ' (OVERDUE)' : '';
          msg += `${String.fromCharCode(97 + i)}) ${d.title} - ${due}${flag}\n`;
        });

        msg += `\nIf you need more information on these, please check the links below:\n`;
        for (const d of allItems) {
          msg += `- ${d.title}: ${APP_URL}/api/tracker/d/${d.public_token}\n`;
        }

        await sendWhatsApp(msg, member.whatsapp_phone);

        // Update reminder counts
        for (const d of allItems) {
          updateDeliverable(d.id, {
            reminder_count: (d.reminder_count || 0) + 1,
            last_reminder_at: new Date().toISOString(),
          });
        }

        sent++;
      } catch (err) {
        log.warn('Failed to send WhatsApp reminder', { member: member.name, error: err.message });
      }
    }

    // ─── Email reminder ─────────────────────────────────────────────
    if (member.email && isGmailAuthenticated()) {
      try {
        const html = buildMemberEmailReminder(member, allItems, ownerName);
        await sendEmail({
          to: member.email,
          subject: `Reminder: ${allItems.length} pending deliverable${allItems.length > 1 ? 's' : ''} for ${ownerName}`,
          html,
        });
        sent++;
      } catch (err) {
        log.warn('Failed to send email reminder', { member: member.name, error: err.message });
      }
    }
  }

  log.info('Team reminders sent', { membersNotified: sent });
}

/**
 * Build HTML email for the owner's daily digest.
 */
async function buildOwnerEmailDigest(summary, byPerson, overdue) {
  let html = `
    <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
      <h2 style="color: #1a1a2e;">Daily Team Tracker Digest</h2>
      <p style="color: #666;">${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>

      <div style="background: #f4f4f8; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <h3 style="margin-top: 0;">Overview</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 4px 8px;">Total pending:</td><td style="padding: 4px 8px; font-weight: bold;">${summary.total}</td></tr>
          ${summary.overdue > 0 ? `<tr><td style="padding: 4px 8px; color: #e74c3c;">Overdue:</td><td style="padding: 4px 8px; font-weight: bold; color: #e74c3c;">${summary.overdue}</td></tr>` : ''}
          ${summary.dueToday > 0 ? `<tr><td style="padding: 4px 8px; color: #f39c12;">Due today:</td><td style="padding: 4px 8px; font-weight: bold; color: #f39c12;">${summary.dueToday}</td></tr>` : ''}
          <tr><td style="padding: 4px 8px;">Due this week:</td><td style="padding: 4px 8px; font-weight: bold;">${summary.dueThisWeek}</td></tr>
        </table>
      </div>`;

  if (overdue.length > 0) {
    html += `
      <div style="background: #fdf2f2; border-left: 4px solid #e74c3c; padding: 12px 16px; margin: 16px 0;">
        <h3 style="color: #e74c3c; margin-top: 0;">Overdue Items</h3>
        <ul style="padding-left: 16px;">`;
    for (const d of overdue) {
      const daysLate = Math.ceil((Date.now() - new Date(d.due_date).getTime()) / (1000 * 60 * 60 * 24));
      html += `<li><strong>${d.assignee_name}</strong>: ${d.title} <span style="color: #e74c3c;">(${daysLate} day${daysLate > 1 ? 's' : ''} late)</span></li>`;
    }
    html += `</ul></div>`;
  }

  html += `<h3>By Person</h3>`;
  for (const p of byPerson) {
    const items = [...p.pending, ...p.inProgress];
    html += `
      <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; margin: 8px 0;">
        <h4 style="margin-top: 0;">${p.member.name} <span style="font-weight: normal; color: #888;">(${p.totalActive} items${p.overdueCount > 0 ? `, <span style="color: #e74c3c;">${p.overdueCount} overdue</span>` : ''})</span></h4>
        <ul style="padding-left: 16px; margin-bottom: 0;">`;
    for (const d of items) {
      const due = d.due_date ? `Due: ${d.due_date}` : 'No due date';
      const isOverdue = d.due_date && new Date(d.due_date) < new Date();
      html += `<li${isOverdue ? ' style="color: #e74c3c;"' : ''}>${d.title} — ${due}</li>`;
    }
    html += `</ul></div>`;
  }

  html += `
      <p style="margin-top: 24px; text-align: center;">
        <a href="${APP_URL}/api/tracker/dashboard" style="background: #1a1a2e; color: white; padding: 10px 24px; text-decoration: none; border-radius: 6px;">Open Dashboard</a>
      </p>
    </div>`;

  return html;
}

/**
 * Build HTML email reminder for a team member.
 */
function buildMemberEmailReminder(member, items, ownerName) {
  let html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a2e;">Hi, ${member.name}!</h2>
      <p>Friendly reminder of things to send to <strong>${ownerName}</strong> and their due dates:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <thead>
          <tr style="background: #f4f4f8;">
            <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">#</th>
            <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">Deliverable</th>
            <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">Due Date</th>
            <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">Details</th>
          </tr>
        </thead>
        <tbody>`;

  items.forEach((d, i) => {
    const due = d.due_date || 'No date set';
    const isOverdue = d.due_date && new Date(d.due_date) < new Date();
    html += `
      <tr style="${isOverdue ? 'background: #fdf2f2;' : ''}">
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${String.fromCharCode(97 + i)})</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${d.title}${isOverdue ? ' <span style="color: #e74c3c; font-weight: bold;">OVERDUE</span>' : ''}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${due}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;"><a href="${APP_URL}/api/tracker/d/${d.public_token}">View details</a></td>
      </tr>`;
  });

  html += `
        </tbody>
      </table>
      <p>If you need more information on any of these items, click the "View details" link to see the full context and ask questions.</p>
      <p style="color: #888; font-size: 12px;">This is an automated reminder from ${ownerName}'s Team Tracker.</p>
    </div>`;

  return html;
}

export default { runTeamDailyDigest };
