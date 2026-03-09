/**
 * Chili Digital Team Briefing System
 *
 * Scheduled cron job that runs Mon-Fri at 9am BRT (12:00 UTC) and 5pm BRT (20:00 UTC).
 * Sends WhatsApp (Twilio) + Email (SendGrid) briefings to 10 Chili Digital employees
 * across 3 tiers: Leader, Director, Executive.
 *
 * Pulls task data from ClickUp workspace 9014972154.
 *
 * ENV VARS:
 *   CLICKUP_TOKEN            - ClickUp API token
 *   TWILIO_ACCOUNT_SID       - Twilio account SID
 *   TWILIO_AUTH_TOKEN         - Twilio auth token
 *   TWILIO_WHATSAPP_FROM      - Twilio WhatsApp sender (e.g. whatsapp:+14155238886)
 *   SENDGRID_API_KEY          - SendGrid API key
 *   TEST_MODE                 - "true" → send all messages only to Diego
 *   TEST_SEND_NOW             - "true" → fire once immediately on startup
 */

import cron from 'node-cron';
import axios from 'axios';
import twilio from 'twilio';
import sgMail from '@sendgrid/mail';
import logger from './src/utils/logger.js';

const log = logger.child({ service: 'briefing' });

// ── Configuration ──────────────────────────────────────────────────────────────

const CLICKUP_WORKSPACE_ID = '9014972154';
const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN || process.env.CLICKUP_API_TOKEN || '';
const TEST_MODE = process.env.TEST_MODE === 'true';
const TEST_SEND_NOW = process.env.TEST_SEND_NOW === 'true';

const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const SENDGRID_FROM = 'noreply@chili.pa';

// ── Team roster ────────────────────────────────────────────────────────────────

const LEADERS = [
  { name: 'Gabriel', role: 'SEO BR', clickupId: '88481221', email: 'gabriel.cardoso@chili.pa', whatsapp: 'whatsapp:+55XXXXXXXXXXX' },
  { name: 'Maria Clara', role: 'PPC BR', clickupId: '94133217', email: 'maria.gibeli@chili.pa', whatsapp: 'whatsapp:+55XXXXXXXXXXX' },
  { name: 'Thiago', role: 'PPC ES+INT', clickupId: '88483662', email: 'thiago.gamero@chili.pa', whatsapp: 'whatsapp:+55XXXXXXXXXXX' },
  { name: 'Kaue', role: 'SEO Support', clickupId: '88481223', email: 'kaue.dias@chili.pa', whatsapp: 'whatsapp:+55XXXXXXXXXXX' },
  { name: 'Arturo', role: 'PPC Spanish+English', clickupId: '88488396', email: 'arturo@chili.pa', whatsapp: 'whatsapp:+55XXXXXXXXXXX' },
  { name: 'Juan', role: 'SEO Spanish+English', clickupId: '88481225', email: 'juan.amesty@chili.pa', whatsapp: 'whatsapp:+55XXXXXXXXXXX' },
  { name: 'Igor', role: 'IT+R&D', clickupId: '60331930', email: 'igor@chili.pa', whatsapp: 'whatsapp:+55XXXXXXXXXXX' },
];

const DIRECTOR = { name: 'Marcelo', clickupId: '94216978', email: 'marcelo.salvatore@chili.pa', whatsapp: 'whatsapp:+55XXXXXXXXXXX' };

const EXECUTIVES = [
  { name: 'Diego', email: 'diego@chili.pa', whatsapp: 'whatsapp:+5548991081505' },
  { name: 'Hannah', email: 'hannah@chili.pa', whatsapp: 'whatsapp:+55XXXXXXXXXXX' },
];

const DIEGO_WHATSAPP = 'whatsapp:+5548991081505';

// ── ClickUp API helpers ────────────────────────────────────────────────────────

const clickupApi = axios.create({
  baseURL: 'https://api.clickup.com/api/v2',
  headers: { Authorization: CLICKUP_TOKEN },
  timeout: 20000,
});

async function clickupGet(path, params = {}) {
  try {
    const res = await clickupApi.get(path, { params });
    return res.data;
  } catch (err) {
    log.error(`ClickUp API error: ${path}`, { error: err.response?.data || err.message });
    return null;
  }
}

/**
 * Get all tasks assigned to a specific user across the workspace.
 */
async function getTasksForUser(clickupId) {
  const data = await clickupGet(`/team/${CLICKUP_WORKSPACE_ID}/task`, {
    'assignees[]': clickupId,
    include_closed: false,
    subtasks: true,
    order_by: 'due_date',
  });
  return data?.tasks || [];
}

/**
 * Get overdue tasks for a user.
 */
function getOverdueTasks(tasks) {
  const now = Date.now();
  return tasks.filter(t => {
    if (!t.due_date) return false;
    return parseInt(t.due_date, 10) < now && !['closed', 'complete', 'done'].includes(t.status?.status?.toLowerCase());
  });
}

/**
 * Classify tasks by priority tier.
 * Priority in ClickUp: 1=urgent, 2=high, 3=normal, 4=low
 */
function classifyTasks(tasks) {
  const escalation = [];
  const honeymoon = [];
  const enterprise = [];
  const smb = [];

  for (const t of tasks) {
    const tags = (t.tags || []).map(tag => tag.name?.toLowerCase());
    const name = (t.name || '').toLowerCase();

    if (tags.includes('escalation') || t.priority?.id === '1') {
      escalation.push(t);
    } else if (tags.includes('honeymoon') || tags.includes('onboarding') || name.includes('honeymoon')) {
      honeymoon.push(t);
    } else if (tags.includes('enterprise')) {
      enterprise.push(t);
    } else {
      smb.push(t);
    }
  }

  return { escalation, honeymoon, enterprise, smb };
}

/**
 * Check if tasks are contractual deliverables vs ad-hoc.
 */
function getDeliverableRatio(tasks) {
  let contractual = 0;
  let adhoc = 0;
  for (const t of tasks) {
    const tags = (t.tags || []).map(tag => tag.name?.toLowerCase());
    if (tags.includes('contractual') || tags.includes('deliverable') || tags.includes('recurring')) {
      contractual++;
    } else {
      adhoc++;
    }
  }
  const total = contractual + adhoc;
  return { contractual, adhoc, total, ratio: total > 0 ? `${contractual}/${total}` : '0/0' };
}

/**
 * Get all lists in workspace to find client accounts and check biweekly meeting tasks.
 */
async function getSpacesAndLists() {
  const spacesData = await clickupGet(`/team/${CLICKUP_WORKSPACE_ID}/space`, { archived: false });
  if (!spacesData?.spaces) return [];

  const results = [];
  for (const space of spacesData.spaces) {
    const foldersData = await clickupGet(`/space/${space.id}/folder`, { archived: false });
    if (!foldersData?.folders) continue;

    for (const folder of foldersData.folders) {
      const listsData = await clickupGet(`/folder/${folder.id}/list`, { archived: false });
      if (!listsData?.lists) continue;

      for (const list of listsData.lists) {
        results.push({
          spaceId: space.id,
          spaceName: space.name,
          folderId: folder.id,
          folderName: folder.name,
          listId: list.id,
          listName: list.name,
        });
      }
    }
  }
  return results;
}

/**
 * Check biweekly meeting compliance for a leader's tasks.
 * Looks for tasks containing "biweekly meeting" or "reunião quinzenal" in the name.
 */
function checkBiweeklyMeetings(tasks, clientLists) {
  const meetingTasks = tasks.filter(t => {
    const name = (t.name || '').toLowerCase();
    return name.includes('biweekly') || name.includes('bi-weekly') ||
           name.includes('quinzenal') || name.includes('meeting') && name.includes('client');
  });

  const clientsWithMeetings = new Set();
  for (const mt of meetingTasks) {
    // Try to extract client name from task name like "[ClientName] biweekly meeting"
    const match = mt.name.match(/\[([^\]]+)\]/);
    if (match) clientsWithMeetings.add(match[1].toLowerCase());
    if (mt.list?.name) clientsWithMeetings.add(mt.list.name.toLowerCase());
  }

  const missing = [];
  for (const cl of clientLists) {
    if (!clientsWithMeetings.has(cl.listName.toLowerCase()) &&
        !clientsWithMeetings.has(cl.folderName.toLowerCase())) {
      missing.push(cl.folderName || cl.listName);
    }
  }

  return { meetingCount: meetingTasks.length, missing: [...new Set(missing)] };
}

// ── Message builders ───────────────────────────────────────────────────────────

function buildLeaderMessage(leader, tasks, clientLists) {
  const overdue = getOverdueTasks(tasks);
  const classified = classifyTasks(tasks);
  const deliverables = getDeliverableRatio(tasks);
  const meetings = checkBiweeklyMeetings(tasks, clientLists);

  const activeTasks = tasks.filter(t => !['closed', 'complete', 'done'].includes(t.status?.status?.toLowerCase()));

  let msg = `*Chili Briefing — ${leader.name} (${leader.role})*\n`;
  msg += `_${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}_\n\n`;

  msg += `*Active tasks:* ${activeTasks.length}\n`;
  msg += `*Late tasks:* ${overdue.length}\n`;

  if (overdue.length > 0) {
    msg += '\n_Late:_\n';
    for (const t of overdue.slice(0, 10)) {
      const daysLate = Math.ceil((Date.now() - parseInt(t.due_date, 10)) / 86400000);
      msg += `  • ${t.name} _(${daysLate}d late)_\n`;
    }
    if (overdue.length > 10) msg += `  _...and ${overdue.length - 10} more_\n`;
  }

  msg += '\n*By priority:*\n';
  if (classified.escalation.length > 0) msg += `  🔴 Escalation: ${classified.escalation.length}\n`;
  if (classified.honeymoon.length > 0) msg += `  🟡 Honeymoon/New: ${classified.honeymoon.length}\n`;
  if (classified.enterprise.length > 0) msg += `  🔵 Enterprise: ${classified.enterprise.length}\n`;
  msg += `  ⚪ SMB/Other: ${classified.smb.length}\n`;

  msg += `\n*Deliverables:* ${deliverables.ratio} contractual vs ad-hoc\n`;

  if (meetings.missing.length > 0) {
    msg += `\n*⚠️ Missing biweekly meetings:*\n`;
    for (const m of meetings.missing.slice(0, 5)) {
      msg += `  • ${m}\n`;
    }
    if (meetings.missing.length > 5) msg += `  _...and ${meetings.missing.length - 5} more_\n`;
  } else {
    msg += `\n✅ All clients have biweekly meetings scheduled\n`;
  }

  return msg;
}

function buildDirectorMessage(leaderData) {
  let msg = `*Chili Briefing — Director Overview*\n`;
  msg += `_${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}_\n\n`;

  // Team health
  let totalTasks = 0;
  let totalOverdue = 0;
  const lateByPerson = [];
  const allEscalations = [];

  for (const { leader, tasks } of leaderData) {
    const overdue = getOverdueTasks(tasks);
    const activeTasks = tasks.filter(t => !['closed', 'complete', 'done'].includes(t.status?.status?.toLowerCase()));
    totalTasks += activeTasks.length;
    totalOverdue += overdue.length;
    if (overdue.length > 0) {
      lateByPerson.push({ name: leader.name, count: overdue.length });
    }
    const classified = classifyTasks(tasks);
    for (const e of classified.escalation) {
      allEscalations.push({ task: e.name, owner: leader.name });
    }
  }

  const healthPct = totalTasks > 0 ? Math.round(((totalTasks - totalOverdue) / totalTasks) * 100) : 100;

  msg += `*Team health:* ${healthPct}% on-time\n`;
  msg += `*Total active:* ${totalTasks} | *Overdue:* ${totalOverdue}\n\n`;

  // Late tasks ranked by person
  lateByPerson.sort((a, b) => b.count - a.count);
  if (lateByPerson.length > 0) {
    msg += '*Late tasks by person:*\n';
    for (const p of lateByPerson) {
      msg += `  • ${p.name}: ${p.count} late\n`;
    }
    msg += '\n';
  }

  // Open escalations
  if (allEscalations.length > 0) {
    msg += `*Open escalations (${allEscalations.length}):*\n`;
    for (const e of allEscalations.slice(0, 5)) {
      msg += `  • ${e.task} _(${e.owner})_\n`;
    }
    if (allEscalations.length > 5) msg += `  _...and ${allEscalations.length - 5} more_\n`;
    msg += '\n';
  }

  // Contractual coverage
  let totalContractual = 0;
  let totalAll = 0;
  for (const { tasks } of leaderData) {
    const d = getDeliverableRatio(tasks);
    totalContractual += d.contractual;
    totalAll += d.total;
  }
  const coveragePct = totalAll > 0 ? Math.round((totalContractual / totalAll) * 100) : 0;
  msg += `*Contractual coverage:* ${coveragePct}% (${totalContractual}/${totalAll})\n`;

  return msg;
}

function buildExecutiveMessage(leaderData) {
  let msg = `*Chili Briefing — Executive Summary*\n`;
  msg += `_${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}_\n\n`;

  let totalTasks = 0;
  let totalOverdue = 0;
  const lateByPerson = [];
  const allEscalations = [];
  const honeymoonAccounts = [];

  // BU breakdown
  const buStats = { BR: { tasks: 0, overdue: 0 }, PA: { tasks: 0, overdue: 0 }, INT: { tasks: 0, overdue: 0 } };

  for (const { leader, tasks } of leaderData) {
    const overdue = getOverdueTasks(tasks);
    const activeTasks = tasks.filter(t => !['closed', 'complete', 'done'].includes(t.status?.status?.toLowerCase()));
    totalTasks += activeTasks.length;
    totalOverdue += overdue.length;
    lateByPerson.push({ name: leader.name, count: overdue.length });

    const classified = classifyTasks(tasks);
    for (const e of classified.escalation) {
      allEscalations.push({ task: e.name, owner: leader.name });
    }
    for (const h of classified.honeymoon) {
      honeymoonAccounts.push({ task: h.name, owner: leader.name });
    }

    // Map leader to BU
    let bu = 'INT';
    if (leader.role.includes('BR')) bu = 'BR';
    else if (leader.role.includes('Spanish') || leader.role.includes('ES')) bu = 'PA';

    buStats[bu].tasks += activeTasks.length;
    buStats[bu].overdue += overdue.length;
  }

  // Agency health score
  const healthScore = totalTasks > 0 ? Math.round(((totalTasks - totalOverdue) / totalTasks) * 100) : 100;
  msg += `*Agency health:* ${healthScore}%\n`;
  msg += `*Active:* ${totalTasks} | *Overdue:* ${totalOverdue}\n\n`;

  // BU breakdown
  msg += '*BU breakdown:*\n';
  for (const [bu, stats] of Object.entries(buStats)) {
    if (stats.tasks > 0) {
      const pct = Math.round(((stats.tasks - stats.overdue) / stats.tasks) * 100);
      msg += `  ${bu}: ${stats.tasks} tasks, ${pct}% on-time\n`;
    }
  }
  msg += '\n';

  // Open escalations
  if (allEscalations.length > 0) {
    msg += `*Open escalations (${allEscalations.length}):*\n`;
    for (const e of allEscalations.slice(0, 3)) {
      msg += `  • ${e.task} _(${e.owner})_\n`;
    }
    msg += '\n';
  }

  // Honeymoon accounts
  if (honeymoonAccounts.length > 0) {
    msg += `*Onboarding/Honeymoon (${honeymoonAccounts.length}):*\n`;
    for (const h of honeymoonAccounts.slice(0, 3)) {
      msg += `  • ${h.task} _(${h.owner})_\n`;
    }
    msg += '\n';
  }

  // Top 3 people with most late tasks
  lateByPerson.sort((a, b) => b.count - a.count);
  const topLate = lateByPerson.filter(p => p.count > 0).slice(0, 3);
  if (topLate.length > 0) {
    msg += '*Most late tasks:*\n';
    for (const p of topLate) {
      msg += `  • ${p.name}: ${p.count}\n`;
    }
  }

  return msg;
}

// ── Delivery (WhatsApp + Email) ────────────────────────────────────────────────

async function sendWhatsApp(to, body) {
  const recipient = TEST_MODE ? DIEGO_WHATSAPP : to;
  if (!twilioClient) {
    log.warn('Twilio not configured, skipping WhatsApp send', { to: recipient });
    return;
  }
  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: recipient,
      body,
    });
    log.info('WhatsApp sent', { to: recipient, chars: body.length });
  } catch (err) {
    log.error('WhatsApp send failed', { to: recipient, error: err.message });
  }
}

async function sendEmail(to, subject, textBody) {
  const recipient = TEST_MODE ? 'diego@chili.pa' : to;
  if (!process.env.SENDGRID_API_KEY) {
    log.warn('SendGrid not configured, skipping email send', { to: recipient });
    return;
  }
  try {
    await sgMail.send({
      to: recipient,
      from: SENDGRID_FROM,
      subject,
      text: textBody,
      html: textBody.replace(/\n/g, '<br>').replace(/\*([^*]+)\*/g, '<b>$1</b>').replace(/_([^_]+)_/g, '<i>$1</i>'),
    });
    log.info('Email sent', { to: recipient, subject });
  } catch (err) {
    log.error('Email send failed', { to: recipient, error: err.message });
  }
}

// ── Main briefing runner ───────────────────────────────────────────────────────

export async function runBriefing() {
  log.info('Starting team briefing', { testMode: TEST_MODE });

  // Skip weekends
  const day = new Date().getDay();
  if (day === 0 || day === 6) {
    log.info('Skipping briefing — weekend');
    return;
  }

  // Fetch all workspace lists for meeting compliance check
  let clientLists = [];
  try {
    clientLists = await getSpacesAndLists();
    log.info(`Fetched ${clientLists.length} workspace lists`);
  } catch (err) {
    log.error('Failed to fetch workspace lists', { error: err.message });
  }

  // ── Tier 1: Leaders ──────────────────────────────────────────────────────
  const leaderData = [];

  for (const leader of LEADERS) {
    try {
      const tasks = await getTasksForUser(leader.clickupId);
      leaderData.push({ leader, tasks });

      const msg = buildLeaderMessage(leader, tasks, clientLists);
      const subject = `Chili Briefing — ${leader.name} (${leader.role})`;

      await sendWhatsApp(leader.whatsapp, msg);
      await sendEmail(leader.email, subject, msg);

      log.info(`Tier 1 briefing sent: ${leader.name}`, { taskCount: tasks.length });
    } catch (err) {
      log.error(`Failed to process leader: ${leader.name}`, { error: err.message });
    }
  }

  // ── Tier 2: Director ─────────────────────────────────────────────────────
  try {
    const directorMsg = buildDirectorMessage(leaderData);
    const subject = 'Chili Briefing — Director Overview';

    await sendWhatsApp(DIRECTOR.whatsapp, directorMsg);
    await sendEmail(DIRECTOR.email, subject, directorMsg);

    log.info('Tier 2 briefing sent: Director');
  } catch (err) {
    log.error('Failed to send director briefing', { error: err.message });
  }

  // ── Tier 3: Executive ────────────────────────────────────────────────────
  try {
    const execMsg = buildExecutiveMessage(leaderData);
    const subject = 'Chili Briefing — Executive Summary';

    for (const exec of EXECUTIVES) {
      await sendWhatsApp(exec.whatsapp, execMsg);
      await sendEmail(exec.email, subject, execMsg);
    }

    log.info('Tier 3 briefing sent: Executives');
  } catch (err) {
    log.error('Failed to send executive briefing', { error: err.message });
  }

  log.info('Team briefing complete');
}

// ── Cron scheduling ────────────────────────────────────────────────────────────

export function startBriefingSchedule() {
  // Mon-Fri at 9am BRT (12:00 UTC)
  cron.schedule('0 12 * * 1-5', () => {
    runBriefing().catch(err => log.error('Morning briefing failed', { error: err.message }));
  }, { timezone: 'America/Sao_Paulo' });

  // Mon-Fri at 5pm BRT (20:00 UTC)
  cron.schedule('0 20 * * 1-5', () => {
    runBriefing().catch(err => log.error('Afternoon briefing failed', { error: err.message }));
  }, { timezone: 'America/Sao_Paulo' });

  log.info('Briefing cron jobs registered (9am + 5pm BRT, Mon-Fri)');

  // Test mode: fire immediately
  if (TEST_SEND_NOW) {
    log.info('TEST_SEND_NOW=true — firing briefing immediately');
    runBriefing().catch(err => log.error('Test briefing failed', { error: err.message }));
  }
}
