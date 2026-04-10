import axios from 'axios';
import crypto from 'crypto';
import config from '../config.js';
import logger from '../logger.js';
import { dbRun, dbAll } from '../db/index.js';

// ─── In-memory OAuth state store (CSRF protection) ───────────────────────────
const oauthStates = new Map();

// Injected by index.js to avoid circular imports
let _onPagesConnected = null;

function registerOAuthNotifier(fn) {
  _onPagesConnected = fn;
}

// ─── OAuth URL builder ────────────────────────────────────────────────────────
function getFacebookOAuthUrl() {
  if (!config.FACEBOOK_APP_ID || !config.FACEBOOK_APP_SECRET) {
    throw new Error(
      'FACEBOOK_APP_ID and FACEBOOK_APP_SECRET are not set. ' +
      'Create a Facebook App at https://developers.facebook.com and add both to your environment variables.'
    );
  }
  if (!config.WEBHOOK_BASE_URL) {
    throw new Error(
      'WEBHOOK_BASE_URL is not set. This must be your public server URL (e.g. https://your-app.railway.app) ' +
      'so Facebook knows where to redirect after login.'
    );
  }

  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { createdAt: Date.now() });
  // Auto-expire state after 15 minutes
  setTimeout(() => oauthStates.delete(state), 15 * 60 * 1000);

  const callbackUrl = `${config.WEBHOOK_BASE_URL.replace(/\/$/, '')}/auth/facebook/callback`;
  const params = new URLSearchParams({
    client_id:     config.FACEBOOK_APP_ID,
    redirect_uri:  callbackUrl,
    scope:         'pages_manage_posts,pages_read_engagement,pages_show_list,pages_manage_metadata,pages_read_user_content',
    state,
    response_type: 'code',
  });

  return `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
}

// ─── OAuth callback route ─────────────────────────────────────────────────────
function setupFacebookAuthRoutes(app) {
  app.get('/auth/facebook/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;

    // User cancelled / denied
    if (error) {
      logger.warn('Facebook OAuth denied by user', { error, error_description });
      if (_onPagesConnected) _onPagesConnected(null, 'denied');
      return res.send(htmlPage(
        '❌ Login Cancelled',
        'You denied access to your Facebook Pages. Close this window and tap <b>Add Page</b> in Telegram again if you change your mind.'
      ));
    }

    // Validate CSRF state
    if (!state || !oauthStates.has(state)) {
      logger.warn('Invalid or expired OAuth state', { state });
      return res.status(400).send(htmlPage(
        '❌ Link Expired',
        'This login link has expired or is invalid. Go back to Telegram and run <b>addpage</b> to get a fresh link.'
      ));
    }
    oauthStates.delete(state);

    if (!code) {
      return res.status(400).send(htmlPage('❌ Missing Code', 'Authorization code missing. Please try again.'));
    }

    try {
      const callbackUrl = `${config.WEBHOOK_BASE_URL.replace(/\/$/, '')}/auth/facebook/callback`;

      // Exchange authorization code for a user access token
      const tokenRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
        params: {
          client_id:     config.FACEBOOK_APP_ID,
          client_secret: config.FACEBOOK_APP_SECRET,
          redirect_uri:  callbackUrl,
          code,
        },
      });
      const userToken = tokenRes.data.access_token;

      // Fetch all pages this user manages (each page has its own long-lived token)
      const pagesRes = await axios.get('https://graph.facebook.com/v19.0/me/accounts', {
        params: {
          access_token: userToken,
          fields:       'id,name,access_token,category',
          limit:        50,
        },
      });
      const pages = pagesRes.data.data || [];

      if (pages.length === 0) {
        if (_onPagesConnected) _onPagesConnected([], 'no_pages');
        return res.send(htmlPage(
          '⚠️ No Pages Found',
          'No Facebook Pages were found on your account. You need to be an <b>Admin</b> of a Facebook Page. Close this window and check your account.'
        ));
      }

      // Upsert pages into DB (preserve is_active for pages already saved)
      for (const page of pages) {
        dbRun(
          `INSERT INTO facebook_pages (page_id, page_name, access_token, is_active)
           VALUES (?, ?, ?, 0)
           ON CONFLICT(page_id) DO UPDATE
             SET page_name    = excluded.page_name,
                 access_token = excluded.access_token`,
          [page.id, page.name, page.access_token]
        );
      }

      logger.info('Facebook pages connected via OAuth', {
        count: pages.length,
        names: pages.map((p) => p.name),
      });

      if (_onPagesConnected) _onPagesConnected(pages, 'success');

      const plural = pages.length > 1 ? 's' : '';
      return res.send(htmlPage(
        '✅ Connected!',
        `${pages.length} Facebook Page${plural} connected successfully! Close this window and return to Telegram to choose your active page.`
      ));

    } catch (err) {
      logger.error('Facebook OAuth callback error', { error: err.message });
      if (_onPagesConnected) _onPagesConnected(null, 'error', err.message);
      return res.status(500).send(htmlPage(
        '❌ Connection Failed',
        `Something went wrong: ${err.message}<br><br>Close this window and try <b>addpage</b> again in Telegram.`
      ));
    }
  });

  logger.info('Facebook OAuth route registered', { route: 'GET /auth/facebook/callback' });
}

// ─── Minimal HTML response page ───────────────────────────────────────────────
function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    *  { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: #f0f2f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #fff;
      border-radius: 16px;
      padding: 40px 32px;
      max-width: 420px;
      width: 100%;
      text-align: center;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    h1 { font-size: 22px; margin-bottom: 14px; color: #1c1e21; }
    p  { color: #65676b; line-height: 1.65; font-size: 15px; }
    .fb { color: #1877f2; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${body}</p>
    <p style="margin-top:20px;font-size:13px;color:#bcc0c4;">
      <span class="fb">Facebook AI Agent</span>
    </p>
  </div>
</body>
</html>`;
}

export { getFacebookOAuthUrl, setupFacebookAuthRoutes, registerOAuthNotifier };
