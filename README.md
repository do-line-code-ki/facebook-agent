# Facebook AI Agent

A fully automated Facebook Page AI Agent that manages your page end-to-end: generating post ideas, drafting content, getting your approval via Telegram, publishing at optimal times, tracking performance metrics, and continuously learning from past data.

---

## Overview

The agent runs as a Node.js server and performs these core functions automatically:

- **Weekly**: Picks a topic from your queue, generates 5 post ideas using Claude AI, selects the best one, asks you clarifying questions via Telegram, drafts a complete post, and sends it to you for approval
- **Daily**: Fetches performance metrics from Facebook, identifies winner posts, and updates its learning patterns
- **Every 2 hours**: Scans new comments, analyzes sentiment, alerts you to negative comments
- **Weekly report**: Sends a comprehensive performance report with AI-generated insights

---

## Prerequisites

- **Node.js 20+**
- **A Facebook Business Page** with a Meta App that has `pages_manage_posts` and `pages_read_engagement` permissions
- **A Telegram Bot** and your Telegram Chat ID
- **A public HTTPS URL** for webhooks (use [ngrok](https://ngrok.com) for local dev, or deploy to [Railway](https://railway.app) / [Render](https://render.com) for production)
- **An Anthropic API key** from [console.anthropic.com](https://console.anthropic.com)

---

## Setup

### 1. Clone and install

```bash
git clone <your-repo>
cd fb-agent
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in all values (see [Environment Variables](#environment-variables) below).

### 3. Edit page context

Open `page_context.json` and fill in your page's details:

```json
{
  "page_name": "Your Actual Page Name",
  "industry": "Real Estate",
  "target_audience": "Homeowners aged 30-50 in Mumbai",
  "tone_of_voice": "Professional but approachable",
  "content_pillars": ["Market tips", "Success stories", "Neighbourhood guides"],
  ...
}
```

### 4. How to get your Facebook Page Access Token

1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Create a new App → choose **Business** type
3. Add the **Facebook Login** product and the **Pages API** product
4. Go to **Graph API Explorer** → select your app
5. Click **Generate Access Token** → grant `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`
6. Use the **Access Token Debugger** to exchange for a long-lived page token
7. Copy the token into `FACEBOOK_PAGE_ACCESS_TOKEN` in your `.env`
8. Find your Page ID from your Facebook Page's **About** section → paste into `FACEBOOK_PAGE_ID`

### 5. How to create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the bot token → paste into `TELEGRAM_BOT_TOKEN` in your `.env`

### 6. How to get your Telegram Chat ID

1. Start a conversation with your new bot (send `/start`)
2. Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Look for `"chat":{"id":XXXXXXXXX}` — that number is your Chat ID
4. Paste into `TELEGRAM_CHAT_ID` in your `.env`

### 7. Set your public webhook URL

For local development with ngrok:
```bash
ngrok http 3000
# Copy the https://xxxx.ngrok.io URL
```

Set `WEBHOOK_BASE_URL=https://xxxx.ngrok.io` in your `.env`.

For production, deploy to Railway/Render and use the assigned HTTPS URL.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key |
| `FACEBOOK_PAGE_ID` | ✅ | Your Facebook Page's numeric ID |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | ✅ | Long-lived Facebook Page Access Token |
| `TELEGRAM_BOT_TOKEN` | ✅ | Token from @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | Your Telegram chat/user ID |
| `PORT` | ❌ | HTTP server port (default: 3000) |
| `DB_PATH` | ❌ | SQLite database path (default: ./data/agent.db) |
| `LOG_LEVEL` | ❌ | Logging level: debug/info/warn/error (default: info) |
| `TOPIC_SCHEDULE_CRON` | ❌ | Cron for weekly topic trigger (default: Monday 9am) |
| `METRICS_FETCH_CRON` | ❌ | Cron for daily metrics (default: 8am daily) |
| `WEEKLY_REPORT_CRON` | ❌ | Cron for weekly report (default: Monday 9:05am) |
| `WEBHOOK_BASE_URL` | ❌ | Your public HTTPS URL for Telegram webhook |

---

## Running the Agent

```bash
node index.js
```

On first run, the agent will:
1. Initialize the SQLite database
2. Register the Telegram webhook (if `WEBHOOK_BASE_URL` is set)
3. Start all cron jobs
4. Send you a Telegram welcome message

---

## Adding Topics

Queue a topic for the agent to process:

```bash
curl -X POST http://localhost:3000/agent/topic \
  -H "Content-Type: application/json" \
  -d '{"topic": "5 things first-time homebuyers always get wrong"}'
```

The topic will be picked up at the next scheduled run (Monday 9am by default), or you can trigger it immediately by running the cron manually.

---

## Telegram Approval Flow

When the agent generates a post draft, it sends you a Telegram message like this:

```
📝 NEW POST DRAFT #42

Type: educational

Caption:
[Full post text here...]

Hashtags: #realestate #tips #homebuying

CTA: Drop your biggest home-buying question in the comments!

📋 Before publishing:
• Create an infographic showing the 5 mistakes visually
• Schedule post for Tuesday 10am

📋 After publishing:
• Reply to first 5 comments within 1 hour
• Share to your Stories

⏰ Optimal time: Tuesday, 10:00 AM IST
```

Reply with:
- `/approve 42` — publish the post as-is
- `/revise 42 Make the tone more casual and add a personal story` — Claude rewrites it with your feedback
- `/reject 42 Not relevant to our current campaign` — discard the draft

---

## Folder Structure

```
fb-agent/
├── index.js              # Entry point
├── page_context.json     # Your page configuration
├── .env.example          # Environment variable template
├── src/
│   ├── config.js         # Env var loader + validator
│   ├── logger.js         # Winston logger
│   ├── db/
│   │   ├── index.js      # SQLite init + helpers
│   │   └── schema.sql    # Database schema
│   ├── services/
│   │   ├── claude.js     # All Claude API calls
│   │   ├── facebook.js   # Meta Graph API calls
│   │   └── telegram.js   # Telegram bot + webhook
│   ├── agents/
│   │   ├── ideaAgent.js      # Generates + scores post ideas
│   │   ├── draftAgent.js     # Q&A + draft generation
│   │   ├── scheduleAgent.js  # Optimal publish time
│   │   └── analyticsAgent.js # Metrics, patterns, comments
│   ├── flows/
│   │   ├── contentFlow.js    # Full idea→draft→approval→publish pipeline
│   │   └── learningFlow.js   # Metrics→patterns learning cycle
│   ├── scheduler/
│   │   └── jobs.js       # All cron job definitions
│   └── server/
│       └── webhooks.js   # Express route definitions
└── data/
    └── agent.db          # SQLite database (auto-created)
```

---

## Troubleshooting

**Agent fails to start with "Missing required environment variables"**
→ Make sure you copied `.env.example` to `.env` and filled in all values.

**Telegram webhook not working**
→ Ensure `WEBHOOK_BASE_URL` is a valid public HTTPS URL. Telegram requires HTTPS — use ngrok for local dev (`ngrok http 3000`).

**Facebook API errors (code 190 - invalid token)**
→ Your page access token has expired. Generate a new long-lived token from the Graph API Explorer.

**Facebook API rate limits (code 32 or 613)**
→ The agent automatically waits 60 seconds and retries. If persistent, reduce posting frequency.

**Claude API errors**
→ Check your `ANTHROPIC_API_KEY` is valid and has sufficient credits. The agent retries up to 3 times with exponential backoff.

**"No pending draft #X found" in Telegram**
→ The approval session may have expired or been resolved. Queue a new topic to generate a fresh draft.

**Posts not scheduled at optimal times**
→ On first run there's no winner data yet. The agent defaults to Tuesday/Thursday 10am. After a few weeks of data, it learns your page's best times.

**Database errors**
→ Check that the `data/` directory is writable. Delete `data/agent.db` to reset the database (you'll lose all history).
