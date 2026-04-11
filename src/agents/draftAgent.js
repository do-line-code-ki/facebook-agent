import { dbRun, dbGet, dbAll } from '../db/index.js';
import * as claude from '../services/claude.js';
import {
  sendMessage,
  sendApprovalRequest,
  registerApprovalCallback,
  registerAnswerCollector,
  removeAnswerCollector,
} from '../services/telegram.js';
import { getOptimalTime } from './scheduleAgent.js';
import logger from '../logger.js';
import config from '../config.js';
import * as facebook from '../services/facebook.js';
import { loadContext, getDefaultContext } from '../services/contextManager.js';

const ANSWER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function getPageContext() {
  try {
    const { name: pageName } = facebook.getActivePage();
    return loadContext(pageName) || getDefaultContext();
  } catch {
    return getDefaultContext();
  }
}

async function askQuestion(question) {
  return new Promise((resolve, reject) => {
    sendMessage(`❓ *${question}*\n\n_Reply with your answer (you have 10 minutes)_`)
      .catch(() => {});

    const chatId = config.TELEGRAM_CHAT_ID;
    let timeout;

    const wrappedResolve = (answer) => {
      clearTimeout(timeout);
      resolve(answer);
    };

    registerAnswerCollector(chatId, wrappedResolve);

    timeout = setTimeout(() => {
      removeAnswerCollector(chatId);
      reject(new Error(`No answer received for question: ${question}`));
    }, ANSWER_TIMEOUT_MS);
  });
}

async function runDraftAgent(ideaId) {
  logger.info('Draft agent starting', { ideaId });

  const idea = dbGet('SELECT * FROM post_ideas WHERE id = ?', [ideaId]);
  if (!idea) throw new Error(`Idea ${ideaId} not found`);

  const winnerPatterns = dbAll('SELECT * FROM winner_patterns ORDER BY avg_engagement_rate DESC');
  const pageContext = getPageContext();

  // Generate gathering questions
  const questions = await claude.generateGatheringQuestions(
    idea.post_type,
    idea.idea_title,
    idea.idea_description
  );

  logger.info('Gathering questions generated', { ideaId, count: questions.length });

  await sendMessage(
    `🎯 *Starting draft for:* "${idea.idea_title}"\n\nI'll ask you ${questions.length} questions to gather details. Please answer each one.`
  );

  // Collect answers one at a time
  const answers = {};
  for (const question of questions) {
    try {
      const answer = await askQuestion(question);
      answers[question] = answer;
      logger.info('Answer received', { question: question.substring(0, 50), answer: answer.substring(0, 50) });
    } catch (err) {
      logger.warn('Question timed out, using placeholder', { question });
      answers[question] = '[No answer provided]';
    }
  }

  await sendMessage(`✅ *Got all answers! Generating draft...*`);

  // Generate draft
  const draftData = await claude.generatePostDraft(
    idea.post_type,
    idea.idea_title,
    answers,
    winnerPatterns,
    pageContext
  );

  // Get optimal time
  const optimalTime = await getOptimalTime(idea.post_type);

  // Save draft
  const result = dbRun(
    `INSERT INTO post_drafts (idea_id, caption, hashtags, call_to_action, pre_publish_actions, post_publish_actions, image_suggestions, optimal_time, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval')`,
    [
      ideaId,
      draftData.caption,
      JSON.stringify(draftData.hashtags || []),
      draftData.call_to_action || '',
      JSON.stringify(draftData.pre_publish_actions || []),
      JSON.stringify(draftData.post_publish_actions || []),
      JSON.stringify(draftData.image_suggestions || []),
      optimalTime.toISOString(),
    ]
  );

  const draftId = result.lastInsertRowid;

  // Enrich draft object with extra field for approval message
  const draft = {
    ...draftData,
    optimal_time: optimalTime.toISOString(),
    post_type: idea.post_type,
  };

  // Send approval request
  const telegramMsgId = await sendApprovalRequest(draft, draftId);

  // Save approval session
  dbRun(
    `INSERT INTO approval_sessions (draft_id, telegram_message_id, status) VALUES (?, ?, 'waiting')`,
    [draftId, telegramMsgId]
  );

  logger.info('Draft created and sent for approval', { draftId, ideaId });

  return draftId;
}

async function runRevisionAgent(draftId, feedback) {
  logger.info('Revision agent starting', { draftId, feedback });

  const draft = dbGet('SELECT * FROM post_drafts WHERE id = ?', [draftId]);
  if (!draft) throw new Error(`Draft ${draftId} not found`);

  const originalDraft = {
    caption: draft.caption,
    hashtags: draft.hashtags,
    call_to_action: draft.call_to_action,
    pre_publish_actions: draft.pre_publish_actions,
    post_publish_actions: draft.post_publish_actions,
    image_suggestions: draft.image_suggestions,
  };

  const revisedDraft = await claude.reviseDraft(originalDraft, feedback);

  // Update draft in DB
  dbRun(
    `UPDATE post_drafts SET
       caption = ?,
       hashtags = ?,
       call_to_action = ?,
       pre_publish_actions = ?,
       post_publish_actions = ?,
       image_suggestions = ?,
       status = 'pending_approval',
       revision_count = revision_count + 1
     WHERE id = ?`,
    [
      revisedDraft.caption,
      JSON.stringify(revisedDraft.hashtags || []),
      revisedDraft.call_to_action || '',
      JSON.stringify(revisedDraft.pre_publish_actions || []),
      JSON.stringify(revisedDraft.post_publish_actions || []),
      JSON.stringify(revisedDraft.image_suggestions || []),
      draftId,
    ]
  );

  // Get idea for post_type
  const idea = draft.idea_id ? dbGet('SELECT * FROM post_ideas WHERE id = ?', [draft.idea_id]) : null;

  const enrichedDraft = {
    ...revisedDraft,
    optimal_time: draft.optimal_time,
    post_type: idea?.post_type || 'post',
  };

  // Send new approval request
  const telegramMsgId = await sendApprovalRequest(enrichedDraft, draftId);

  // Update approval session
  dbRun(
    `INSERT INTO approval_sessions (draft_id, telegram_message_id, status) VALUES (?, ?, 'waiting')`,
    [draftId, telegramMsgId]
  );

  logger.info('Revision complete, new approval request sent', { draftId });

  return draftId;
}

export { runDraftAgent, runRevisionAgent };
