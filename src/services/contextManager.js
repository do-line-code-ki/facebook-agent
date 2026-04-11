import fs from 'fs';
import path from 'path';
import logger from '../logger.js';

export const CONTEXT_DIR = path.resolve('Context Files');
const LEGACY_PATH       = path.resolve('page_context.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Lowercase + keep only alphanumeric for fuzzy comparison */
function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Make a string safe to use as a filename */
export function sanitizeFileName(name) {
  return String(name || 'default')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    || 'default';
}

// ─── Migration ────────────────────────────────────────────────────────────────

/**
 * One-time migration: if the old page_context.json still exists at the project
 * root, copy it into Context Files/ using its page_name field as the filename.
 */
export function migrateLegacyContext() {
  if (!fs.existsSync(LEGACY_PATH)) return;
  try {
    const data = JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf-8'));
    const safeName = sanitizeFileName(data.page_name || 'Default_Page');
    if (!fs.existsSync(CONTEXT_DIR)) fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    const dest = path.join(CONTEXT_DIR, `${safeName}.json`);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(LEGACY_PATH, dest);
      logger.info('Migrated legacy page_context.json → Context Files/', { safeName });
    }
  } catch (err) {
    logger.warn('Legacy context migration failed', { error: err.message });
  }
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Find the best-matching .json file in Context Files/ for the given page name.
 * Priority: exact match → substring match → null.
 */
export function findContextFile(pageName) {
  if (!fs.existsSync(CONTEXT_DIR)) return null;
  const files = fs.readdirSync(CONTEXT_DIR).filter((f) => f.endsWith('.json'));
  if (!files.length) return null;

  const target = normalize(pageName);

  // 1. Exact (normalized)
  for (const f of files) {
    if (normalize(path.basename(f, '.json')) === target) return path.join(CONTEXT_DIR, f);
  }

  // 2. Substring (either direction)
  for (const f of files) {
    const base = normalize(path.basename(f, '.json'));
    if (base.includes(target) || target.includes(base)) return path.join(CONTEXT_DIR, f);
  }

  return null;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Load the context object for a page name.
 * Runs the legacy migration first, then fuzzy-matches the filename.
 * Returns null if no matching file exists.
 */
export function loadContext(pageName) {
  migrateLegacyContext();
  const filePath = findContextFile(pageName);
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    logger.warn('Failed to read context file', { filePath, error: err.message });
    return null;
  }
}

/**
 * Persist a context object to Context Files/{sanitized pageName}.json.
 * Returns the absolute path of the saved file.
 */
export function saveContext(pageName, pageId, contextData) {
  if (!fs.existsSync(CONTEXT_DIR)) fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  const safeName = sanitizeFileName(pageName);
  const filePath = path.join(CONTEXT_DIR, `${safeName}.json`);
  const payload  = {
    page_name:  pageName,
    page_id:    pageId,
    created_at: new Date().toISOString().split('T')[0],
    updated_at: new Date().toISOString().split('T')[0],
    ...contextData,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  logger.info('Context file saved', { filePath });
  return filePath;
}

/**
 * Delete the context file for a page.  Returns true if a file was removed.
 */
export function deleteContext(pageName) {
  const filePath = findContextFile(pageName);
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    logger.info('Context file deleted', { pageName });
    return true;
  }
  return false;
}

/** Minimal fallback returned when no context file is found (cron flows). */
export function getDefaultContext() {
  return {
    page_name:       'My Facebook Page',
    industry:        'General',
    target_audience: 'General audience',
    tone_of_voice:   'Professional but friendly',
    content_pillars: ['Educational', 'Entertaining', 'Promotional'],
  };
}
