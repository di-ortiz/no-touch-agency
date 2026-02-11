import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';
import { rateLimited } from '../utils/rate-limiter.js';
import { retry, isRetryableHttpError } from '../utils/retry.js';

const log = logger.child({ platform: 'hubspot' });

const api = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: { Authorization: `Bearer ${config.HUBSPOT_ACCESS_TOKEN}` },
  timeout: 15000,
});

async function request(method, path, data, params) {
  return rateLimited('hubspot', () =>
    retry(async () => {
      const res = await api({ method, url: path, data, params });
      return res.data;
    }, { retries: 3, label: `HubSpot ${method} ${path}`, shouldRetry: isRetryableHttpError })
  );
}

// --- Contacts ---

export async function getContact(contactId) {
  return request('get', `/crm/v3/objects/contacts/${contactId}`, null, {
    properties: 'firstname,lastname,email,phone,company,hs_lead_status',
  });
}

export async function searchContacts(query) {
  return request('post', '/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [{ propertyName: 'company', operator: 'CONTAINS_TOKEN', value: query }] }],
    properties: ['firstname', 'lastname', 'email', 'phone', 'company'],
    limit: 20,
  });
}

// --- Deals ---

export async function getDeals(opts = {}) {
  return request('get', '/crm/v3/objects/deals', null, {
    properties: 'dealname,amount,dealstage,pipeline,closedate,hs_lastmodifieddate',
    limit: opts.limit || 50,
  });
}

export async function createDeal(dealData) {
  return request('post', '/crm/v3/objects/deals', { properties: dealData });
}

export async function updateDeal(dealId, updates) {
  return request('patch', `/crm/v3/objects/deals/${dealId}`, { properties: updates });
}

// --- Companies ---

export async function getCompany(companyId) {
  return request('get', `/crm/v3/objects/companies/${companyId}`, null, {
    properties: 'name,domain,industry,numberofemployees,annualrevenue,description',
  });
}

export async function searchCompanies(query) {
  return request('post', '/crm/v3/objects/companies/search', {
    filterGroups: [{ filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: query }] }],
    properties: ['name', 'domain', 'industry'],
    limit: 20,
  });
}

// --- Custom Objects (for PPC client tracking) ---

export async function createNote(objectType, objectId, noteBody) {
  const note = await request('post', '/crm/v3/objects/notes', {
    properties: { hs_note_body: noteBody, hs_timestamp: new Date().toISOString() },
  });
  // Associate note with the object
  await request('put', `/crm/v3/objects/notes/${note.id}/associations/${objectType}/${objectId}/note_to_${objectType}`, {});
  return note;
}

// --- Pipeline ---

export async function getPipelines() {
  return request('get', '/crm/v3/pipelines/deals');
}

export default {
  getContact, searchContacts,
  getDeals, createDeal, updateDeal,
  getCompany, searchCompanies,
  createNote, getPipelines,
};
