import { dbAll } from '../db/index.js';
import logger from '../logger.js';

function nextOccurrenceOfDayHour(targetDay, targetHour) {
  const now = new Date();
  const result = new Date(now);

  // Find next occurrence of targetDay (0=Sun..6=Sat)
  const currentDay = now.getDay();
  let daysAhead = (targetDay - currentDay + 7) % 7;

  // If same day but hour has passed, go to next week
  if (daysAhead === 0 && now.getHours() >= targetHour) {
    daysAhead = 7;
  }

  result.setDate(now.getDate() + daysAhead);
  result.setHours(targetHour, 0, 0, 0);

  return result;
}

async function getOptimalTime(postType) {
  try {
    const pattern = dbAll(
      'SELECT * FROM winner_patterns WHERE post_type = ?',
      [postType]
    )[0];

    let optimalDate;

    if (pattern && pattern.best_day_of_week !== null && pattern.best_hour !== null) {
      optimalDate = nextOccurrenceOfDayHour(pattern.best_day_of_week, pattern.best_hour);
      logger.info('Optimal time from winner pattern', { postType, optimalDate });
    } else {
      // Default: next Tuesday (day 2) or Thursday (day 4) at 10am
      const tuesday = nextOccurrenceOfDayHour(2, 10);
      const thursday = nextOccurrenceOfDayHour(4, 10);
      optimalDate = tuesday < thursday ? tuesday : thursday;
      logger.info('Optimal time using default schedule', { postType, optimalDate });
    }

    // Ensure at least 15 minutes in the future
    const minTime = new Date(Date.now() + 15 * 60 * 1000);
    if (optimalDate < minTime) {
      optimalDate = minTime;
    }

    return optimalDate;
  } catch (err) {
    logger.error('getOptimalTime failed', { postType, error: err.message });
    // Fallback: 1 hour from now
    return new Date(Date.now() + 60 * 60 * 1000);
  }
}

async function getPageBestTimes() {
  try {
    const rows = dbAll(`
      SELECT
        strftime('%w', pp.published_at) AS day_of_week,
        strftime('%H', pp.published_at) AS hour,
        AVG(pm.engagement_rate) AS avg_engagement
      FROM published_posts pp
      JOIN post_metrics pm ON pp.id = pm.published_post_id
      WHERE pp.published_at >= datetime('now', '-90 days')
        AND pm.engagement_rate > 0
      GROUP BY day_of_week, hour
      ORDER BY avg_engagement DESC
      LIMIT 5
    `);

    return rows.map((r) => ({
      day_of_week: parseInt(r.day_of_week),
      hour: parseInt(r.hour),
      avg_engagement: parseFloat(r.avg_engagement).toFixed(4),
    }));
  } catch (err) {
    logger.error('getPageBestTimes failed', { error: err.message });
    return [];
  }
}

export { getOptimalTime, getPageBestTimes };
