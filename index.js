import './src/config.js'; // validates env vars first
import express from 'express';
import fs from 'fs';
import path from 'path';
import logger from './src/logger.js';
import { initDb, closeDb } from './src/db/index.js';
import { setupWebhooks } from './src/server/webhooks.js';
import { startAllJobs, stopAllJobs } from './src/scheduler/jobs.js';
import {
  setWebhook,
  sendMessage,
  showMainMenu,
  registerAutoFlowCallback,
  registerRescheduleCallback,
  registerListCallback,
  registerResetFlowCallback,
  registerBotCommands,
} from './src/services/telegram.js';
import { startAutoFlow, handleReschedule, handleList, resetAutoFlow } from './src/flows/contentFlow.js';
import { dbAll } from './src/db/index.js';
import config from './src/config.js';

// Ensure data directory exists
const dataDir = path.dirname(path.resolve(config.DB_PATH));
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

async function main() {
  // Initialize database
  initDb();

  // Create Express app
  const app = express();

  // Setup webhooks (Telegram + Meta + internal routes)
  setupWebhooks(app);

  // Set Telegram webhook if WEBHOOK_BASE_URL is configured
  if (config.WEBHOOK_BASE_URL) {
    await setWebhook(config.WEBHOOK_BASE_URL);
  } else {
    logger.warn('WEBHOOK_BASE_URL not set — Telegram webhook not configured. Set it to your public HTTPS URL.');
  }

  // Register Telegram bot commands (shows /start button in chat)
  await registerBotCommands();

  // Wire up Telegram → flow callbacks (avoids circular imports)
  registerAutoFlowCallback(startAutoFlow);
  registerRescheduleCallback(handleReschedule);
  registerListCallback(handleList);
  registerResetFlowCallback(resetAutoFlow);

  // Start cron jobs
  startAllJobs();

  // Start Express server
  const server = app.listen(config.PORT, () => {
    logger.info(`Facebook AI Agent running on port ${config.PORT}`);
  });

  // First-run greeting
  const topics = dbAll("SELECT * FROM topics WHERE status = 'pending' LIMIT 1");
  const winnerPatterns = dbAll('SELECT * FROM winner_patterns LIMIT 1');

  showMainMenu('👋 *Facebook AI Agent is live!* Tap a button below to get started.').catch(() => {});

  // Graceful shutdown
  function shutdown(signal) {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      stopAllJobs();
      closeDb();
      logger.info('Shutdown complete.');
      process.exit(0);
    });
    // Force exit after 10s
    setTimeout(() => process.exit(1), 10000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Catch unhandled errors
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    sendMessage(`🚨 *Unhandled error:* ${err.message}`).catch(() => {});
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: String(reason) });
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
