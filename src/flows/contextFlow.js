import {
  sendMessage,
  registerAnswerCollector,
  removeAnswerCollector,
  showContextOptions,
  escapeMd,
} from '../services/telegram.js';
import { saveContext, deleteContext } from '../services/contextManager.js';
import config from '../config.js';
import logger from '../logger.js';

// ─── Questions asked during context creation ──────────────────────────────────

export const CONTEXT_QUESTIONS = [
  {
    key:      'about',
    label:    'About the page',
    question: 'What is this page about? Describe your business or brand in a few sentences.',
  },
  {
    key:      'target_audience',
    label:    'Target audience',
    question: 'Who is your target audience? (age group, location, interests, profession, etc.)',
  },
  {
    key:      'tone_of_voice',
    label:    'Tone of voice',
    question: 'What tone of voice do you prefer for posts? (e.g., professional, casual, humorous, inspirational)',
  },
  {
    key:      'content_pillars',
    label:    'Content pillars',
    question: 'List your main content pillars — 3 to 5 themes you want to focus on. (e.g., Tips, Behind-the-scenes, Product showcases, Success stories)',
  },
  {
    key:      'avoid_topics',
    label:    'Topics to avoid',
    question: 'Are there any topics, themes, or words to completely avoid in your posts?',
  },
  {
    key:      'brand_unique',
    label:    'What makes you unique',
    question: "What makes your brand or page unique? What's your USP or competitive advantage?",
  },
  {
    key:      'posting_frequency',
    label:    'Posting frequency',
    question: 'How often do you want to post? (e.g., daily, 3× per week, weekdays only)',
  },
];

const ANSWER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per question

// ─── Single question helper ───────────────────────────────────────────────────

async function askQuestion(questionText, num, total) {
  return new Promise((resolve, reject) => {
    const chatId = String(config.TELEGRAM_CHAT_ID);

    sendMessage(
      `📋 *Question ${num} of ${total}*\n\n❓ ${questionText}\n\n_Reply with your answer:_`
    ).catch(() => {});

    let timeout;
    registerAnswerCollector(chatId, (answer) => {
      clearTimeout(timeout);
      resolve(answer);
    });
    timeout = setTimeout(() => {
      removeAnswerCollector(chatId);
      reject(new Error('Question timed out — no answer received within 10 minutes.'));
    }, ANSWER_TIMEOUT_MS);
  });
}

// ─── Main flow ────────────────────────────────────────────────────────────────

/**
 * Full interactive context-creation flow over Telegram.
 *
 * Asks the user CONTEXT_QUESTIONS one by one, then shows the
 * Save / Edit / Delete inline keyboard.
 *
 * Returns the saved context object on success, null if aborted.
 */
export async function runContextFlow(pageName, pageId) {
  logger.info('Context creation flow started', { pageName });

  const total = CONTEXT_QUESTIONS.length;

  await sendMessage(
    `📝 *Setting up context for "${escapeMd(pageName)}"*\n\n` +
    `I'll ask you ${total} quick questions about your page so I can generate posts that truly fit your brand.\n\n` +
    `_Take your time — you have 10 minutes per question._`
  );

  // ── Collect answers ────────────────────────────────────────────────────────
  const answers = {};
  for (let i = 0; i < CONTEXT_QUESTIONS.length; i++) {
    const q = CONTEXT_QUESTIONS[i];
    try {
      answers[q.key] = await askQuestion(q.question, i + 1, total);
    } catch {
      await sendMessage(
        '⏰ *No answer received in time.* Context creation cancelled.\n\nSend *start* whenever you\'re ready to try again.'
      );
      return null;
    }
  }

  // ── Show summary and wait for user decision ────────────────────────────────
  let result;
  try {
    result = await showContextOptions(pageName, CONTEXT_QUESTIONS, answers);
  } catch (err) {
    logger.error('showContextOptions failed', { error: err.message });
    return null;
  }

  if (!result || result.action === null) {
    await sendMessage(
      '🚪 *Context creation exited.*\n\nSend *start* whenever you\'re ready to create a context.'
    );
    return null;
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  if (result.action === 'deleted') {
    await sendMessage(
      '🗑️ *All info deleted.*\n\nWould you like to create a new context from scratch?',
      {
        reply_markup: { inline_keyboard: [[
          { text: '✅ Yes, start over', callback_data: 'session:new:yes' },
          { text: '🚪 No, exit',        callback_data: 'session:new:no'  },
        ]]},
      }
    );
    return null;
  }

  // ── Save (possibly after edits) ────────────────────────────────────────────
  if (result.action === 'saved') {
    const contextData = buildContextObject(result.answers);
    const filePath    = saveContext(pageName, pageId, contextData);
    logger.info('Context saved', { pageName, filePath });
    await sendMessage(
      `✅ *Context saved for "${escapeMd(pageName)}"!*\n\nNow generating post ideas based on your page...`
    );
    return contextData;
  }

  return null;
}

// ─── Build context object from raw answers ────────────────────────────────────

function buildContextObject(answers) {
  return {
    industry:          answers.about            || '',
    target_audience:   answers.target_audience  || '',
    tone_of_voice:     answers.tone_of_voice    || '',
    content_pillars:   (answers.content_pillars || '')
                         .split(/[,;\n]+/)
                         .map((s) => s.trim())
                         .filter(Boolean),
    avoid_topics:      answers.avoid_topics     || '',
    brand_unique:      answers.brand_unique     || '',
    posting_frequency: answers.posting_frequency || '',
  };
}
