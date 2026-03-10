/**
 * Team Status Service — maps team members to their ClickUp tasks and client accounts.
 * Provides team-wide visibility: who's overloaded, what's late, missing meetings, escalations.
 */
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';
import axios from 'axios';
import config from '../config.js';

const log = logger.child({ service: 'team-status' });

const api = axios.create({
  baseURL: 'https://api.clickup.com/api/v2',
  headers: { Authorization: config.CLICKUP_API_TOKEN },
  timeout: 15000,
});

const WORKSPACE_ID = config.CLICKUP_TEAM_ID;

// ==========================================================================
// Team Roster — members, ClickUp IDs, and account assignments
// ==========================================================================

export const TEAM = [
  {
    name: 'Diego', id: '', email: 'diego@chili.pa', role: 'Agency Owner',
    accounts: { escalation: [], honeymoon: [], enterprise: [], smb: [] },
    calendarId: 'diego@chili.pa',
  },
  {
    name: 'Hannah', id: '', email: 'hannah@chili.pa', role: 'Operations',
    accounts: { escalation: [], honeymoon: [], enterprise: [], smb: [] },
    calendarId: 'hannah@chili.pa',
  },
  {
    name: 'Gabriel', id: '88481221', email: 'gabriel.cardoso@chili.pa', role: 'SEO Specialist',
    calendarId: 'gabriel.cardoso@chili.pa',
    accounts: {
      escalation: ['SEO - SoEnergy BR'],
      honeymoon: [],
      enterprise: ['SEO - Daikin', 'SEO - Steck', 'SEO - ESEG', 'SEO - Joico'],
      smb: ['SEO - SGA Toyota', 'SEO - MeuPat', 'SEO - Treble BR', 'SEO - Skylane BR', 'SEO - AB Uniformes', 'SEO - Juspay', 'SEO - OnFly MX'],
    },
  },
  {
    name: 'Maria Clara', id: '94133217', email: 'maria.gibeli@chili.pa', role: 'PPC Specialist',
    calendarId: 'maria.gibeli@chili.pa',
    accounts: {
      escalation: [],
      honeymoon: [],
      enterprise: ['PPC - sicoob.com.br', 'PPC - SciSure'],
      smb: ['PPC - Chili BR', 'PPC - Infios', 'PPC - PayPay', 'PPC - soenergy.com/es/', 'PPC - Cyber Wan'],
    },
  },
  {
    name: 'Thiago', id: '88483662', email: 'thiago.gamero@chili.pa', role: 'SEO/PPC Lead',
    calendarId: 'thiago.gamero@chili.pa',
    accounts: {
      escalation: ['SEO - SoEnergy BR', 'PPC - Luna de Oriente'],
      honeymoon: ['SEO-Thiago', 'SEO - OM Style', 'SEO - Tarmex', 'SEO-Virbac'],
      enterprise: ['PPC - Rodelag', 'PPC - Avance', 'SEM - Poin Panama', 'SEM - Ri Group Panama', 'PPC - Aquatics Panama'],
      smb: ['SEO - rodelag.com', 'SEO - aquaticspanama.com', 'SEO - lunadeoriente.com', 'SEO - bongomascots.com'],
    },
  },
  {
    name: 'Kaue', id: '88481223', email: 'kaue.dias@chili.pa', role: 'SEO Specialist',
    calendarId: 'kaue.dias@chili.pa',
    accounts: {
      escalation: ['SEO - SoEnergy BR'],
      honeymoon: [],
      enterprise: ['SEO - ESEG', 'SEO - Daikin', 'SEO - Steck', 'SEO - Joico'],
      smb: ['SEO - SGA Toyota', 'SEO - OnFly MX', 'SEO - AB Uniformes', 'SEO - MeuPat'],
    },
  },
  {
    name: 'Arturo', id: '88488396', email: 'arturo@chili.pa', role: 'PPC Specialist',
    calendarId: 'arturo@chili.pa',
    accounts: {
      escalation: ['PPC - Luna de Oriente'],
      honeymoon: [],
      enterprise: ['PPC - Rodelag', 'PPC - Avance', 'SEM - Poin Panama', 'SEM - Ri Group Panama', 'PPC - Aquatics Panama'],
      smb: ['PPC - Synergy'],
    },
  },
  {
    name: 'Juan', id: '88481225', email: 'juan.amesty@chili.pa', role: 'SEO Specialist',
    calendarId: 'juan.amesty@chili.pa',
    accounts: {
      escalation: [],
      honeymoon: ['SEO - OM Style', 'SEO - Tarmex', 'SEO-Virbac'],
      enterprise: ['SEO - diunsa.hn', 'SEO - mapei.mx'],
      smb: ['SEO - multinationalpr.com', 'SEO - bongomascots.com', 'SEO - aruma.mx', 'SEO - lunadeoriente.com', 'SEO - poinpanama.com', 'SEO - rigrouppanama.com', 'SEO - rodelag.com', 'SEO - aquaticspanama.com'],
    },
  },
  {
    name: 'Igor', id: '60331930', email: 'igor@chili.pa', role: 'Account Manager',
    calendarId: 'igor@chili.pa',
    accounts: {
      escalation: [],
      honeymoon: [],
      enterprise: ['Clico', 'Innovation', 'Fullstop'],
      smb: [],
    },
  },
  {
    name: 'Marcelo', id: '', email: 'marcelo.salvatore@chili.pa', role: 'Specialist',
    calendarId: 'marcelo.salvatore@chili.pa',
    accounts: { escalation: [], honeymoon: [], enterprise: [], smb: [] },
  },
];

// ==========================================================================
// ClickUp Task Fetching (per user)
// ==========================================================================

async function getTasksForUser(userId) {
  return rateLimited('clickup', () =>
    retry(async () => {
      const { data } = await api.get(`/team/${WORKSPACE_ID}/task`, {
        params: { assignees: [userId], subtasks: true, include_closed: false, page: 0 },
      });
      return data.tasks || [];
    }, { retries: 3, label: `ClickUp tasks for user ${userId}`, shouldRetry: isRetryableHttpError })
  );
}

export async function getAllTeamTasks() {
  const results = await Promise.all(
    TEAM.map(member => {
      if (!member.id) return Promise.resolve({ ...member, tasks: [] });
      return getTasksForUser(member.id)
        .then(tasks => ({ ...member, tasks }))
        .catch(e => {
          log.warn(`Failed to get tasks for ${member.name}`, { error: e.message });
          return { ...member, tasks: [] };
        });
    })
  );
  return results;
}

// ==========================================================================
// Analysis Functions
// ==========================================================================

export function isLate(task) {
  return task.due_date && parseInt(task.due_date) < Date.now() && task.status?.status !== 'complete';
}

function hasBiweekly(tasks, accountName) {
  return tasks.some(t =>
    /biweekly|bi-weekly|quinzenal/i.test(t.name) &&
    (t.list?.name || '').toLowerCase().includes(accountName.toLowerCase())
  );
}

// ==========================================================================
// Formatted Reports
// ==========================================================================

export function formatTeamStatus(teamData) {
  const lines = teamData.map(({ name, tasks }) => {
    const late = tasks.filter(isLate).length;
    const emoji = late > 2 ? '🔴' : late > 0 ? '🟡' : '🟢';
    return `${emoji} *${name}*: ${tasks.length} tasks${late > 0 ? `, ⚠️ ${late} late` : ', ✅ ok'}`;
  });
  const totalTasks = teamData.reduce((s, m) => s + m.tasks.length, 0);
  const totalLate = teamData.reduce((s, m) => s + m.tasks.filter(isLate).length, 0);
  return `🌶️ *Team Status*\n${lines.join('\n')}\n\n📊 Total: ${totalTasks} tasks | ⚠️ ${totalLate} late`;
}

export function formatLateTasks(teamData) {
  const lines = [];
  teamData.forEach(({ name, tasks }) => {
    const late = tasks.filter(isLate);
    if (late.length) {
      lines.push(`\n👤 *${name}* (${late.length} late):`);
      late.slice(0, 4).forEach(t => {
        const days = t.due_date ? Math.floor((Date.now() - parseInt(t.due_date)) / 86400000) : 0;
        lines.push(`  ⚠️ ${t.name.slice(0, 50)} ${days > 0 ? `(${days}d overdue)` : ''}`);
      });
      if (late.length > 4) lines.push(`  ...and ${late.length - 4} more`);
    }
  });
  return lines.length ? `⏰ *Late Tasks*${lines.join('\n')}` : '✅ *No late tasks!*';
}

export function formatEscalations(teamData) {
  const all = teamData.flatMap(({ name, tasks }) =>
    tasks.filter(t => /escalat/i.test(t.name) && t.status?.status !== 'complete')
      .map(t => `  🔴 *${name}* — ${t.list?.name || ''}: ${t.name.slice(0, 50)}`)
  );
  return all.length ? `🚨 *Open Escalations (${all.length})*\n${all.join('\n')}` : '✅ *No open escalations*';
}

export function formatMissingMeetings(teamData) {
  const lines = [];
  teamData.forEach(({ name, tasks, accounts }) => {
    const allAccounts = [
      ...(accounts.escalation || []),
      ...(accounts.honeymoon || []),
      ...(accounts.enterprise || []),
      ...(accounts.smb || []),
    ];
    const missing = allAccounts.filter(a => !hasBiweekly(tasks, a));
    if (missing.length) {
      lines.push(`\n👤 *${name}*:`);
      missing.slice(0, 5).forEach(a => lines.push(`  ⚠️ ${a}`));
      if (missing.length > 5) lines.push(`  ...and ${missing.length - 5} more`);
    }
  });
  return lines.length
    ? `📅 *Accounts Missing Biweekly Meeting*${lines.join('\n')}\n\n_Create a "Biweekly Meeting" task in ClickUp for each account above._`
    : '✅ *All clients have biweekly meetings scheduled!*';
}

// ==========================================================================
// Structured Data (for Sofia's tool results)
// ==========================================================================

/**
 * Get a full team status report as structured data for Sofia.
 */
export async function getTeamStatusReport() {
  const teamData = await getAllTeamTasks();

  const members = teamData.map(({ name, email, role, tasks, accounts }) => {
    const lateTasks = tasks.filter(isLate);
    const allAccounts = [
      ...(accounts.escalation || []),
      ...(accounts.honeymoon || []),
      ...(accounts.enterprise || []),
      ...(accounts.smb || []),
    ];
    const missingMeetings = allAccounts.filter(a => !hasBiweekly(tasks, a));

    return {
      name,
      email,
      role,
      totalTasks: tasks.length,
      lateTasks: lateTasks.length,
      lateTaskDetails: lateTasks.slice(0, 5).map(t => ({
        name: t.name.slice(0, 80),
        daysOverdue: t.due_date ? Math.floor((Date.now() - parseInt(t.due_date)) / 86400000) : 0,
        list: t.list?.name || 'Unknown',
        status: t.status?.status || 'unknown',
      })),
      accountCount: allAccounts.length,
      accounts: {
        escalation: accounts.escalation?.length || 0,
        honeymoon: accounts.honeymoon?.length || 0,
        enterprise: accounts.enterprise?.length || 0,
        smb: accounts.smb?.length || 0,
      },
      missingMeetings: missingMeetings.slice(0, 5),
      missingMeetingCount: missingMeetings.length,
      health: lateTasks.length > 2 ? 'red' : lateTasks.length > 0 ? 'yellow' : 'green',
    };
  });

  const escalations = teamData.flatMap(({ name, tasks }) =>
    tasks.filter(t => /escalat/i.test(t.name) && t.status?.status !== 'complete')
      .map(t => ({ assignee: name, task: t.name.slice(0, 80), list: t.list?.name || '', status: t.status?.status }))
  );

  const totalTasks = members.reduce((s, m) => s + m.totalTasks, 0);
  const totalLate = members.reduce((s, m) => s + m.lateTasks, 0);
  const totalMissingMeetings = members.reduce((s, m) => s + m.missingMeetingCount, 0);

  return {
    date: new Date().toISOString().split('T')[0],
    summary: {
      teamSize: members.length,
      totalTasks,
      totalLate,
      totalMissingMeetings,
      openEscalations: escalations.length,
      overallHealth: totalLate > 10 ? 'red' : totalLate > 3 ? 'yellow' : 'green',
    },
    members,
    escalations,
    formatted: {
      teamStatus: formatTeamStatus(teamData),
      lateTasks: formatLateTasks(teamData),
      escalations: formatEscalations(teamData),
      missingMeetings: formatMissingMeetings(teamData),
    },
  };
}

export default {
  TEAM, getAllTeamTasks, getTeamStatusReport,
  formatTeamStatus, formatLateTasks, formatEscalations, formatMissingMeetings,
  isLate,
};
