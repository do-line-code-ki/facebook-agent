import TelegramBot from 'node-telegram-bot-api';
import config from '../config.js';
import logger from '../logger.js';
import { dbGet, dbRun } from '../db/index.js';
import * as facebook from './facebook.js';
import { buildImageUrl, downloadImage } from './imageGen.js';
import { generateImagePrompt } from './claude.js';
import { getFacebookOAuthUrl } from '../routes/facebookAuth.js';

let bot = null;

// Ignore messages queued before this process started
const BOT_START_TIME = Math.floor(Date.now() / 1000);

// ─── In-memory stores ─────────────────────────────────────────────────────────
const approvalCallbacks = new Map(); // draftId → { onApprove, onRevise, onReject }
const answerCollectors  = new Map(); // chatId  → resolve fn
const pickerSessions    = new Map(); // chatId  → date-picker state
const postEditSessions  = new Map(); // chatId  → { fbPostId, draftId, currentCaption, currentTime, newCaption }
const imagePickerSessions = new Map(); // chatId → { draftId, resolve, reject, timeout, currentUrl }

// ─── Session state ────────────────────────────────────────────────────────────
const session = { isPaused: false };

// ─── Registered callbacks (avoid circular imports) ───────────────────────────
let autoFlowCallback   = null;
let rescheduleCallback = null;
let listCallback       = null;
let resetFlowCallback  = null;

function registerAutoFlowCallback(fn)   { autoFlowCallback   = fn; }
function registerRescheduleCallback(fn) { rescheduleCallback = fn; }
function registerListCallback(fn)       { listCallback       = fn; }
function registerResetFlowCallback(fn)  { resetFlowCallback  = fn; }

// ─── Bot init ─────────────────────────────────────────────────────────────────
function getBot() {
  if (!bot) {
    const usePolling = !config.WEBHOOK_BASE_URL;
    bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: usePolling });
    if (usePolling) logger.info('Telegram bot running in polling mode (WEBHOOK_BASE_URL not set)');
  }
  return bot;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Escapes Telegram Markdown v1 special characters in untrusted strings
// (error messages, user content, API responses)
function escapeMd(text) {
  return String(text).replace(/[_*`\[]/g, '\\$&');
}

// ─── Basic send helpers ───────────────────────────────────────────────────────
async function sendMessage(text, extra = {}) {
  try {
    const result = await getBot().sendMessage(config.TELEGRAM_CHAT_ID, text, { parse_mode: 'Markdown', ...extra });
    return result.message_id;
  } catch (err) {
    logger.error('Telegram sendMessage failed', { error: err.message });
  }
}

const MAIN_MENU = {
  keyboard: [
    [{ text: '🚀 Start' },    { text: '📋 List'          }],
    [{ text: '🔄 Reschedule' }, { text: '📖 fb-commands' }],
    [{ text: '📱 Pages' }],
  ],
  resize_keyboard: true,
  persistent: true,
};

async function showMainMenu(text = '👋 What would you like to do?') {
  return sendMessage(text, { reply_markup: MAIN_MENU });
}

async function sendWeeklyReport(reportText)       { return sendMessage(`📊 *Weekly Report*\n\n${reportText}`); }
async function sendMetricsAlert(postTitle, metrics) {
  return sendMessage(
    `🏆 *Winner Post Alert!*\n\nPost: ${postTitle}\nEngagement Rate: ${(metrics.engagement_rate * 100).toFixed(2)}%\n` +
    `Reach: ${metrics.reach}\nLikes: ${metrics.likes} | Comments: ${metrics.comments} | Shares: ${metrics.shares}`
  );
}

// ─── Approval request ─────────────────────────────────────────────────────────
async function sendApprovalRequest(draft, draftId) {
  const parse = (val) => { try { return typeof val === 'string' ? JSON.parse(val) : val; } catch { return []; } };
  const hashtags         = (parse(draft.hashtags) || []).map((t) => `#${t}`).join(' ');
  const preActions       = (parse(draft.pre_publish_actions) || []).map((a) => `• ${a}`).join('\n');
  const postActions      = (parse(draft.post_publish_actions) || []).map((a) => `• ${a}`).join('\n');
  const imageSuggestions = (parse(draft.image_suggestions) || []).map((s) => `• ${s}`).join('\n');
  const optimalTime      = draft.optimal_time
    ? new Date(draft.optimal_time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    : 'ASAP';

  const msg = `📝 *NEW POST DRAFT #${draftId}*

*Type:* ${draft.post_type || 'N/A'}

*Caption:*
${draft.caption}

*Hashtags:* ${hashtags}

*CTA:* ${draft.call_to_action || 'N/A'}

📋 *Before publishing:*
${preActions || 'N/A'}

📋 *After publishing:*
${postActions || 'N/A'}

🖼 *Image ideas:*
${imageSuggestions || 'N/A'}

⏰ *Suggested time:* ${optimalTime}`;

  try {
    const result = await getBot().sendMessage(config.TELEGRAM_CHAT_ID, msg, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Approve',  callback_data: `draft:approve:${draftId}` },
        { text: '✏️ Revise',  callback_data: `draft:revise:${draftId}`  },
        { text: '❌ Reject',  callback_data: `draft:reject:${draftId}`  },
      ]]},
    });
    return result.message_id;
  } catch (err) {
    logger.error('Telegram sendApprovalRequest failed', { error: err.message });
    return null;
  }
}

// ─── Approval / answer-collector registration ─────────────────────────────────
function registerApprovalCallback(draftId, callbacks) { approvalCallbacks.set(String(draftId), callbacks); }
function removeApprovalCallback(draftId)              { approvalCallbacks.delete(String(draftId)); }
function registerAnswerCollector(chatId, resolve)     { answerCollectors.set(String(chatId), resolve); }
function removeAnswerCollector(chatId)                { answerCollectors.delete(String(chatId)); }
function getApprovalCallbacks()                       { return approvalCallbacks; }
function getAnswerCollectors()                        { return answerCollectors; }

// ─── Keyword command handlers ─────────────────────────────────────────────────

async function handleStart() {
  if (session.isPaused) {
    session.isPaused = false;
    const hasPendingQ = answerCollectors.size > 0;
    await sendMessage(
      `▶️ *Session resumed!*` +
      (hasPendingQ ? `\n\n_You have a pending question — please answer it above._` : '')
    );
    return;
  }
  if (approvalCallbacks.size > 0) {
    const ids = [...approvalCallbacks.keys()].join(', ');
    await sendMessage(
      `📋 Draft(s) *#${ids}* are waiting for your decision:\n` +
      `✅ /approve [id]\n✏️ /revise [id] [feedback]\n❌ /reject [id] [reason]`
    );
    return;
  }
  if (autoFlowCallback) {
    autoFlowCallback().catch((err) => logger.error('Auto flow error', { error: err.message }));
  }
}

async function handlePause() {
  if (session.isPaused) {
    await sendMessage("⏸ Already paused. Send *start*, *begin*, or *let's roll* to resume.");
    return;
  }
  const hasActivity = answerCollectors.size > 0 || pickerSessions.size > 0 || approvalCallbacks.size > 0;
  if (!hasActivity) {
    await sendMessage('Nothing is currently running to pause.');
    return;
  }
  session.isPaused = true;
  await sendMessage("⏸ *Session paused.*\n\nSend *start*, *begin*, or *let's roll* to resume.");
}

async function handleDelete(chatId) {
  // Wipe all in-flight state
  approvalCallbacks.clear();
  answerCollectors.clear();
  pickerSessions.clear();
  session.isPaused = false;
  if (resetFlowCallback) resetFlowCallback();

  await getBot().sendMessage(chatId, '🗑 *Session deleted.*\n\nWould you like to start a new session?', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '✅ Yes, start new session', callback_data: 'session:new:yes' },
      { text: '👋 No, goodbye',            callback_data: 'session:new:no'  },
    ]]},
  }).catch(() => {});
}

async function handleExit(chatId) {
  approvalCallbacks.clear();
  answerCollectors.clear();
  pickerSessions.clear();
  session.isPaused = false;
  if (resetFlowCallback) resetFlowCallback();

  try {
    await getBot().sendMessage(chatId, '👋 *Session ended.* All activity has been stopped.\n\nWould you like to create a new post?', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Yes, let\'s create a post', callback_data: 'session:new:yes' },
        { text: '👋 No, I\'m done',             callback_data: 'session:new:no'  },
      ]]},
    });
  } catch (err) {
    logger.error('handleExit sendMessage failed', { error: err.message });
  }
}

async function savePostEdit(chatId, session) {
  const { fbPostId, draftId, newCaption, newTime } = session;
  postEditSessions.delete(chatId);

  const fbResult = await facebook.updatePost(fbPostId, { message: newCaption, scheduledTime: newTime });

  if (draftId) {
    dbRun('UPDATE post_drafts SET caption = ?, optimal_time = ? WHERE id = ?', [newCaption, newTime || null, draftId]);
  }

  const timeStr = newTime ? fmtFull(new Date(newTime)) : 'unchanged';
  if (fbResult.success) {
    await sendMessage(`✅ *Post updated!*\n\n📅 Schedule: ${timeStr}`);
  } else {
    await sendMessage(`⚠️ Facebook update failed: ${fbResult.error}\nLocal record updated.`);
  }
}

async function sendFbCommands() {
  return sendMessage(
    `📖 *FB Agent Commands*\n\n` +
    `▶️ *start / begin / let's roll*\n   Start a new content session or resume a paused one\n\n` +
    `⏸ *pause / wait*\n   Pause the current session (saves your place)\n\n` +
    `🗑 *delete*\n   Delete the current session entirely\n\n` +
    `🚪 *exit*\n   Stop everything and optionally start fresh\n\n` +
    `🔄 *reschedule*\n   Change the publish time of your last post\n\n` +
    `📋 *list*\n   See all scheduled & published posts\n\n` +
    `📖 *fb-commands*\n   Show this help (never interrupts your session)`
  );
}

// ─── Facebook page management ─────────────────────────────────────────────────

async function handleAddPage() {
  let oauthUrl;
  try {
    oauthUrl = getFacebookOAuthUrl();
  } catch (err) {
    await sendMessage(
      `⚠️ *Cannot open Facebook login*\n\n${escapeMd(err.message)}\n\n` +
      `To enable multi-page support, set these two environment variables in Railway:\n` +
      `• \`FACEBOOK_APP_ID\`\n• \`FACEBOOK_APP_SECRET\`\n\n` +
      `See the setup guide: go to *developers.facebook.com* → My Apps → Create App → Add Facebook Login product.`
    );
    return;
  }

  const b = getBot();
  await b.sendMessage(config.TELEGRAM_CHAT_ID,
    '🔗 *Connect a Facebook Page*\n\n' +
    'Tap the button below to log in with Facebook and choose which page(s) to connect.\n\n' +
    '_The link expires in 15 minutes._',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔗 Log in with Facebook', url: oauthUrl },
        ]],
      },
    }
  ).catch((err) => logger.error('handleAddPage sendMessage failed', { error: err.message }));
}

async function handlePagesList() {
  const pages = facebook.getAllPages();

  if (pages.length === 0) {
    await sendMessage(
      '📱 *No Facebook Pages connected yet.*\n\n' +
      'Run *addpage* to connect a page via Facebook Login.'
    );
    return;
  }

  const { name: activeName } = facebook.getActivePage();
  const b = getBot();

  const buttons = pages.map((p) => [{
    text: p.is_active
      ? `✅ ${p.page_name} (active)`
      : `📄 ${p.page_name}`,
    callback_data: p.is_active ? 'page:noop' : `page:switch:${p.page_id}`,
  }]);

  buttons.push([{ text: '➕ Add another page', callback_data: 'page:addnew' }]);

  await b.sendMessage(config.TELEGRAM_CHAT_ID,
    `📱 *Your Facebook Pages*\n\nCurrently active: *${escapeMd(activeName)}*\n\nTap a page to make it active:`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    }
  ).catch((err) => logger.error('handlePagesList sendMessage failed', { error: err.message }));
}

// Called by facebookAuth.js (via registered notifier) when OAuth completes
async function handlePagesConnected(pages, status, errMsg) {
  const b = getBot();

  if (status === 'denied') {
    await sendMessage('❌ Facebook login was cancelled. Tap *addpage* if you\'d like to try again.');
    return;
  }
  if (status === 'no_pages') {
    await sendMessage('⚠️ No Facebook Pages found on that account. You must be an Admin of a page to connect it.');
    return;
  }
  if (status === 'error') {
    await sendMessage(`❌ *Failed to connect pages:* ${escapeMd(errMsg || 'Unknown error')}\n\nPlease try *addpage* again.`);
    return;
  }

  // Auto-select if only one page was returned and no page is currently active
  const allPages = facebook.getAllPages();
  const hasActive = allPages.some((p) => p.is_active);
  if (pages.length === 1 && !hasActive) {
    facebook.setActivePage(pages[0].id);
    await sendMessage(`✅ *${escapeMd(pages[0].name)}* is now connected and active!`);
    return;
  }

  // Show selector for all newly connected pages
  const buttons = pages.map((p) => [{
    text: `📄 ${p.name}`,
    callback_data: `page:switch:${p.id}`,
  }]);

  await b.sendMessage(config.TELEGRAM_CHAT_ID,
    `✅ *${pages.length} page${pages.length > 1 ? 's' : ''} connected!*\n\nChoose which one to make active:`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    }
  ).catch((err) => logger.error('handlePagesConnected sendMessage failed', { error: err.message }));
}

// ─── Date-time picker ─────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function fmtHour(h) {
  if (h === 0)  return '12 AM';
  if (h < 12)   return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

function fmtFull(dateObj) {
  return dateObj.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric',
    month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function todayISTDate() {
  const str = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return new Date(`${str}T00:00:00+05:30`);
}

function calendarKeyboard(year, month) {
  const today   = todayISTDate();
  const maxDate = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let startDow = new Date(year, month, 1).getDay(); // 0=Sun
  startDow = (startDow + 6) % 7;                   // Mon=0 … Sun=6

  const prevY = month === 0 ? year - 1 : year;
  const prevM = month === 0 ? 11 : month - 1;
  const nextY = month === 11 ? year + 1 : year;
  const nextM = month === 11 ? 0 : month + 1;

  const rows = [];

  // Month navigation
  rows.push([
    { text: '◀', callback_data: `dt:cal:${prevY}-${String(prevM + 1).padStart(2, '0')}` },
    { text: `${MONTH_NAMES[month]} ${year}`, callback_data: 'dt:noop' },
    { text: '▶', callback_data: `dt:cal:${nextY}-${String(nextM + 1).padStart(2, '0')}` },
  ]);

  // Day-of-week header
  rows.push(['Mo','Tu','We','Th','Fr','Sa','Su'].map(d => ({ text: d, callback_data: 'dt:noop' })));

  // Calendar grid
  let row = [];
  for (let i = 0; i < startDow; i++) row.push({ text: ' ', callback_data: 'dt:noop' });

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr  = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dateObj  = new Date(`${dateStr}T00:00:00+05:30`);
    const pickable = dateObj >= today && dateObj <= maxDate;
    row.push(pickable
      ? { text: String(day), callback_data: `dt:day:${dateStr}` }
      : { text: '·',         callback_data: 'dt:noop' }
    );
    if (row.length === 7) { rows.push(row); row = []; }
  }
  if (row.length > 0) {
    while (row.length < 7) row.push({ text: ' ', callback_data: 'dt:noop' });
    rows.push(row);
  }

  return { inline_keyboard: rows };
}

function hourGrid() {
  const rows = [];
  for (let h = 0; h < 24; h += 4) {
    rows.push([h, h + 1, h + 2, h + 3].map(hr => ({
      text: fmtHour(hr), callback_data: `dt:hour:${hr}`,
    })));
  }
  rows.push([{ text: '← Back to calendar', callback_data: 'dt:back:cal' }]);
  return { inline_keyboard: rows };
}

function minuteGrid() {
  return { inline_keyboard: [
    [0, 15, 30, 45].map(m => ({
      text: `:${String(m).padStart(2, '0')}`, callback_data: `dt:min:${m}`,
    })),
    [{ text: '← Back to time', callback_data: 'dt:back:hour' }],
  ]};
}

function fmtDateLabel(dateStr) {
  return new Date(`${dateStr}T12:00:00+05:30`).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long',
  });
}

function buildSelectedDate(dateStr, hour, minute) {
  const h = String(hour).padStart(2, '0');
  const m = String(minute).padStart(2, '0');
  return new Date(`${dateStr}T${h}:${m}:00+05:30`);
}

async function showDateTimePicker(optimalTime) {
  return new Promise(async (resolve, reject) => {
    const b      = getBot();
    const chatId = String(config.TELEGRAM_CHAT_ID);
    const aiDate = new Date(optimalTime);

    let msgResult;
    try {
      msgResult = await b.sendMessage(chatId, `⏰ *When would you like to publish?*`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: `🤖 AI recommended: ${fmtFull(aiDate)}`, callback_data: 'dt:choice:ai'     }],
          [{ text: '📅 Pick a custom date & time',           callback_data: 'dt:choice:custom' }],
        ]},
      });
    } catch (err) { reject(err); return; }

    const istDateStr = aiDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const [calYear, calMonthNum] = istDateStr.split('-').map(Number);
    const istHour = parseInt(
      aiDate.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }), 10
    ) || 9;
    const istMinute = Math.round(aiDate.getMinutes() / 15) * 15 % 60;

    const state = {
      calYear,
      calMonth:        calMonthNum - 1, // 0-indexed
      selectedDateStr: istDateStr,
      hour:            istHour,
      minute:          istMinute,
      optimalTime,
      messageId:       msgResult.message_id,
      resolve,
      reject,
      timeout:         null,
    };
    state.timeout = setTimeout(() => {
      pickerSessions.delete(chatId);
      reject(new Error('Date picker timed out'));
    }, 10 * 60 * 1000);

    pickerSessions.set(chatId, state);
  });
}

// ─── Image picker ─────────────────────────────────────────────────────────────

async function showImagePicker(draftId) {
  logger.info('showImagePicker: showing prompt', { draftId });
  return new Promise(async (resolve, reject) => {
    const chatId = String(config.TELEGRAM_CHAT_ID);
    try {
      await getBot().sendMessage(chatId, '🖼 *Add an AI-generated image to this post?*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '✨ Generate Image',  callback_data: 'img:gen'  },
          { text: '📝 Skip — Text Only', callback_data: 'img:skip' },
        ]]},
      });
    } catch (err) {
      logger.error('showImagePicker: sendMessage failed', { error: err.message });
      reject(err);
      return;
    }

    logger.info('showImagePicker: message sent, waiting for user response');
    const state = { draftId: String(draftId), resolve, reject, timeout: null, currentUrl: null };
    state.timeout = setTimeout(() => {
      logger.info('showImagePicker: timed out, resolving with null');
      imagePickerSessions.delete(chatId);
      resolve(null);
    }, 5 * 60 * 1000);

    imagePickerSessions.set(chatId, state);
  });
}

// ─── Webhook / event handlers ─────────────────────────────────────────────────

function setupWebhookHandlers(app) {
  const b = getBot();

  if (config.WEBHOOK_BASE_URL) {
    app.post('/telegram/webhook', (req, res) => {
      res.sendStatus(200);
      try { b.processUpdate(req.body); }
      catch (err) { logger.error('Error processing Telegram update', { error: err.message }); }
    });
  }

  // ── Inline-keyboard callbacks (date picker + session delete confirm) ──────
  b.on('callback_query', async (query) => {
    // Filter stale callback_queries from before this process started (polling mode)
    if (query.message?.date && query.message.date < BOT_START_TIME) {
      b.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    const chatId    = String(query.message?.chat?.id);
    const data      = query.data || '';
    const messageId = query.message?.message_id;
    const answer    = (text = '', alert = false) =>
      b.answerCallbackQuery(query.id, text ? { text, show_alert: alert } : {}).catch(() => {});

    // Session delete confirmation
    if (data === 'session:new:yes') {
      answer();
      await b.editMessageText('🚀 Starting a new session...', {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
      }).catch(() => {});
      if (autoFlowCallback) autoFlowCallback().catch((err) => logger.error('Auto flow error', { error: err.message }));
      return;
    }
    if (data === 'session:new:no') {
      answer();
      await b.editMessageText("👋 *Goodbye!* Come back whenever you're ready to create content.", {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
      }).catch(() => {});
      await showMainMenu();
      return;
    }

    // Draft approve / revise / reject buttons
    if (data.startsWith('draft:')) {
      const [, action, draftId] = data.split(':');
      const cbs = approvalCallbacks.get(draftId);

      if (!cbs) {
        answer('This draft is no longer pending.', true);
        return;
      }

      if (action === 'approve') {
        answer();
        approvalCallbacks.delete(draftId);
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
        await cbs.onApprove();

      } else if (action === 'revise') {
        answer();
        approvalCallbacks.delete(draftId);
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
        await sendMessage('✏️ *What would you like me to change?*\n\nJust reply with your feedback and I\'ll rewrite the post.');
        registerAnswerCollector(chatId, async (feedback) => {
          await sendMessage('🔄 Revising the post with your feedback...');
          await cbs.onRevise(feedback);
        });

      } else if (action === 'reject') {
        answer();
        approvalCallbacks.delete(draftId);
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
        await cbs.onReject('Rejected by user');
        await b.sendMessage(chatId, '❌ *Post rejected.*\n\nWould you like to create a new post?', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: '✅ Yes, create new post', callback_data: 'session:new:yes' },
            { text: '👋 No, I\'m done',        callback_data: 'session:new:no'  },
          ]]},
        }).catch(() => {});
      }
      return;
    }

    // AI image picker
    if (data.startsWith('img:')) {
      const action = data.split(':')[1]; // gen | skip | use | retry
      const state  = imagePickerSessions.get(chatId);

      if (action === 'skip') {
        answer();
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
        if (state) {
          clearTimeout(state.timeout);
          imagePickerSessions.delete(chatId);
          state.resolve(null);
        }
        return;
      }

      if (!state) { answer('Session expired. Please try again.', true); return; }

      if (action === 'gen' || action === 'retry') {
        answer();
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
        await sendMessage('🎨 Generating image… this takes 15–30 seconds, please wait.');

        try {
          const draft = dbGet('SELECT * FROM post_drafts WHERE id = ?', [state.draftId]);
          const prompt = await generateImagePrompt(draft?.caption, draft?.post_type);
          const { url } = buildImageUrl(prompt);
          state.currentUrl = url;
          logger.info('Downloading generated image', { url });

          // Download image as buffer so Telegram doesn't need to fetch the URL itself
          const imageBuffer = await downloadImage(url);
          logger.info('Image downloaded, sending to Telegram', { bytes: imageBuffer.length });

          await b.sendPhoto(chatId, imageBuffer, {
            caption: `🖼 *Generated image*\n\n_Prompt: ${escapeMd(prompt)}_`,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[
              { text: '✅ Use this image',  callback_data: 'img:use'   },
              { text: '🔄 Generate another', callback_data: 'img:retry' },
              { text: '📝 Skip',            callback_data: 'img:skip'  },
            ]]},
          });
        } catch (err) {
          logger.error('Image generation failed', { error: err.message });
          await sendMessage(`⚠️ Image generation failed: ${escapeMd(err.message)}\n\nTry again or skip.`, {
            reply_markup: { inline_keyboard: [[
              { text: '🔄 Try again', callback_data: 'img:retry' },
              { text: '📝 Skip',      callback_data: 'img:skip'  },
            ]]},
          });
        }
        return;
      }

      if (action === 'use') {
        answer();
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
        clearTimeout(state.timeout);
        imagePickerSessions.delete(chatId);
        await sendMessage('✅ *Image added to your post!*');
        state.resolve(state.currentUrl);
        return;
      }

      answer();
      return;
    }

    // Facebook page management
    if (data.startsWith('page:')) {
      const parts  = data.split(':');
      const action = parts[1];

      if (action === 'noop') { answer(); return; }

      if (action === 'addnew') {
        answer();
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
        await handleAddPage();
        return;
      }

      if (action === 'switch') {
        const targetPageId = parts.slice(2).join(':');
        answer();
        try {
          facebook.setActivePage(targetPageId);
          const { name } = facebook.getActivePage();
          await b.editMessageText(
            `✅ *Switched to: ${escapeMd(name)}*\n\nAll future posts will go to this page.`,
            { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
          ).catch(() => {});
          await showMainMenu(`📱 Active page: *${escapeMd(name)}*`);
        } catch (err) {
          logger.error('Page switch failed', { targetPageId, error: err.message });
          await sendMessage(`❌ Failed to switch page: ${escapeMd(err.message)}`);
        }
        return;
      }

      answer();
      return;
    }

    // Post management actions (list command buttons)
    if (data.startsWith('post:')) {
      const parts   = data.split(':');
      const action  = parts[1];
      const fbPostId = parts.slice(2).join(':');

      if (action === 'edit') {
        answer();
        const localPost = dbGet(
          `SELECT pp.*, pd.id as draft_id, pd.caption, pd.optimal_time
           FROM published_posts pp
           LEFT JOIN post_drafts pd ON pp.draft_id = pd.id
           WHERE pp.facebook_post_id = ?`,
          [fbPostId]
        );
        const currentCaption = localPost?.caption || '';
        const currentTime    = localPost?.optimal_time || null;

        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
        await sendMessage(
          `✏️ *Edit post*\n\n*Current caption:*\n${currentCaption}\n\n` +
          `Reply with your new caption, or send \`.\` to keep it as is:`
        );

        postEditSessions.set(chatId, { fbPostId, draftId: localPost?.draft_id, currentCaption, currentTime });

        registerAnswerCollector(chatId, async (input) => {
          const session = postEditSessions.get(chatId);
          if (!session) return;
          session.newCaption = input.trim() === '.' ? session.currentCaption : input.trim();

          const timeLabel = session.currentTime
            ? fmtFull(new Date(session.currentTime))
            : 'No schedule set';

          await b.sendMessage(chatId, `📅 *Update schedule?*\n\nCurrent: _${timeLabel}_`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
              [{ text: '⏰ Pick new time',           callback_data: `post:edittime:${fbPostId}` }],
              [{ text: '✅ Keep current schedule',   callback_data: `post:editsave:${fbPostId}` }],
            ]},
          }).catch(() => {});
        });

      } else if (action === 'edittime') {
        answer();
        const session = postEditSessions.get(chatId);
        if (!session) { await sendMessage('Session expired. Use *list* to try again.'); return; }
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});

        const seed = session.currentTime || new Date(Date.now() + 60 * 60 * 1000).toISOString();
        showDateTimePicker(seed)
          .then(async (newTime) => {
            session.newTime = newTime;
            await savePostEdit(chatId, session);
          })
          .catch(async () => {
            postEditSessions.delete(chatId);
            await sendMessage('⏰ Picker timed out. Use *list* to try again.');
          });

      } else if (action === 'editsave') {
        answer();
        const session = postEditSessions.get(chatId);
        if (!session) { await sendMessage('Session expired. Use *list* to try again.'); return; }
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
        session.newTime = session.currentTime;
        await savePostEdit(chatId, session);

      } else if (action === 'delete') {
        answer();
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
        await b.sendMessage(chatId, '🗑 *Are you sure?*\n\nThis will permanently delete the post from Facebook.', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: '✅ Yes, delete it', callback_data: `post:deleteconfirm:${fbPostId}` },
            { text: '❌ No, keep it',    callback_data: `post:deletecancel:${fbPostId}`  },
          ]]},
        }).catch(() => {});

      } else if (action === 'deleteconfirm') {
        answer();
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
        const result = await facebook.deletePost(fbPostId);
        if (result.success) {
          const local = dbGet('SELECT * FROM published_posts WHERE facebook_post_id = ?', [fbPostId]);
          if (local) {
            dbRun("UPDATE post_drafts SET status = 'deleted' WHERE id = ?", [local.draft_id]);
            dbRun('DELETE FROM published_posts WHERE facebook_post_id = ?', [fbPostId]);
          }
          await sendMessage('✅ *Post deleted from Facebook.*');
        } else {
          await sendMessage(`⚠️ Couldn't delete from Facebook: ${result.error}`);
        }

      } else if (action === 'deletecancel') {
        answer();
        await b.editMessageText('Deletion cancelled.', { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }).catch(() => {});

      } else if (action === 'draft') {
        answer();
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
        await b.sendMessage(chatId,
          '📋 *Move to draft?*\n\nThis will remove the post from your Facebook page. ' +
          'A local copy will be kept so you can republish it later.',
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[
              { text: '✅ Yes, move to draft', callback_data: `post:draftconfirm:${fbPostId}` },
              { text: '❌ No, keep it live',   callback_data: `post:draftcancel:${fbPostId}`  },
            ]]},
          }
        ).catch(() => {});

      } else if (action === 'draftconfirm') {
        answer();
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
        const result = await facebook.deletePost(fbPostId);
        const local = dbGet('SELECT * FROM published_posts WHERE facebook_post_id = ?', [fbPostId]);
        if (local) {
          dbRun("UPDATE post_drafts SET status = 'draft' WHERE id = ?", [local.draft_id]);
          dbRun('DELETE FROM published_posts WHERE facebook_post_id = ?', [fbPostId]);
        }
        if (result.success) {
          await sendMessage('📋 *Moved to draft.* The post has been removed from Facebook. You can republish it anytime.');
        } else {
          await sendMessage(`⚠️ Facebook removal failed: ${result.error}\nLocal record saved as draft anyway.`);
        }

      } else if (action === 'draftcancel') {
        answer();
        await b.editMessageText('No changes made.', { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }).catch(() => {});
      }

      return;
    }

    // Date-time picker
    if (!data.startsWith('dt:')) { answer(); return; }

    const state = pickerSessions.get(chatId);
    if (!state) { answer('Session expired. Please try again.', true); return; }

    const [, type, action] = data.split(':');

    if (type === 'noop') { answer(); return; }

    if (type === 'choice') {
      if (action === 'ai') {
        answer();
        clearTimeout(state.timeout);
        pickerSessions.delete(chatId);
        await b.editMessageText(`✅ *Scheduled for:* ${fmtFull(new Date(state.optimalTime))}`, {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
        }).catch(() => {});
        state.resolve(state.optimalTime);
      } else if (action === 'custom') {
        answer();
        await b.editMessageText(
          `📅 *Select a date:*`,
          { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: calendarKeyboard(state.calYear, state.calMonth) }
        ).catch(() => {});
      }
      return;
    }

    if (type === 'cal') {
      // action is "YYYY-MM"
      const [y, m] = action.split('-').map(Number);
      state.calYear  = y;
      state.calMonth = m - 1;
      answer();
      await b.editMessageReplyMarkup(
        calendarKeyboard(state.calYear, state.calMonth),
        { chat_id: chatId, message_id: messageId }
      ).catch(() => {});
      return;
    }

    if (type === 'day') {
      // action is "YYYY-MM-DD"
      state.selectedDateStr = action;
      answer();
      await b.editMessageText(
        `🕐 *Select time for ${fmtDateLabel(action)}:*`,
        { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: hourGrid() }
      ).catch(() => {});
      return;
    }

    if (type === 'hour') {
      state.hour = parseInt(action, 10);
      answer();
      await b.editMessageText(
        `⏱ *Select minutes:*\n_${fmtDateLabel(state.selectedDateStr)}, ${fmtHour(state.hour)}_`,
        { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: minuteGrid() }
      ).catch(() => {});
      return;
    }

    if (type === 'min') {
      state.minute = parseInt(action, 10);
      const selected = buildSelectedDate(state.selectedDateStr, state.hour, state.minute);
      if (selected.getTime() <= Date.now() + 10 * 60 * 1000) {
        answer('⚠️ Too soon! Pick a time at least 10 minutes from now.', true);
        return;
      }
      answer();
      clearTimeout(state.timeout);
      pickerSessions.delete(chatId);
      await b.editMessageText(`✅ *Scheduled for:* ${fmtFull(selected)}`, {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
      }).catch(() => {});
      state.resolve(selected.toISOString());
      return;
    }

    if (type === 'back') {
      answer();
      if (action === 'cal') {
        await b.editMessageText(
          `📅 *Select a date:*`,
          { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: calendarKeyboard(state.calYear, state.calMonth) }
        ).catch(() => {});
      } else if (action === 'hour') {
        await b.editMessageText(
          `🕐 *Select time for ${fmtDateLabel(state.selectedDateStr)}:*`,
          { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: hourGrid() }
        ).catch(() => {});
      }
      return;
    }

    answer();
  });

  // ── Text / command messages ───────────────────────────────────────────────
  b.on('message', async (msg) => {
    if (msg.date < BOT_START_TIME) {
      logger.debug('Ignoring stale message', { date: msg.date });
      return;
    }

    const chatId = String(msg.chat.id);
    const text   = (msg.text || '').trim();
    const lc     = text.toLowerCase();
    logger.debug('Telegram message received', { chatId, text: text.substring(0, 100) });

    // ── 1. fb-commands — always show, never interrupts anything ──────────────
    if (lc === 'fb-commands' || lc === '📖 fb-commands') {
      await sendFbCommands();
      return;
    }

    // ── 2. list — show posts without interrupting active session ─────────────
    if (lc === 'list' || lc === '📋 list') {
      if (listCallback) listCallback().catch((err) => logger.error('List error', { error: err.message }));
      return;
    }

    // ── 3. Other keywords — checked BEFORE answer collectors so they always work
    if (['start', 'begin', "let's roll", '🚀 start'].includes(lc)) {
      await handleStart();
      return;
    }
    if (['pause', 'wait'].includes(lc)) {
      await handlePause();
      return;
    }
    if (lc === 'delete') {
      await handleDelete(chatId);
      return;
    }
    if (lc === 'exit') {
      await handleExit(chatId);
      return;
    }
    if (lc === 'reschedule' || lc === '🔄 reschedule') {
      if (rescheduleCallback) rescheduleCallback().catch((err) => logger.error('Reschedule error', { error: err.message }));
      return;
    }
    if (lc === 'addpage' || lc === '/addpage') {
      await handleAddPage();
      return;
    }
    if (lc === '📱 pages') {
      await handlePagesList();
      return;
    }

    // ── 4. If paused, swallow everything else ────────────────────────────────
    if (session.isPaused) {
      await sendMessage("⏸ *Session paused.* Send *start*, *begin*, or *let's roll* to resume.");
      return;
    }

    // ── 5. Q&A / idea-selection answer collector ──────────────────────────────
    const answerResolve = answerCollectors.get(chatId);
    if (answerResolve && !text.startsWith('/')) {
      answerCollectors.delete(chatId);
      answerResolve(text);
      return;
    }

    // ── 6. /start slash or plain message → show menu / trigger flow ──────────
    if (text.startsWith('/') && !text.match(/^\/start$/i)) return; // ignore unknown slash commands

    if (approvalCallbacks.size > 0) {
      await sendMessage('⏳ A draft is waiting for your decision — use the buttons above the post.', { reply_markup: MAIN_MENU });
    } else if (autoFlowCallback) {
      // Show menu immediately so user sees something, then start the flow
      await showMainMenu('👍 Starting...');
      autoFlowCallback().catch((err) => logger.error('Auto flow callback error', { error: err.message }));
    } else {
      await showMainMenu('👋 *Facebook AI Agent is ready!*');
    }
  });

  logger.info('Telegram webhook handlers registered');
}

async function setWebhook(webhookUrl) {
  try {
    await getBot().setWebHook(`${webhookUrl.replace(/\/$/, '')}/telegram/webhook`);
    logger.info('Telegram webhook set', { url: `${webhookUrl}/telegram/webhook` });
  } catch (err) {
    logger.error('Failed to set Telegram webhook', { error: err.message });
  }
}

async function registerBotCommands() {
  const b = getBot();
  try {
    await b.setMyCommands([
      { command: 'start',       description: 'Start the FB Agent / create a new post' },
      { command: 'list',        description: 'View & manage your Facebook posts' },
      { command: 'reschedule',  description: 'Reschedule your last post' },
      { command: 'pause',       description: 'Pause the current session' },
      { command: 'delete',      description: 'Delete the current session' },
      { command: 'exit',        description: 'Exit and optionally start fresh' },
      { command: 'fb_commands', description: 'Show all available commands' },
    ]);
    // Show the commands menu button in the chat input bar
    await b.setChatMenuButton(config.TELEGRAM_CHAT_ID, { type: 'commands' });
    logger.info('Telegram bot commands registered');
  } catch (err) {
    logger.error('Failed to register bot commands', { error: err.message });
  }
}

export {
  getBot,
  sendMessage,
  sendApprovalRequest,
  sendWeeklyReport,
  sendMetricsAlert,
  registerApprovalCallback,
  removeApprovalCallback,
  registerAnswerCollector,
  removeAnswerCollector,
  getApprovalCallbacks,
  getAnswerCollectors,
  registerAutoFlowCallback,
  registerRescheduleCallback,
  registerListCallback,
  registerResetFlowCallback,
  showDateTimePicker,
  showImagePicker,
  showMainMenu,
  escapeMd,
  setupWebhookHandlers,
  setWebhook,
  registerBotCommands,
  handlePagesConnected,
};
