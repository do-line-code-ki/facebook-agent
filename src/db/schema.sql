-- Topics queued for content generation
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- pending | processing | done
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Generated post ideas for a topic
CREATE TABLE IF NOT EXISTS post_ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER REFERENCES topics(id),
  post_type TEXT NOT NULL,
  idea_title TEXT NOT NULL,
  idea_description TEXT,
  predicted_score REAL DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending | selected | skipped
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Full post drafts ready for approval
CREATE TABLE IF NOT EXISTS post_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER REFERENCES post_ideas(id),
  caption TEXT NOT NULL,
  hashtags TEXT,
  call_to_action TEXT,
  pre_publish_actions TEXT,
  post_publish_actions TEXT,
  image_suggestions TEXT,
  optimal_time DATETIME,
  status TEXT DEFAULT 'pending_approval', -- pending_approval | approved | rejected | published
  rejection_reason TEXT,
  revision_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Approval sessions
CREATE TABLE IF NOT EXISTS approval_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER REFERENCES post_drafts(id),
  telegram_message_id INTEGER,
  status TEXT DEFAULT 'waiting', -- waiting | approved | rejected | revision_requested
  user_feedback TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME
);

-- Published posts
CREATE TABLE IF NOT EXISTS published_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER REFERENCES post_drafts(id),
  facebook_post_id TEXT UNIQUE NOT NULL,
  published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  caption_snapshot TEXT,
  post_type TEXT,
  topic TEXT
);

-- Performance metrics
CREATE TABLE IF NOT EXISTS post_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  published_post_id INTEGER REFERENCES published_posts(id),
  facebook_post_id TEXT NOT NULL,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reach INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  engagement_rate REAL DEFAULT 0,
  is_winner INTEGER DEFAULT 0
);

-- Winner patterns
CREATE TABLE IF NOT EXISTS winner_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_type TEXT NOT NULL,
  avg_engagement_rate REAL,
  best_day_of_week INTEGER,
  best_hour INTEGER,
  common_topics TEXT,
  sample_size INTEGER DEFAULT 0,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(post_type)
);

-- Comment tracking
CREATE TABLE IF NOT EXISTS post_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  published_post_id INTEGER REFERENCES published_posts(id),
  facebook_comment_id TEXT UNIQUE,
  commenter_name TEXT,
  comment_text TEXT,
  sentiment TEXT,
  reply_drafted TEXT,
  reply_sent INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Weekly performance reports
CREATE TABLE IF NOT EXISTS weekly_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  total_posts INTEGER DEFAULT 0,
  avg_engagement_rate REAL DEFAULT 0,
  best_post_id INTEGER REFERENCES published_posts(id),
  worst_post_id INTEGER REFERENCES published_posts(id),
  top_post_type TEXT,
  insights TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
