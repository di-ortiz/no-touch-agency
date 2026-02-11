import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'clickup' });

const api = axios.create({
  baseURL: 'https://api.clickup.com/api/v2',
  headers: { Authorization: config.CLICKUP_API_TOKEN },
  timeout: 15000,
});

async function request(method, path, data, params) {
  return rateLimited('clickup', () =>
    retry(async () => {
      const res = await api({ method, url: path, data, params });
      return res.data;
    }, { retries: 3, label: `ClickUp ${method} ${path}`, shouldRetry: isRetryableHttpError })
  );
}

// --- Tasks ---

export async function getTasks(listId, opts = {}) {
  return request('get', `/list/${listId}/task`, null, {
    include_closed: opts.includeClosed || false,
    subtasks: true,
    ...opts,
  });
}

export async function getTask(taskId) {
  return request('get', `/task/${taskId}`);
}

export async function createTask(listId, taskData) {
  return request('post', `/list/${listId}/task`, taskData);
}

export async function updateTask(taskId, updates) {
  return request('put', `/task/${taskId}`, updates);
}

export async function addComment(taskId, commentText) {
  return request('post', `/task/${taskId}/comment`, { comment_text: commentText });
}

// --- Spaces & Lists ---

export async function getSpaces() {
  return request('get', `/team/${config.CLICKUP_TEAM_ID}/space`, null, { archived: false });
}

export async function getFolders(spaceId) {
  return request('get', `/space/${spaceId}/folder`, null, { archived: false });
}

export async function getLists(folderId) {
  return request('get', `/folder/${folderId}/list`, null, { archived: false });
}

// --- Filtered Queries ---

export async function getOverdueTasks(spaceId) {
  const now = Date.now();
  return request('get', `/team/${config.CLICKUP_TEAM_ID}/task`, null, {
    space_ids: [spaceId || config.CLICKUP_PPC_SPACE_ID],
    'due_date_lt': now,
    'statuses[]': ['open', 'in progress', 'review'],
    subtasks: true,
    include_closed: false,
  });
}

export async function getTasksDueToday(spaceId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  return request('get', `/team/${config.CLICKUP_TEAM_ID}/task`, null, {
    space_ids: [spaceId || config.CLICKUP_PPC_SPACE_ID],
    'due_date_gt': startOfDay.getTime(),
    'due_date_lt': endOfDay.getTime(),
    subtasks: true,
    include_closed: false,
  });
}

export async function getTasksDueSoon(spaceId, daysAhead = 3) {
  const now = Date.now();
  const future = now + daysAhead * 24 * 60 * 60 * 1000;

  return request('get', `/team/${config.CLICKUP_TEAM_ID}/task`, null, {
    space_ids: [spaceId || config.CLICKUP_PPC_SPACE_ID],
    'due_date_gt': now,
    'due_date_lt': future,
    subtasks: true,
    include_closed: false,
  });
}

// --- Templates ---

export async function createOnboardingProject(clientName, listId) {
  const tasks = [
    { name: `[${clientName}] Kick-off call`, priority: 2, tags: ['onboarding'] },
    { name: `[${clientName}] Receive brand assets`, priority: 2, tags: ['onboarding'] },
    { name: `[${clientName}] Account audit`, priority: 1, tags: ['onboarding', 'audit'] },
    { name: `[${clientName}] Strategic plan (90-day)`, priority: 1, tags: ['onboarding', 'strategy'] },
    { name: `[${clientName}] Campaign setup`, priority: 1, tags: ['onboarding', 'campaign'] },
    { name: `[${clientName}] Tracking verification`, priority: 1, tags: ['onboarding', 'tracking'] },
    { name: `[${clientName}] Reporting setup`, priority: 2, tags: ['onboarding', 'reporting'] },
    { name: `[${clientName}] Client approval - go live`, priority: 1, tags: ['onboarding', 'approval'] },
  ];

  const created = [];
  for (const task of tasks) {
    const result = await createTask(listId, task);
    created.push(result);
  }

  log.info(`Created onboarding project for ${clientName}`, { taskCount: created.length });
  return created;
}

export default {
  getTasks, getTask, createTask, updateTask, addComment,
  getSpaces, getFolders, getLists,
  getOverdueTasks, getTasksDueToday, getTasksDueSoon,
  createOnboardingProject,
};
