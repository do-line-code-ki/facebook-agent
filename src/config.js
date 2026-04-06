import 'dotenv/config';

const REQUIRED_VARS = [
  'ANTHROPIC_API_KEY',
  'FACEBOOK_PAGE_ID',
  'FACEBOOK_PAGE_ACCESS_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
];

function validateEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach((key) => console.error(`   - ${key}`));
    console.error('\nCopy .env.example to .env and fill in all values.');
    process.exit(1);
  }
}

validateEnv();

const config = Object.freeze({
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  FACEBOOK_PAGE_ID: process.env.FACEBOOK_PAGE_ID,
  FACEBOOK_PAGE_ACCESS_TOKEN: process.env.FACEBOOK_PAGE_ACCESS_TOKEN,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  PORT: parseInt(process.env.PORT || '3000', 10),
  DB_PATH: process.env.DB_PATH || './data/agent.db',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  TOPIC_SCHEDULE_CRON: process.env.TOPIC_SCHEDULE_CRON || '0 9 * * 1',
  METRICS_FETCH_CRON: process.env.METRICS_FETCH_CRON || '0 8 * * *',
  WEEKLY_REPORT_CRON: process.env.WEEKLY_REPORT_CRON || '5 9 * * 1',
  WEBHOOK_BASE_URL: process.env.WEBHOOK_BASE_URL || '',
  FACEBOOK_API_BASE: 'https://graph.facebook.com/v19.0',
});

export default config;
