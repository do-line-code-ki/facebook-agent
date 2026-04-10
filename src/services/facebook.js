import axios from 'axios';
import config from '../config.js';
import logger from '../logger.js';
import { dbGet, dbAll, dbRun } from '../db/index.js';

const BASE_URL = config.FACEBOOK_API_BASE;

// ─── Active page helpers ──────────────────────────────────────────────────────

/** Returns the currently active page's credentials, falling back to env vars. */
function getActivePage() {
  try {
    const page = dbGet('SELECT * FROM facebook_pages WHERE is_active = 1');
    if (page) {
      return { pageId: page.page_id, token: page.access_token, name: page.page_name };
    }
  } catch {
    // DB not ready yet (startup) — fall through to env vars
  }
  return {
    pageId: config.FACEBOOK_PAGE_ID,
    token:  config.FACEBOOK_PAGE_ACCESS_TOKEN,
    name:   'Default Page',
  };
}

/** Returns all saved pages from DB. */
function getAllPages() {
  try {
    return dbAll('SELECT page_id, page_name, is_active FROM facebook_pages ORDER BY is_active DESC, page_name ASC');
  } catch {
    return [];
  }
}

/** Switches the active page. */
function setActivePage(pageId) {
  dbRun('UPDATE facebook_pages SET is_active = 0');
  dbRun('UPDATE facebook_pages SET is_active = 1 WHERE page_id = ?', [pageId]);
  logger.info('Active Facebook page switched', { pageId });
}

// ─── Core request helper ──────────────────────────────────────────────────────

async function fbRequest(method, endpoint, params = {}, data = {}, retryCount = 0) {
  const { token } = getActivePage();
  const url = `${BASE_URL}${endpoint}`;
  const requestParams = { access_token: token, ...params };

  try {
    logger.debug(`Facebook API ${method.toUpperCase()} ${endpoint}`);
    const response = await axios({ method, url, params: requestParams, data });
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const fbError = err.response?.data?.error;
    const errorCode = fbError?.code;

    // Rate limit handling
    if ((errorCode === 32 || errorCode === 613) && retryCount < 3) {
      logger.warn('Facebook rate limit hit, waiting 60s', { code: errorCode });
      await new Promise((r) => setTimeout(r, 60000));
      return fbRequest(method, endpoint, params, data, retryCount + 1);
    }

    // General retry for server errors
    if (status >= 500 && retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000;
      logger.warn(`Facebook API server error, retrying in ${delay}ms`, { status, attempt: retryCount + 1 });
      await new Promise((r) => setTimeout(r, delay));
      return fbRequest(method, endpoint, params, data, retryCount + 1);
    }

    logger.error('Facebook API error', {
      endpoint,
      status,
      error: fbError?.message || err.message,
      code: errorCode,
    });
    throw err;
  }
}

async function publishPost(caption, scheduledTime = null) {
  const { pageId } = getActivePage();
  const data = { message: caption };

  if (scheduledTime) {
    const unixTime = Math.floor(new Date(scheduledTime).getTime() / 1000);
    const nowPlus10 = Math.floor(Date.now() / 1000) + 600;
    const nowPlus30Days = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

    if (unixTime > nowPlus10 && unixTime < nowPlus30Days) {
      data.published = false;
      data.scheduled_publish_time = unixTime;
    }
  }

  const result = await fbRequest('post', `/${pageId}/feed`, {}, data);
  logger.info('Facebook post published', { post_id: result.id, scheduled: !!scheduledTime });
  return { success: true, post_id: result.id };
}

async function getPostMetrics(facebookPostId) {
  const metrics = [
    'post_impressions',
    'post_reach',
    'post_reactions_by_type_total',
    'post_clicks',
  ];

  let insightsData = {};
  let postData = {};

  try {
    const insightsResult = await fbRequest('get', `/${facebookPostId}/insights`, {
      metric: metrics.join(','),
      period: 'lifetime',
    });

    if (insightsResult.data) {
      for (const item of insightsResult.data) {
        const values = item.values;
        const val = values && values.length > 0 ? values[values.length - 1].value : 0;
        insightsData[item.name] = typeof val === 'object' ? Object.values(val).reduce((a, b) => a + b, 0) : val;
      }
    }
  } catch (err) {
    logger.warn('Could not fetch post insights', { post_id: facebookPostId, error: err.message });
  }

  try {
    postData = await fbRequest('get', `/${facebookPostId}`, {
      fields: 'shares,comments.summary(true),likes.summary(true)',
    });
  } catch (err) {
    logger.warn('Could not fetch post summary data', { post_id: facebookPostId, error: err.message });
  }

  const reach = insightsData['post_reach'] || 0;
  const impressions = insightsData['post_impressions'] || 0;
  const likes = postData.likes?.summary?.total_count || insightsData['post_reactions_by_type_total'] || 0;
  const comments = postData.comments?.summary?.total_count || 0;
  const shares = postData.shares?.count || 0;
  const clicks = insightsData['post_clicks'] || 0;

  const total_interactions = likes + comments + shares + clicks;
  const engagement_rate = reach > 0 ? total_interactions / reach : 0;

  return {
    facebook_post_id: facebookPostId,
    reach,
    impressions,
    likes,
    comments,
    shares,
    clicks,
    engagement_rate: parseFloat(engagement_rate.toFixed(4)),
  };
}

async function getPageInsights() {
  const { pageId } = getActivePage();
  const pageMetrics = ['page_impressions', 'page_reach', 'page_engaged_users'];

  let insightsData = {};
  let pageData = {};

  try {
    const result = await fbRequest('get', `/${pageId}/insights`, {
      metric: pageMetrics.join(','),
      period: 'days_28',
    });
    if (result.data) {
      for (const item of result.data) {
        const values = item.values;
        insightsData[item.name] = values && values.length > 0 ? values[values.length - 1].value : 0;
      }
    }
  } catch (err) {
    logger.warn('Could not fetch page insights', { error: err.message });
  }

  try {
    pageData = await fbRequest('get', `/${pageId}`, {
      fields: 'fan_count,talking_about_count',
    });
  } catch (err) {
    logger.warn('Could not fetch page data', { error: err.message });
  }

  return {
    impressions: insightsData['page_impressions'] || 0,
    reach: insightsData['page_reach'] || 0,
    engaged_users: insightsData['page_engaged_users'] || 0,
    fan_count: pageData.fan_count || 0,
    talking_about_count: pageData.talking_about_count || 0,
  };
}

async function getPostComments(facebookPostId) {
  try {
    const result = await fbRequest('get', `/${facebookPostId}/comments`, {
      fields: 'id,message,from,created_time',
      limit: 100,
    });
    return result.data || [];
  } catch (err) {
    logger.warn('Could not fetch post comments', { post_id: facebookPostId, error: err.message });
    return [];
  }
}

async function replyToComment(commentId, message) {
  try {
    const result = await fbRequest('post', `/${commentId}/comments`, {}, { message });
    logger.info('Reply sent to comment', { comment_id: commentId });
    return { success: true, id: result.id };
  } catch (err) {
    logger.error('Failed to reply to comment', { comment_id: commentId, error: err.message });
    return { success: false, error: err.message };
  }
}

async function reschedulePost(facebookPostId, newTimeIso) {
  const unixTime = Math.floor(new Date(newTimeIso).getTime() / 1000);
  try {
    await fbRequest('post', `/${facebookPostId}`, {}, {
      scheduled_publish_time: unixTime,
      published: false,
    });
    logger.info('Facebook post rescheduled', { post_id: facebookPostId, newTime: newTimeIso });
    return { success: true };
  } catch (err) {
    logger.error('Failed to reschedule Facebook post', { post_id: facebookPostId, error: err.message });
    return { success: false, error: err.message };
  }
}

async function publishPhotoPost(caption, imageUrl, scheduledTime = null) {
  const { pageId } = getActivePage();
  const data = { url: imageUrl, caption };

  if (scheduledTime) {
    const unixTime = Math.floor(new Date(scheduledTime).getTime() / 1000);
    const nowPlus10 = Math.floor(Date.now() / 1000) + 600;
    const nowPlus30Days = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    if (unixTime > nowPlus10 && unixTime < nowPlus30Days) {
      data.published = false;
      data.scheduled_publish_time = unixTime;
    }
  }

  const result = await fbRequest('post', `/${pageId}/photos`, {}, data);
  logger.info('Facebook photo post published', { post_id: result.id, scheduled: !!scheduledTime });
  return { success: true, post_id: result.id };
}

async function getScheduledPosts() {
  const { pageId } = getActivePage();
  try {
    const result = await fbRequest('get', `/${pageId}/scheduled_posts`, {
      fields: 'id,message,scheduled_publish_time',
      limit: 25,
    });
    return result.data || [];
  } catch (err) {
    logger.warn('Could not fetch scheduled posts', { error: err.message });
    return [];
  }
}

async function getPublishedPosts() {
  const { pageId } = getActivePage();
  try {
    const result = await fbRequest('get', `/${pageId}/posts`, {
      fields: 'id,message,created_time',
      limit: 25,
    });
    return result.data || [];
  } catch (err) {
    logger.warn('Could not fetch published posts', { error: err.message });
    return [];
  }
}

async function deletePost(postId) {
  try {
    await fbRequest('delete', `/${postId}`);
    logger.info('Facebook post deleted', { post_id: postId });
    return { success: true };
  } catch (err) {
    logger.error('Failed to delete Facebook post', { post_id: postId, error: err.message });
    return { success: false, error: err.message };
  }
}

async function updatePost(postId, { message, scheduledTime } = {}) {
  const data = {};
  if (message) data.message = message;
  if (scheduledTime) {
    const unixTime = Math.floor(new Date(scheduledTime).getTime() / 1000);
    const nowPlus10 = Math.floor(Date.now() / 1000) + 600;
    const nowPlus30Days = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    if (unixTime > nowPlus10 && unixTime < nowPlus30Days) {
      data.scheduled_publish_time = unixTime;
      data.published = false;
    }
  }
  try {
    await fbRequest('post', `/${postId}`, {}, data);
    logger.info('Facebook post updated', { post_id: postId });
    return { success: true };
  } catch (err) {
    logger.error('Failed to update Facebook post', { post_id: postId, error: err.message });
    return { success: false, error: err.message };
  }
}

export {
  publishPost, publishPhotoPost, getPostMetrics, getPageInsights, getPostComments,
  replyToComment, reschedulePost,
  getScheduledPosts, getPublishedPosts, deletePost, updatePost,
  getActivePage, getAllPages, setActivePage,
};
