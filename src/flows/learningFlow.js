import { fetchAndStoreMetrics, updateWinnerPatterns, fetchAndAnalyzeComments } from '../agents/analyticsAgent.js';
import logger from '../logger.js';

async function runLearningCycle() {
  logger.info('Learning cycle starting...');

  let metricsSummary = {};
  let commentsSummary = {};

  try {
    metricsSummary = await fetchAndStoreMetrics();
  } catch (err) {
    logger.error('fetchAndStoreMetrics failed in learning cycle', { error: err.message });
  }

  try {
    await updateWinnerPatterns();
  } catch (err) {
    logger.error('updateWinnerPatterns failed in learning cycle', { error: err.message });
  }

  try {
    commentsSummary = await fetchAndAnalyzeComments();
  } catch (err) {
    logger.error('fetchAndAnalyzeComments failed in learning cycle', { error: err.message });
  }

  logger.info('Learning cycle complete', { metricsSummary, commentsSummary });

  return { metricsSummary, commentsSummary };
}

export { runLearningCycle };
