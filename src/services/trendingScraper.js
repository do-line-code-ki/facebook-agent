import axios from 'axios';
import logger from '../logger.js';

// ─── In-memory cache (30-minute TTL) ─────────────────────────────────────────
const _cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function getCached(key) {
  const entry = _cache.get(key);
  if (entry && Date.now() < entry.expiry) return entry.data;
  _cache.delete(key);
  return null;
}
function setCached(key, data) {
  _cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
}

// ─── XML helpers ──────────────────────────────────────────────────────────────

/** Extract text from a single XML tag, handling CDATA */
function extractText(block, tag) {
  // CDATA: <tag><![CDATA[...]]></tag>
  const cdata = block.match(new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, 'i'));
  if (cdata) return cdata[1].trim();
  // Plain text
  const plain = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!plain) return '';
  return plain[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .trim();
}

/** Parse RSS XML → array of { title, url, snippet } */
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = extractText(block, 'title');
    const url   = extractText(block, 'link') || extractText(block, 'guid');
    const snippet = extractText(block, 'description');
    if (title && title.length > 5) items.push({ title, url, snippet: snippet.slice(0, 200) });
  }
  return items;
}

// ─── Source fetchers ──────────────────────────────────────────────────────────

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; FBContentAgent/1.0)',
  Accept: 'application/rss+xml, application/xml, text/xml, application/json, */*',
};
const TIMEOUT = 12000;

/** Google News RSS — industry-specific articles */
async function fetchGoogleNews(query) {
  const cacheKey = `gnews:${query}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en&gl=US&ceid=US:en`;
    const { data } = await axios.get(url, { timeout: TIMEOUT, headers: HTTP_HEADERS });
    const items = parseRSS(data).slice(0, 8).map(i => ({ ...i, source: 'google_news' }));
    setCached(cacheKey, items);
    logger.info('Google News fetched', { query, count: items.length });
    return items;
  } catch (err) {
    logger.warn('Google News fetch failed', { query, error: err.message });
    return [];
  }
}

/** Reddit search — community discussions */
async function fetchReddit(query) {
  const cacheKey = `reddit:${query}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=hot&limit=15&t=week`;
    const { data } = await axios.get(url, {
      timeout: TIMEOUT,
      headers: { 'User-Agent': 'FBContentAgent/1.0 (content research)' },
    });
    const posts = data?.data?.children || [];
    const items = posts
      .filter(p => !p.data.over_18 && p.data.score > 5)
      .slice(0, 8)
      .map(p => ({
        title:   p.data.title,
        url:     `https://reddit.com${p.data.permalink}`,
        snippet: (p.data.selftext || '').slice(0, 200),
        source:  'reddit',
      }));
    setCached(cacheKey, items);
    logger.info('Reddit fetched', { query, count: items.length });
    return items;
  } catch (err) {
    logger.warn('Reddit fetch failed', { query, error: err.message });
    return [];
  }
}

/** Google Trends daily trending searches RSS */
async function fetchGoogleTrends(geo = 'US') {
  const cacheKey = `gtrends:${geo}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${geo}`;
    const { data } = await axios.get(url, { timeout: TIMEOUT, headers: HTTP_HEADERS });
    const items = parseRSS(data).slice(0, 10).map(i => ({ ...i, source: 'google_trends' }));
    setCached(cacheKey, items);
    logger.info('Google Trends fetched', { geo, count: items.length });
    return items;
  } catch (err) {
    logger.warn('Google Trends fetch failed', { error: err.message });
    return [];
  }
}

// ─── Query builder ────────────────────────────────────────────────────────────

/**
 * Build search queries from page context.
 * Uses industry, about text, and content pillars to create targeted searches.
 */
function buildSearchQueries(pageContext) {
  const queries = new Set();

  // Primary: industry field or first 4 words of "about"
  const industry = (pageContext.industry || '').trim();
  const about    = (pageContext.about || pageContext.page_name || '').trim();
  const primary  = industry || about.split(/\s+/).slice(0, 4).join(' ');
  if (primary) queries.add(primary);

  // Add content pillars combined with industry (up to 2 extra queries)
  const pillars = Array.isArray(pageContext.content_pillars) ? pageContext.content_pillars : [];
  for (const pillar of pillars.slice(0, 2)) {
    if (typeof pillar === 'string' && pillar.trim()) {
      queries.add(`${primary} ${pillar.trim()}`.trim());
    }
  }

  return [...queries].filter(Boolean).slice(0, 3);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetch trending topics relevant to the page's industry.
 *
 * @param {object} pageContext - loaded context from contextManager
 * @returns {Array<{ title, url, snippet, source }>}
 *   source: 'google_news' | 'reddit' | 'google_trends'
 */
async function fetchTrendingTopics(pageContext) {
  const queries = buildSearchQueries(pageContext);
  if (queries.length === 0) {
    logger.warn('No queries built from page context — skipping trend fetch');
    return [];
  }

  logger.info('Fetching trending topics', { queries });

  // Run all fetches in parallel; individual failures are swallowed
  const results = await Promise.allSettled([
    ...queries.map(q => fetchGoogleNews(q)),
    fetchReddit(queries[0]),
    fetchGoogleTrends(),
  ]);

  const all = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(t => t && t.title && t.title.length > 5);

  // Deduplicate by normalised title prefix
  const seen = new Set();
  const unique = all.filter(t => {
    const key = t.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const bySource = {
    google_news:   unique.filter(t => t.source === 'google_news').length,
    reddit:        unique.filter(t => t.source === 'reddit').length,
    google_trends: unique.filter(t => t.source === 'google_trends').length,
  };
  logger.info('Trending topics ready', { total: unique.length, bySource });

  return unique.slice(0, 25); // cap for Claude context size
}

export { fetchTrendingTopics };
