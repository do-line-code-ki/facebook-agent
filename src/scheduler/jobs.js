import cron from 'node-cron';

import { runLearningCycle } from '../flows/learningFlow.js';
import { generateWeeklyReport } from '../agents/analyticsAgent.js';
import { fetchAndAnalyzeComments } from '../agents/analyticsAgent.js';
import { sendMessage } from '../services/telegram.js';
import config from '../config.js';
import logger from '../logger.js';

const jobs = [];

function safeRun(name, fn) {
  return async () => {
    logger.info(`Cron job starting: ${name}`);
    try {
      await fn();
      logger.info(`Cron job complete: ${name}`);
    } catch (err) {
      logger.error(`Cron job failed: ${name}`, { error: err.message });
      sendMessage(`⚠️ *Cron job failed: ${name}*\n\nError: ${err.message}`).catch(() => {});
    }
  };
}

function startAllJobs() {
  // Job 1: Weekly content reminder — user must reply to trigger the flow
  const topicJob = cron.schedule(
    config.TOPIC_SCHEDULE_CRON,
    safeRun('Weekly content reminder', async () => {
      await sendMessage(
        `👋 *Good morning!* Time to create this week's content.\n\nSend me any message or /start to generate post ideas from your page context.`
      );
    }),
    { scheduled: false }
  );

  // Job 2: Daily metrics fetch
  const metricsJob = cron.schedule(
    config.METRICS_FETCH_CRON,
    safeRun('Daily metrics fetch', async () => {
      await runLearningCycle();
    }),
    { scheduled: false }
  );

  // Job 3: Weekly report (staggered 5min after topic trigger)
  const reportJob = cron.schedule(
    config.WEEKLY_REPORT_CRON,
    safeRun('Weekly report', async () => {
      await generateWeeklyReport();
    }),
    { scheduled: false }
  );

  // Job 4: Comment monitoring every 2 hours
  const commentJob = cron.schedule(
    '0 */2 * * *',
    safeRun('Comment monitoring', async () => {
      await fetchAndAnalyzeComments();
    }),
    { scheduled: false }
  );

  // Start all jobs
  topicJob.start();
  metricsJob.start();
  reportJob.start();
  commentJob.start();

  jobs.push(topicJob, metricsJob, reportJob, commentJob);

  logger.info('All cron jobs started', {
    topicSchedule: config.TOPIC_SCHEDULE_CRON,
    metricsSchedule: config.METRICS_FETCH_CRON,
    reportSchedule: config.WEEKLY_REPORT_CRON,
    commentSchedule: '0 */2 * * *',
  });
}

function stopAllJobs() {
  jobs.forEach((j) => j.stop());
  logger.info('All cron jobs stopped');
}

export { startAllJobs, stopAllJobs };
