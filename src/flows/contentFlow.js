import { dbRun, dbGet, dbAll } from '../db/index.js';
import { runIdeaAgent, runAutoIdeaAgent } from '../agents/ideaAgent.js';
import { runDraftAgent, runRevisionAgent } from '../agents/draftAgent.js';
import {
  registerApprovalCallback,
  registerAnswerCollector,
  removeAnswerCollector,
  sendMessage,
  showDateTimePicker,
  showImagePicker,
  escapeMd,
} from '../services/telegram.js';
import * as facebook from '../services/facebook.js';
import { getOptimalTime } from '../agents/scheduleAgent.js';
import logger from '../logger.js';
import config from '../config.js';

function formatTime(isoStr) {
  return new Date(isoStr).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Ask user when to publish — shows inline keyboard picker ──────────────────

async function askForPublishTime(draftId) {
  const draft = dbGet(
    `SELECT pd.*, pi.post_type FROM post_drafts pd
     LEFT JOIN post_ideas pi ON pd.idea_id = pi.id WHERE pd.id = ?`,
    [draftId]
  );

  // Ensure AI recommended time is still valid (not in the past or < 10 min away)
  let optimalTime = draft?.optimal_time;
  const tooSoon = !optimalTime || new Date(optimalTime).getTime() <= Date.now() + 10 * 60 * 1000;
  if (tooSoon) {
    const fresh = await getOptimalTime(draft?.post_type || 'educational');
    optimalTime = fresh.toISOString();
    dbRun('UPDATE post_drafts SET optimal_time = ? WHERE id = ?', [optimalTime, draftId]);
  }

  return showDateTimePicker(optimalTime);
}

// ─── Shared approval callbacks builder ────────────────────────────────────────

function buildApprovalCallbacks(draftId) {
  return {
    onApprove: async () => {
      try {
        // Ask for image first, then schedule
        const imageUrl = await showImagePicker(draftId);
        if (imageUrl) {
          dbRun('UPDATE post_drafts SET image_url = ? WHERE id = ?', [imageUrl, draftId]);
        }
        const chosenTime = await askForPublishTime(draftId);
        await publishFlow(draftId, chosenTime);
      } catch (err) {
        logger.error('Publish flow failed', { draftId, error: err.message });
        await sendMessage(`❌ *Publish failed for draft #${draftId}:* ${escapeMd(err.message)}`);
      }
    },
    onRevise: async (feedback) => {
      try {
        const newDraftId = await runRevisionAgent(draftId, feedback);
        registerApprovalCallback(String(newDraftId), buildApprovalCallbacks(newDraftId));
      } catch (err) {
        logger.error('Revision failed', { draftId, error: err.message });
        await sendMessage(`❌ *Revision failed for draft #${draftId}:* ${escapeMd(err.message)}`);
      }
    },
    onReject: async (reason) => {
      dbRun(`UPDATE post_drafts SET status = 'rejected', rejection_reason = ? WHERE id = ?`, [reason, draftId]);
      dbRun(
        `UPDATE approval_sessions SET status = 'rejected', resolved_at = CURRENT_TIMESTAMP WHERE draft_id = ? AND status = 'waiting'`,
        [draftId]
      );
      logger.info('Draft rejected', { draftId, reason });
    },
  };
}

// ─── Publish flow ──────────────────────────────────────────────────────────────

async function publishFlow(draftId, overrideTime = null) {
  logger.info('Publish flow starting', { draftId, overrideTime });

  const draft = dbGet(
    `SELECT pd.*, pi.post_type, pi.idea_title, t.topic
     FROM post_drafts pd
     LEFT JOIN post_ideas pi ON pd.idea_id = pi.id
     LEFT JOIN topics t ON pi.topic_id = t.id
     WHERE pd.id = ?`,
    [draftId]
  );
  if (!draft) throw new Error(`Draft ${draftId} not found`);

  let hashtags = [];
  try {
    hashtags = typeof draft.hashtags === 'string' ? JSON.parse(draft.hashtags) : (draft.hashtags || []);
  } catch { hashtags = []; }

  const hashtagStr = hashtags.map((h) => `#${h}`).join(' ');
  const fullCaption = hashtagStr ? `${draft.caption}\n\n${hashtagStr}` : draft.caption;

  const publishTime = overrideTime || draft.optimal_time;

  // Use photo post if an image was selected
  const result = draft.image_url
    ? await facebook.publishPhotoPost(fullCaption, draft.image_url, publishTime)
    : await facebook.publishPost(fullCaption, publishTime);

  dbRun(
    `INSERT INTO published_posts (draft_id, facebook_post_id, caption_snapshot, post_type, topic)
     VALUES (?, ?, ?, ?, ?)`,
    [draftId, result.post_id, draft.caption, draft.post_type || 'unknown', draft.topic || '']
  );
  dbRun(`UPDATE post_drafts SET status = 'published', optimal_time = ? WHERE id = ?`, [publishTime, draftId]);
  dbRun(
    `UPDATE approval_sessions SET status = 'approved', resolved_at = CURRENT_TIMESTAMP WHERE draft_id = ? AND status = 'waiting'`,
    [draftId]
  );

  const scheduledFor = publishTime ? formatTime(publishTime) : 'immediately';
  await sendMessage(`🎉 *Post scheduled!*\n\nFacebook ID: \`${result.post_id}\`\n📅 Publishing on: *${scheduledFor}*`);

  logger.info('Post published successfully', { draftId, facebook_post_id: result.post_id, publishTime });
  return { draft_id: draftId, facebook_post_id: result.post_id };
}

// ─── Topic-based flow (cron + /agent/process-now) ─────────────────────────────

async function startContentFlow(topic) {
  logger.info('Content flow starting', { topic });

  try {
    await sendMessage(`🚀 *Content flow started for:* "${topic}"\n\nGenerating post ideas...`);

    const ideas = await runIdeaAgent(topic);

    if (!ideas || ideas.length === 0) {
      await sendMessage(`❌ No ideas generated for topic: "${topic}". Please try a different topic.`);
      return;
    }

    const topIdea = ideas[0];
    await sendMessage(
      `💡 *Using top idea:*\n\n*${topIdea.idea_title}* (${topIdea.post_type})\nPredicted score: ${topIdea.predicted_score}\n\nStarting draft creation...`
    );

    const savedIdeas = dbAll(
      `SELECT * FROM post_ideas WHERE idea_title = ? ORDER BY id DESC LIMIT 1`,
      [topIdea.idea_title]
    );
    const savedIdea = savedIdeas[0];

    if (!savedIdea) {
      logger.error('Could not find saved idea in DB', { ideaTitle: topIdea.idea_title });
      return;
    }

    const draftId = await runDraftAgent(savedIdea.id);
    registerApprovalCallback(String(draftId), buildApprovalCallbacks(draftId));

    logger.info('Content flow complete — waiting for approval', { draftId, topic });
  } catch (err) {
    logger.error('Content flow failed', { topic, error: err.message });
    sendMessage(`❌ *Content flow failed for "${escapeMd(topic)}":* ${escapeMd(err.message)}`).catch(() => {});
    throw err;
  }
}

// ─── Auto flow (triggered by Telegram message) ────────────────────────────────

let isAutoFlowRunning = false;

function isAutoFlowActive() {
  return isAutoFlowRunning;
}

async function waitForIdeaSelection(count) {
  return new Promise((resolve, reject) => {
    const chatId = String(config.TELEGRAM_CHAT_ID);
    let timeout;

    const handler = (answer) => {
      clearTimeout(timeout);
      const num = parseInt(answer.trim(), 10);
      if (isNaN(num) || num < 1 || num > count) {
        sendMessage(`⚠️ Please reply with a number between 1 and ${count}.`).catch(() => {});
        timeout = setTimeout(() => {
          removeAnswerCollector(chatId);
          reject(new Error('Idea selection timed out'));
        }, 10 * 60 * 1000);
        registerAnswerCollector(chatId, handler);
        return;
      }
      resolve(num);
    };

    registerAnswerCollector(chatId, handler);
    timeout = setTimeout(() => {
      removeAnswerCollector(chatId);
      reject(new Error('Idea selection timed out'));
    }, 10 * 60 * 1000);
  });
}

async function startAutoFlow() {
  if (isAutoFlowRunning) {
    await sendMessage('⏳ A content flow is already in progress. Please complete it first.');
    return;
  }
  isAutoFlowRunning = true;

  try {
    await sendMessage('🚀 *Generating post ideas from your page context...*');

    const ideas = await runAutoIdeaAgent();

    if (!ideas || ideas.length === 0) {
      await sendMessage('❌ Could not generate ideas. Please check your `page_context.json`.');
      return;
    }

    const listMsg =
      `🎯 *Here are ${ideas.length} post ideas for your page:*\n\n` +
      ideas
        .map(
          (idea, i) =>
            `*${i + 1}. ${idea.idea_title}*\n` +
            `   Type: \`${idea.post_type}\` | Score: ${idea.predicted_score}\n` +
            `   ${idea.idea_description}`
        )
        .join('\n\n') +
      `\n\n_Reply with a number (1–${ideas.length}) to proceed with that idea._`;

    await sendMessage(listMsg);

    let selectedNum;
    try {
      selectedNum = await waitForIdeaSelection(ideas.length);
    } catch {
      await sendMessage('⏰ Selection timed out. Send any message to start again.');
      return;
    }

    const selectedIdea = ideas[selectedNum - 1];
    await sendMessage(`✅ *Selected: "${selectedIdea.idea_title}"*\n\nStarting draft process...`);

    const savedIdea = dbGet(
      `SELECT * FROM post_ideas WHERE idea_title = ? ORDER BY id DESC LIMIT 1`,
      [selectedIdea.idea_title]
    );

    if (!savedIdea) {
      await sendMessage('❌ Could not find selected idea in DB. Please try again.');
      return;
    }

    const draftId = await runDraftAgent(savedIdea.id);
    registerApprovalCallback(String(draftId), buildApprovalCallbacks(draftId));

    logger.info('Auto flow complete — waiting for approval', { draftId });
  } catch (err) {
    logger.error('Auto content flow failed', { error: err.message });
    sendMessage(`❌ *Content flow failed:* ${escapeMd(err.message)}`).catch(() => {});
    throw err;
  } finally {
    isAutoFlowRunning = false;
  }
}

// ─── Session command handlers (called from telegram.js via registered callbacks) ─

function resetAutoFlow() {
  isAutoFlowRunning = false;
}

async function handleList() {
  await sendMessage('🔄 Syncing with your Facebook page...');

  const [scheduledResult, publishedResult] = await Promise.allSettled([
    facebook.getScheduledPosts(),
    facebook.getPublishedPosts(),
  ]);

  const fbScheduled = scheduledResult.status === 'fulfilled' ? scheduledResult.value : [];
  const fbPublished = publishedResult.status === 'fulfilled' ? publishedResult.value : [];

  if (fbScheduled.length === 0 && fbPublished.length === 0) {
    await sendMessage('📭 No posts found on your Facebook page. Send *start* to create one!');
    return;
  }

  // Scheduled first, then published — cap at 10
  const allPosts = [
    ...fbScheduled.map(p => ({ ...p, fbStatus: 'scheduled' })),
    ...fbPublished.map(p => ({ ...p, fbStatus: 'published'  })),
  ].slice(0, 10);

  await sendMessage(`📋 *${allPosts.length} post(s) on your Facebook page:*`);

  for (const fbPost of allPosts) {
    const isScheduled = fbPost.fbStatus === 'scheduled';
    const badge   = isScheduled ? '🕐 Scheduled' : '🟢 Published';
    const timeStr = isScheduled
      ? formatTime(new Date(fbPost.scheduled_publish_time * 1000).toISOString())
      : formatTime(fbPost.created_time);

    const text    = fbPost.message || '';
    const preview = text.length > 150 ? text.substring(0, 150) + '…' : text;

    await sendMessage(
      `${badge} · ${timeStr}\n\n${preview}`,
      {
        reply_markup: { inline_keyboard: [[
          { text: '✏️ Edit',   callback_data: `post:edit:${fbPost.id}`   },
          { text: '🗑 Delete', callback_data: `post:delete:${fbPost.id}` },
          { text: '📋 Draft',  callback_data: `post:draft:${fbPost.id}`  },
        ]]},
      }
    );
  }
}

async function handleReschedule() {
  const post = dbGet(`
    SELECT pp.*, pd.optimal_time, pd.id AS pd_id, pi.post_type, pi.idea_title
    FROM published_posts pp
    LEFT JOIN post_drafts pd ON pp.draft_id = pd.id
    LEFT JOIN post_ideas  pi ON pd.idea_id  = pi.id
    ORDER BY pp.published_at DESC
    LIMIT 1
  `);

  if (!post) {
    await sendMessage('📭 No posts found to reschedule.');
    return;
  }

  const title    = post.idea_title || post.topic || `Post #${post.id}`;
  const seedTime = post.optimal_time && new Date(post.optimal_time) > new Date()
    ? post.optimal_time
    : new Date(Date.now() + 60 * 60 * 1000).toISOString();

  await sendMessage(`🔄 *Rescheduling:* "${title}"\n\nPick a new publish time:`);

  let newTime;
  try {
    newTime = await showDateTimePicker(seedTime);
  } catch {
    await sendMessage('⏰ Reschedule timed out. Send *reschedule* to try again.');
    return;
  }

  // Try to update on Facebook
  const fbResult = await facebook.reschedulePost(post.facebook_post_id, newTime);
  if (!fbResult.success) {
    await sendMessage(`⚠️ Couldn't update on Facebook (${fbResult.error}).\nUpdating local record only.`);
  }

  if (post.pd_id) {
    dbRun('UPDATE post_drafts SET optimal_time = ? WHERE id = ?', [newTime, post.pd_id]);
  }

  await sendMessage(`✅ *Rescheduled!*\n📅 New time: *${formatTime(newTime)}*`);
}

export { startContentFlow, publishFlow, startAutoFlow, isAutoFlowActive, resetAutoFlow, handleList, handleReschedule };
