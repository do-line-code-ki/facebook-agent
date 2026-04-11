import { dbRun, dbAll, dbGet } from '../db/index.js';
import * as claude from '../services/claude.js';
import { sendMessage } from '../services/telegram.js';
import logger from '../logger.js';
import path from 'path';
import { fileURLToPath } from 'url';
import * as facebook from '../services/facebook.js';
import { loadContext, getDefaultContext } from '../services/contextManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getPageContext() {
  try {
    const { name: pageName } = facebook.getActivePage();
    return loadContext(pageName) || getDefaultContext();
  } catch {
    return getDefaultContext();
  }
}

function calculatePredictedScore(idea, winnerPatterns) {
  let score = 50;

  // +20 if post_type matches a winning post_type
  const matchingPattern = winnerPatterns.find(
    (p) => p.post_type === idea.post_type
  );
  if (matchingPattern) {
    score += 20;

    // +10 if best_day_of_week is within next 3 days
    if (matchingPattern.best_day_of_week !== null && matchingPattern.best_day_of_week !== undefined) {
      const today = new Date().getDay();
      const targetDay = matchingPattern.best_day_of_week;
      const diff = (targetDay - today + 7) % 7;
      if (diff <= 3) {
        score += 10;
      }
    }
  }

  // +10 if predicted_engagement is 'high'
  if (idea.predicted_engagement === 'high') {
    score += 10;
  }

  return score;
}

async function runIdeaAgent(topic) {
  logger.info('Idea agent starting', { topic });

  try {
    // Fetch winner patterns
    const winnerPatterns = dbAll('SELECT * FROM winner_patterns ORDER BY avg_engagement_rate DESC');

    // Get topic record
    const topicRecord = dbGet("SELECT * FROM topics WHERE topic = ? AND status = 'pending' LIMIT 1", [topic]);
    const topicId = topicRecord?.id;

    // Get page context
    const pageContext = getPageContext();

    // Generate ideas from Claude
    const rawIdeas = await claude.generatePostIdeas(topic, winnerPatterns, pageContext);

    // Score and save ideas
    const scoredIdeas = rawIdeas.map((idea) => ({
      ...idea,
      predicted_score: calculatePredictedScore(idea, winnerPatterns),
    }));

    // Sort highest score first
    scoredIdeas.sort((a, b) => b.predicted_score - a.predicted_score);

    // Save to DB
    for (const idea of scoredIdeas) {
      dbRun(
        `INSERT INTO post_ideas (topic_id, post_type, idea_title, idea_description, predicted_score)
         VALUES (?, ?, ?, ?, ?)`,
        [topicId || null, idea.post_type, idea.idea_title, idea.idea_description || '', idea.predicted_score]
      );
    }

    logger.info('Ideas generated and saved', { count: scoredIdeas.length, topic });

    // Send top 3 to Telegram for awareness (non-blocking)
    try {
      const top3 = scoredIdeas.slice(0, 3);
      const msg = `💡 *Top 3 Ideas for "${topic}"*\n\n` +
        top3.map((idea, i) =>
          `${i + 1}. *${idea.idea_title}* (${idea.post_type})\n   Score: ${idea.predicted_score} | ${idea.predicted_engagement} engagement\n   ${idea.idea_description}`
        ).join('\n\n');
      sendMessage(msg).catch(() => {}); // fire and forget
    } catch { /* non-blocking */ }

    return scoredIdeas;
  } catch (err) {
    logger.error('Idea agent failed', { topic, error: err.message });
    throw err;
  }
}

async function runAutoIdeaAgent() {
  logger.info('Auto idea agent starting from page context');

  try {
    const winnerPatterns = dbAll('SELECT * FROM winner_patterns ORDER BY avg_engagement_rate DESC');
    const pageContext = getPageContext();

    const rawIdeas = await claude.generateIdeasFromContext(pageContext, winnerPatterns);

    const scoredIdeas = rawIdeas.map((idea) => ({
      ...idea,
      predicted_score: calculatePredictedScore(idea, winnerPatterns),
    }));

    scoredIdeas.sort((a, b) => b.predicted_score - a.predicted_score);

    for (const idea of scoredIdeas) {
      dbRun(
        `INSERT INTO post_ideas (topic_id, post_type, idea_title, idea_description, predicted_score)
         VALUES (?, ?, ?, ?, ?)`,
        [null, idea.post_type, idea.idea_title, idea.idea_description || '', idea.predicted_score]
      );
    }

    logger.info('Auto ideas generated and saved', { count: scoredIdeas.length });
    return scoredIdeas;
  } catch (err) {
    logger.error('Auto idea agent failed', { error: err.message });
    throw err;
  }
}

export { runIdeaAgent, runAutoIdeaAgent };
