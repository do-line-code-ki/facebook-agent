import express from 'express';
import { setupWebhookHandlers } from '../services/telegram.js';
import { dbRun, dbAll } from '../db/index.js';
import { startContentFlow } from '../flows/contentFlow.js';
import logger from '../logger.js';
import config from '../config.js';

function setupWebhooks(app) {
  app.use(express.json());

  // Setup Telegram webhook handlers (registers /telegram/webhook POST route)
  setupWebhookHandlers(app);

  // Meta webhook verification
  app.get('/meta/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const verifyToken = process.env.META_VERIFY_TOKEN || 'fb_agent_verify';

    if (mode === 'subscribe' && token === verifyToken) {
      logger.info('Meta webhook verified');
      return res.status(200).send(challenge);
    }
    logger.warn('Meta webhook verification failed', { mode, token });
    return res.sendStatus(403);
  });

  // Meta webhook events
  app.post('/meta/webhook', (req, res) => {
    res.sendStatus(200);
    const body = req.body;
    logger.info('Meta webhook event received', { object: body.object, entryCount: body.entry?.length });

    if (body.object === 'page') {
      for (const entry of (body.entry || [])) {
        for (const change of (entry.changes || [])) {
          logger.debug('Meta page event', { field: change.field, value: JSON.stringify(change.value).substring(0, 200) });
        }
      }
    }
  });

  // Internal API: queue a new topic
  app.post('/agent/topic', (req, res) => {
    const { topic } = req.body || {};
    if (!topic || typeof topic !== 'string' || topic.trim() === '') {
      return res.status(400).json({ error: 'topic field is required and must be a non-empty string' });
    }

    try {
      const result = dbRun(
        "INSERT INTO topics (topic, status) VALUES (?, 'pending')",
        [topic.trim()]
      );
      logger.info('Topic queued', { topic: topic.trim(), id: result.lastInsertRowid });
      return res.status(201).json({
        success: true,
        id: result.lastInsertRowid,
        topic: topic.trim(),
        message: 'Topic queued. Will be processed on next scheduled run (or trigger manually).',
      });
    } catch (err) {
      logger.error('Failed to queue topic', { error: err.message });
      return res.status(500).json({ error: 'Failed to queue topic' });
    }
  });

  // Internal API: immediately process next pending topic
  app.post('/agent/process-now', (req, res) => {
    let pending;
    try {
      pending = dbAll("SELECT * FROM topics WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1");
    } catch (err) {
      logger.error('Failed to query pending topics', { error: err.message });
      return res.status(500).json({ error: 'Failed to query pending topics' });
    }

    if (!pending || pending.length === 0) {
      return res.status(404).json({ error: 'No pending topics found. Queue a topic first via POST /agent/topic.' });
    }

    const topic = pending[0];

    try {
      dbRun("UPDATE topics SET status = 'processing' WHERE id = ?", [topic.id]);
    } catch (err) {
      logger.error('Failed to mark topic as processing', { id: topic.id, error: err.message });
      return res.status(500).json({ error: 'Failed to update topic status' });
    }

    // Kick off the flow in the background — do not await
    startContentFlow(topic.topic).catch((err) => {
      logger.error('process-now content flow failed', { topicId: topic.id, error: err.message });
      // Roll back status so it can be retried
      dbRun("UPDATE topics SET status = 'pending' WHERE id = ?", [topic.id]);
    });

    logger.info('process-now triggered', { topicId: topic.id, topic: topic.topic });
    return res.status(202).json({
      success: true,
      message: 'Content flow started',
      topic: { id: topic.id, topic: topic.topic },
    });
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  logger.info('Webhooks registered', {
    routes: [
      'POST /telegram/webhook',
      'GET /meta/webhook',
      'POST /meta/webhook',
      'POST /agent/topic',
      'POST /agent/process-now',
      'GET /health',
    ],
  });
}

export { setupWebhooks };
