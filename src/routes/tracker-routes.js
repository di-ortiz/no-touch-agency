import { Router } from 'express';
import {
  createTeamMember, getTeamMember, getAllTeamMembers, updateTeamMember, deleteTeamMember, searchTeamMembers,
  createDeliverable, getDeliverable, getDeliverableByToken, updateDeliverable, completeDeliverable,
  deleteDeliverable, getDeliverablesByAssignee, getAllDeliverables, getPendingDeliverablesSummary,
  getDeliverablesByPerson,
  addComment, getComments,
  getRecentIngestions,
} from '../services/team-task-tracker.js';
import { extractDeliverables, extractFromEmail } from '../services/deliverable-extractor.js';
import { getAuthUrl, handleAuthCallback, isAuthenticated, fetchEmails, getUpcomingEvents } from '../api/gmail.js';
import { scanDriveFolder, processFileById } from '../services/drive-ingestion.js';
import { runTeamDailyDigest } from '../workflows/team-daily-digest.js';
import config from '../config.js';
import logger from '../utils/logger.js';

const log = logger.child({ workflow: 'tracker-routes' });
const router = Router();

// ─── Health / Status ────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const summary = getPendingDeliverablesSummary();
  res.json({
    status: 'ok',
    gmail_connected: isAuthenticated(),
    summary,
  });
});

// ─── Dashboard (JSON summary for frontend) ──────────────────────────────────

router.get('/dashboard', (req, res) => {
  try {
    const summary = getPendingDeliverablesSummary();
    const byPerson = getDeliverablesByPerson();
    const overdue = getAllDeliverables({ overdue: true });
    const dueSoon = getAllDeliverables({ dueSoon: true });
    const recentIngestions = getRecentIngestions(10);

    res.json({
      summary,
      byPerson,
      overdue,
      dueSoon,
      recentIngestions,
      gmailConnected: isAuthenticated(),
    });
  } catch (err) {
    log.error('Dashboard error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Team Members ───────────────────────────────────────────────────────────

router.get('/team', (req, res) => {
  const query = req.query.q;
  const members = query ? searchTeamMembers(query) : getAllTeamMembers();
  res.json(members);
});

router.post('/team', (req, res) => {
  try {
    const member = createTeamMember(req.body);
    res.status(201).json(member);
  } catch (err) {
    log.error('Create team member error', { error: err.message });
    res.status(400).json({ error: err.message });
  }
});

router.get('/team/:id', (req, res) => {
  const member = getTeamMember(req.params.id);
  if (!member) return res.status(404).json({ error: 'Team member not found' });
  res.json(member);
});

router.put('/team/:id', (req, res) => {
  try {
    const member = updateTeamMember(req.params.id, req.body);
    res.json(member);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/team/:id', (req, res) => {
  deleteTeamMember(req.params.id);
  res.json({ ok: true });
});

// ─── Deliverables ───────────────────────────────────────────────────────────

router.get('/deliverables', (req, res) => {
  const { status, assignedTo, overdue, dueSoon } = req.query;
  const deliverables = getAllDeliverables({
    status,
    assignedTo,
    overdue: overdue === 'true',
    dueSoon: dueSoon === 'true',
  });
  res.json(deliverables);
});

router.post('/deliverables', (req, res) => {
  try {
    const deliverable = createDeliverable(req.body);
    res.status(201).json(deliverable);
  } catch (err) {
    log.error('Create deliverable error', { error: err.message });
    res.status(400).json({ error: err.message });
  }
});

router.get('/deliverables/:id', (req, res) => {
  const deliverable = getDeliverable(req.params.id);
  if (!deliverable) return res.status(404).json({ error: 'Deliverable not found' });
  const comments = getComments(req.params.id);
  res.json({ ...deliverable, comments });
});

router.put('/deliverables/:id', (req, res) => {
  try {
    const deliverable = updateDeliverable(req.params.id, req.body);
    res.json(deliverable);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/deliverables/:id/complete', (req, res) => {
  try {
    const deliverable = completeDeliverable(req.params.id);
    res.json(deliverable);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/deliverables/:id', (req, res) => {
  deleteDeliverable(req.params.id);
  res.json({ ok: true });
});

// ─── Comments ───────────────────────────────────────────────────────────────

router.get('/deliverables/:id/comments', (req, res) => {
  const comments = getComments(req.params.id);
  res.json(comments);
});

router.post('/deliverables/:id/comments', (req, res) => {
  try {
    const comment = addComment({
      deliverableId: req.params.id,
      authorType: req.body.authorType || 'owner',
      authorName: req.body.authorName,
      content: req.body.content,
    });
    res.status(201).json(comment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Public deliverable page (for assignees via shared link) ────────────────

router.get('/d/:token', (req, res) => {
  const deliverable = getDeliverableByToken(req.params.token);
  if (!deliverable) return res.status(404).json({ error: 'Deliverable not found' });
  const comments = getComments(deliverable.id);

  // Return JSON for Lovable frontend to consume
  res.json({
    id: deliverable.id,
    title: deliverable.title,
    description: deliverable.description,
    due_date: deliverable.due_date,
    status: deliverable.status,
    priority: deliverable.priority,
    assignee_name: deliverable.assignee_name,
    source_summary: deliverable.source_summary,
    context_notes: deliverable.context_notes,
    created_at: deliverable.created_at,
    comments,
  });
});

// Assignee can add a comment/question via the public link
router.post('/d/:token/comment', (req, res) => {
  const deliverable = getDeliverableByToken(req.params.token);
  if (!deliverable) return res.status(404).json({ error: 'Deliverable not found' });

  try {
    const comment = addComment({
      deliverableId: deliverable.id,
      authorType: 'assignee',
      authorName: req.body.authorName || deliverable.assignee_name,
      content: req.body.content,
    });
    res.status(201).json(comment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Assignee can mark as complete via the public link
router.post('/d/:token/complete', (req, res) => {
  const deliverable = getDeliverableByToken(req.params.token);
  if (!deliverable) return res.status(404).json({ error: 'Deliverable not found' });

  try {
    const updated = completeDeliverable(deliverable.id);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── AI Extraction ──────────────────────────────────────────────────────────

router.post('/extract', async (req, res) => {
  try {
    const { text, sourceType, sourceLabel, autoCreate } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    const results = await extractDeliverables(text, {
      sourceType: sourceType || 'manual',
      sourceLabel,
      autoCreate: autoCreate !== false,
    });

    res.json({ extracted: results.length, results });
  } catch (err) {
    log.error('Extraction error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Gmail Integration ──────────────────────────────────────────────────────

router.get('/auth/google', (req, res) => {
  try {
    const url = getAuthUrl();
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Authorization code required' });
    await handleAuthCallback(code);
    res.send('<html><body><h1>Gmail connected successfully!</h1><p>You can close this window.</p></body></html>');
  } catch (err) {
    log.error('Gmail OAuth callback error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get('/gmail/status', (req, res) => {
  res.json({ connected: isAuthenticated() });
});

router.post('/gmail/scan', async (req, res) => {
  try {
    const { query, maxResults, after } = req.body;
    const emails = await fetchEmails({ query, maxResults, after });

    let extracted = 0;
    const results = [];
    for (const email of emails) {
      const items = await extractFromEmail({
        subject: email.subject,
        from: email.from,
        body: email.body,
        emailId: email.id,
        date: email.date,
      });
      extracted += items.filter(r => r._status === 'created').length;
      results.push({ subject: email.subject, from: email.from, deliverables: items.length });
    }

    res.json({ emailsScanned: emails.length, deliverables: extracted, details: results });
  } catch (err) {
    log.error('Gmail scan error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Calendar ───────────────────────────────────────────────────────────────

router.get('/calendar/events', async (req, res) => {
  try {
    const { maxResults, daysAhead } = req.query;
    const events = await getUpcomingEvents({
      maxResults: maxResults ? parseInt(maxResults) : undefined,
      daysAhead: daysAhead ? parseInt(daysAhead) : undefined,
    });
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Google Drive Ingestion ─────────────────────────────────────────────────

router.post('/drive/scan', async (req, res) => {
  try {
    const { folderId, since } = req.body;
    if (!folderId) return res.status(400).json({ error: 'folderId is required' });

    const result = await scanDriveFolder(folderId, { since });
    res.json(result);
  } catch (err) {
    log.error('Drive scan error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post('/drive/process-file', async (req, res) => {
  try {
    const { fileId } = req.body;
    if (!fileId) return res.status(400).json({ error: 'fileId is required' });

    const result = await processFileById(fileId);
    res.json(result);
  } catch (err) {
    log.error('Drive file process error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual Trigger ─────────────────────────────────────────────────────────

router.post('/digest/run', async (req, res) => {
  try {
    await runTeamDailyDigest();
    res.json({ ok: true, message: 'Daily digest sent' });
  } catch (err) {
    log.error('Manual digest error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Ingestion Log ──────────────────────────────────────────────────────────

router.get('/ingestions', (req, res) => {
  const ingestions = getRecentIngestions(parseInt(req.query.limit) || 20);
  res.json(ingestions);
});

export default router;
