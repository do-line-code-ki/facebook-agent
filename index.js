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
import config from './src/config.js';

// Ensure data directory exists
const dataDir = path.dirname(path.resolve(config.DB_PATH));
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

async function main() {
  // 1. Initialize database
  initDb();

  // 2. Wire up flow callbacks FIRST (before any bot handlers fire)
  registerAutoFlowCallback(startAutoFlow);
  registerRescheduleCallback(handleReschedule);
  registerListCallback(handleList);
  registerResetFlowCallback(resetAutoFlow);

  // 3. Create Express app and register all routes
  const app = express();
  setupWebhooks(app);

  // 4. Start server and WAIT until it is actually listening
  const server = await new Promise((resolve) => {
    const s = app.listen(config.PORT, () => {
      logger.info(`Server listening on port ${config.PORT}`);
      resolve(s);
    });
  });

  // 5. Now that the server is ready, configure Telegram
  if (config.WEBHOOK_BASE_URL) {
    logger.info('Webhook mode — setting webhook', { url: config.WEBHOOK_BASE_URL });
    await setWebhook(config.WEBHOOK_BASE_URL);
  } else {
    logger.info('Polling mode — WEBHOOK_BASE_URL not set');
  }

  await registerBotCommands();

  // 6. Start cron jobs
  startAllJobs();

  // 7. Send welcome message — log error if it fails so we know the bot is connected
  try {
    await showMainMenu('👋 *Facebook AI Agent is live!* Tap a button below to get started.');
    logger.info('Welcome message sent', { chatId: config.TELEGRAM_CHAT_ID });
  } catch (err) {
    logger.error('Failed to send welcome message — check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID', { error: err.message });
  }

  // Graceful shutdown
  function shutdown(signal) {
    logger.info(`Received ${signal}, shutting down...`);
    server.close(() => {
      stopAllJobs();
      closeDb();
      logger.info('Shutdown complete.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

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
