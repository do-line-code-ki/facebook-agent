import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import logger from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure data directory exists
const dbDir = path.dirname(path.resolve(config.DB_PATH));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db;

function initDb() {
  try {
    db = new Database(path.resolve(config.DB_PATH));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Run schema
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schema);

    // Migrations — safe to re-run (errors = column/table already exists)
    try { db.exec('ALTER TABLE post_drafts ADD COLUMN image_url TEXT'); } catch {}
    try { db.exec('ALTER TABLE published_posts ADD COLUMN page_id TEXT'); } catch {}
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS facebook_pages (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          page_id      TEXT UNIQUE NOT NULL,
          page_name    TEXT NOT NULL,
          access_token TEXT NOT NULL,
          is_active    INTEGER DEFAULT 0,
          added_at     DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } catch {}

    // Seed the default page from env vars if no pages exist yet
    const pageCount = db.prepare('SELECT COUNT(*) as n FROM facebook_pages').get();
    if (pageCount.n === 0 && config.FACEBOOK_PAGE_ID && config.FACEBOOK_PAGE_ACCESS_TOKEN) {
      db.prepare(
        `INSERT OR IGNORE INTO facebook_pages (page_id, page_name, access_token, is_active)
         VALUES (?, ?, ?, 1)`
      ).run(config.FACEBOOK_PAGE_ID, 'Default Page', config.FACEBOOK_PAGE_ACCESS_TOKEN);
      logger.info('Seeded default Facebook page from env vars', { pageId: config.FACEBOOK_PAGE_ID });
    }

    logger.info('Database initialized', { path: config.DB_PATH });
  } catch (err) {
    logger.error('Failed to initialize database', { error: err.message });
    throw err;
  }
}

function dbRun(sql, params = []) {
  try {
    return db.prepare(sql).run(params);
  } catch (err) {
    logger.error('DB run error', { sql, error: err.message });
    throw err;
  }
}

function dbGet(sql, params = []) {
  try {
    return db.prepare(sql).get(params);
  } catch (err) {
    logger.error('DB get error', { sql, error: err.message });
    throw err;
  }
}

function dbAll(sql, params = []) {
  try {
    return db.prepare(sql).all(params);
  } catch (err) {
    logger.error('DB all error', { sql, error: err.message });
    throw err;
  }
}

function closeDb() {
  if (db) {
    db.close();
    logger.info('Database connection closed');
  }
}

export { initDb, dbRun, dbGet, dbAll, closeDb };
export default db;
