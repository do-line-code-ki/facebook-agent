import { dbRun, dbGet, dbAll } from '../db/index.js';
import * as facebook from '../services/facebook.js';
import * as claude from '../services/claude.js';
import { sendMessage, sendMetricsAlert, sendWeeklyReport } from '../services/telegram.js';
import logger from '../logger.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'are', 'was',
  'we', 'you', 'i', 'my', 'your', 'our', 'your', 'be', 'have', 'has',
  'do', 'will', 'can', 'as', 'if', 'so', 'not', 'more', 'about', 'get',
  'just', 'like', 'know', 'up', 'out', 'them', 'they', 'what',
]);

function extractTopKeywords(captions, topN = 5) {
  const freq = {};
  for (const caption of captions) {
    const words = caption
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w));
    for (const word of words) {
      freq[word] = (freq[word] || 0) + 1;
    }
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word);
}

async function fetchAndStoreMetrics() {
  logger.info('Fetching post metrics...');

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const posts = dbAll(`
    SELECT * FROM published_posts
    WHERE published_at > ? AND published_at > ?
  `, [oneDayAgo, thirtyDaysAgo]);

  if (posts.length === 0) {
    logger.info('No eligible posts for metrics fetch');
    return { fetched: 0 };
  }

  let fetched = 0;
  for (const post of posts) {
    try {
      const metrics = await facebook.getPostMetrics(post.facebook_post_id);

      // Upsert metrics
      const existing = dbGet(
        'SELECT id FROM post_metrics WHERE facebook_post_id = ?',
        [post.facebook_post_id]
      );

      if (existing) {
        dbRun(
          `UPDATE post_metrics SET
             reach = ?, impressions = ?, likes = ?, comments = ?, shares = ?,
             clicks = ?, engagement_rate = ?, fetched_at = CURRENT_TIMESTAMP
           WHERE facebook_post_id = ?`,
          [
            metrics.reach, metrics.impressions, metrics.likes, metrics.comments,
            metrics.shares, metrics.clicks, metrics.engagement_rate, post.facebook_post_id,
          ]
        );
      } else {
        dbRun(
          `INSERT INTO post_metrics
             (published_post_id, facebook_post_id, reach, impressions, likes, comments, shares, clicks, engagement_rate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            post.id, post.facebook_post_id, metrics.reach, metrics.impressions,
            metrics.likes, metrics.comments, metrics.shares, metrics.clicks, metrics.engagement_rate,
          ]
        );
      }
      fetched++;
    } catch (err) {
      logger.error('Failed to fetch metrics for post', { post_id: post.facebook_post_id, error: err.message });
    }
  }

  // Calculate page average engagement
  const avgResult = dbGet(`
    SELECT AVG(engagement_rate) AS avg_rate FROM post_metrics
    WHERE fetched_at >= ?
  `, [thirtyDaysAgo]);
  const pageAvg = avgResult?.avg_rate || 0;

  // Mark winners (engagement_rate > 1.5x page average)
  const threshold = pageAvg * 1.5;
  if (threshold > 0) {
    const candidates = dbAll(
      `SELECT pm.*, pp.caption_snapshot as caption FROM post_metrics pm
       JOIN published_posts pp ON pm.published_post_id = pp.id
       WHERE pm.engagement_rate > ? AND pm.is_winner = 0`,
      [threshold]
    );

    for (const c of candidates) {
      dbRun('UPDATE post_metrics SET is_winner = 1 WHERE id = ?', [c.id]);
      logger.info('Winner post marked', { post_id: c.facebook_post_id, rate: c.engagement_rate });
      try {
        await sendMetricsAlert(c.caption?.substring(0, 50) || 'Post', c);
      } catch { /* non-blocking */ }
    }
  }

  logger.info('Metrics fetch complete', { fetched, pageAvg: pageAvg.toFixed(4) });
  return { fetched, pageAvg };
}

async function updateWinnerPatterns() {
  logger.info('Updating winner patterns...');

  try {
    const winners = dbAll(`
      SELECT pm.*, pp.caption_snapshot, pp.post_type, pp.published_at
      FROM post_metrics pm
      JOIN published_posts pp ON pm.published_post_id = pp.id
      WHERE pm.is_winner = 1
    `);

    if (winners.length === 0) {
      logger.info('No winners yet to build patterns from');
      return;
    }

    // Group by post_type — join through to post_ideas to get idea_source
    const winnersFull = dbAll(`
      SELECT pm.*, pp.caption_snapshot, pp.post_type, pp.published_at, pp.draft_id,
             pi.idea_source
      FROM post_metrics pm
      JOIN published_posts pp ON pm.published_post_id = pp.id
      LEFT JOIN post_drafts pd ON pp.draft_id = pd.id
      LEFT JOIN post_ideas  pi ON pd.idea_id  = pi.id
      WHERE pm.is_winner = 1
    `);

    const byType = {};
    for (const w of winnersFull) {
      const t = w.post_type || 'unknown';
      if (!byType[t]) byType[t] = [];
      byType[t].push(w);
    }

    for (const [postType, posts] of Object.entries(byType)) {
      const avgEngagement = posts.reduce((s, p) => s + p.engagement_rate, 0) / posts.length;

      // Most common day_of_week, hour
      const dayFreq  = {};
      const hourFreq = {};
      const sourceFreq = {};
      const captions = [];

      for (const p of posts) {
        const d = new Date(p.published_at);
        dayFreq[d.getDay()]    = (dayFreq[d.getDay()]    || 0) + 1;
        hourFreq[d.getHours()] = (hourFreq[d.getHours()] || 0) + 1;
        if (p.caption_snapshot) captions.push(p.caption_snapshot);
        // Track which idea_source wins most
        const src = p.idea_source || 'past_performance';
        sourceFreq[src] = (sourceFreq[src] || 0) + 1;
      }

      const bestDay  = parseInt(Object.entries(dayFreq).sort((a, b) => b[1] - a[1])[0][0]);
      const bestHour = parseInt(Object.entries(hourFreq).sort((a, b) => b[1] - a[1])[0][0]);
      const topKeywords = extractTopKeywords(captions);
      const topSource = Object.entries(sourceFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      dbRun(
        `INSERT INTO winner_patterns (post_type, avg_engagement_rate, best_day_of_week, best_hour, common_topics, sample_size, top_source, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(post_type) DO UPDATE SET
           avg_engagement_rate = excluded.avg_engagement_rate,
           best_day_of_week    = excluded.best_day_of_week,
           best_hour           = excluded.best_hour,
           common_topics       = excluded.common_topics,
           sample_size         = excluded.sample_size,
           top_source          = excluded.top_source,
           last_updated        = CURRENT_TIMESTAMP`,
        [postType, avgEngagement, bestDay, bestHour, JSON.stringify(topKeywords), posts.length, topSource]
      );

      logger.info('Winner pattern updated', { postType, avgEngagement: avgEngagement.toFixed(4), bestDay, bestHour });
    }
  } catch (err) {
    logger.error('updateWinnerPatterns failed', { error: err.message });
  }
}

async function fetchAndAnalyzeComments() {
  logger.info('Fetching and analyzing comments...');

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentPosts = dbAll(
    'SELECT * FROM published_posts WHERE published_at >= ?',
    [sevenDaysAgo]
  );

  let newComments = 0;
  let negativeAlerts = 0;

  for (const post of recentPosts) {
    try {
      const comments = await facebook.getPostComments(post.facebook_post_id);

      for (const comment of comments) {
        // Check if we already have this comment
        const existing = dbGet(
          'SELECT id FROM post_comments WHERE facebook_comment_id = ?',
          [comment.id]
        );
        if (existing) continue;

        // Analyze sentiment
        let sentiment = 'neutral';
        let replySuggestion = '';
        try {
          const analysis = await claude.analyzeCommentSentiment(comment.message || '');
          sentiment = analysis.sentiment;
          replySuggestion = analysis.reply_suggestion;
        } catch { /* continue without sentiment */ }

        // Save comment
        dbRun(
          `INSERT INTO post_comments (published_post_id, facebook_comment_id, commenter_name, comment_text, sentiment, reply_drafted)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            post.id,
            comment.id,
            comment.from?.name || 'Unknown',
            comment.message || '',
            sentiment,
            replySuggestion,
          ]
        );

        newComments++;

        // Alert on negative sentiment immediately
        if (sentiment === 'negative') {
          negativeAlerts++;
          sendMessage(
            `⚠️ *Negative comment on your post!*\n\n"${(comment.message || '').substring(0, 200)}"\n\n_Suggested reply:_ ${replySuggestion}`
          ).catch(() => {});
        }
      }
    } catch (err) {
      logger.error('Failed to fetch comments for post', { post_id: post.facebook_post_id, error: err.message });
    }
  }

  if (newComments > 0) {
    sendMessage(
      `💬 *Comment Update:* ${newComments} new comment(s) found. ${negativeAlerts} negative alert(s) sent.`
    ).catch(() => {});
  }

  logger.info('Comment analysis complete', { newComments, negativeAlerts });
  return { newComments, negativeAlerts };
}

async function generateWeeklyReport() {
  logger.info('Generating weekly report...');

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);
  weekStart.setHours(0, 0, 0, 0);

  const weekEnd = new Date(now);
  weekEnd.setHours(23, 59, 59, 999);

  try {
    const posts = dbAll(
      `SELECT pp.*, pm.engagement_rate, pm.reach, pm.likes, pm.comments, pm.shares
       FROM published_posts pp
       LEFT JOIN post_metrics pm ON pp.id = pm.published_post_id
       WHERE pp.published_at >= ? AND pp.published_at <= ?`,
      [weekStart.toISOString(), weekEnd.toISOString()]
    );

    const patterns = dbAll('SELECT * FROM winner_patterns ORDER BY avg_engagement_rate DESC LIMIT 5');
    const comments = dbAll(`
      SELECT pc.sentiment, COUNT(*) as count
      FROM post_comments pc
      JOIN published_posts pp ON pc.published_post_id = pp.id
      WHERE pp.published_at >= ? AND pp.published_at <= ?
      GROUP BY pc.sentiment
    `, [weekStart.toISOString(), weekEnd.toISOString()]);

    const avgEngagement = posts.length > 0
      ? posts.reduce((s, p) => s + (p.engagement_rate || 0), 0) / posts.length
      : 0;

    const bestPost = posts.sort((a, b) => (b.engagement_rate || 0) - (a.engagement_rate || 0))[0];
    const worstPost = posts.sort((a, b) => (a.engagement_rate || 0) - (b.engagement_rate || 0))[0];

    const typeFreq = {};
    for (const p of posts) {
      if (p.post_type) typeFreq[p.post_type] = (typeFreq[p.post_type] || 0) + 1;
    }
    const topPostType = Object.entries(typeFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';

    const weekData = {
      week: { start: weekStart.toISOString().split('T')[0], end: weekEnd.toISOString().split('T')[0] },
      total_posts: posts.length,
      avg_engagement_rate: avgEngagement,
      best_post: bestPost ? { caption: bestPost.caption_snapshot, rate: bestPost.engagement_rate } : null,
      worst_post: worstPost ? { caption: worstPost.caption_snapshot, rate: worstPost.engagement_rate } : null,
      top_post_type: topPostType,
      winner_patterns: patterns,
      comment_sentiment: comments,
    };

    const reportText = await claude.generateWeeklyReport(weekData);

    // Save to DB
    dbRun(
      `INSERT INTO weekly_reports (week_start, week_end, total_posts, avg_engagement_rate, top_post_type, insights)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        weekStart.toISOString().split('T')[0],
        weekEnd.toISOString().split('T')[0],
        posts.length,
        avgEngagement,
        topPostType,
        reportText,
      ]
    );

    await sendWeeklyReport(reportText);
    logger.info('Weekly report generated and sent');

    return reportText;
  } catch (err) {
    logger.error('Weekly report generation failed', { error: err.message });
    throw err;
  }
}

export { fetchAndStoreMetrics, updateWinnerPatterns, fetchAndAnalyzeComments, generateWeeklyReport };
