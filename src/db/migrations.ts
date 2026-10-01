const now = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

/**
 * Schema migrations, applied in order. Index + 1 is the version stored in PRAGMA user_version.
 * Never edit a migration that has shipped: append a new one.
 * Timestamps are ISO 8601 in UTC.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE drafts (
    id INTEGER PRIMARY KEY,
    network TEXT NOT NULL DEFAULT 'x',
    slot_at TEXT NOT NULL,
    pillar TEXT NOT NULL CHECK (pillar IN ('ai', 'startups', 'deeptech', 'devtools', 'motion')),
    topic TEXT NOT NULL,
    tweet TEXT NOT NULL,
    why_it_matters TEXT NOT NULL,
    sources TEXT NOT NULL CHECK (json_valid(sources) AND json_type(sources) = 'array'),
    asset_request TEXT CHECK (asset_request IS NULL OR json_valid(asset_request)),
    trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('x_post', 'rss', 'hn')),
    trigger_ref TEXT NOT NULL,
    trigger_url TEXT NOT NULL,
    trigger_published_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'refused', 'edited', 'posted')),
    refusal_reason TEXT,
    posted_url TEXT,
    prompt_version TEXT NOT NULL,
    telegram_message_id INTEGER,
    created_at TEXT NOT NULL DEFAULT ${now},
    updated_at TEXT NOT NULL DEFAULT ${now}
  );
  CREATE INDEX drafts_status ON drafts (status);
  CREATE INDEX drafts_slot ON drafts (slot_at);

  CREATE TABLE excluded_topics (
    id INTEGER PRIMARY KEY,
    topic TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('posted', 'refused')),
    draft_id INTEGER REFERENCES drafts (id) ON DELETE SET NULL,
    excluded_until TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${now}
  );
  CREATE INDEX excluded_topics_until ON excluded_topics (excluded_until);

  -- post_text holds someone else's post: purged 24 h after created_at, only ids and URLs stay.
  CREATE TABLE replies (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('to_other', 'to_received')),
    origin TEXT NOT NULL CHECK (origin IN ('watchlist', 'mention', 'pasted')),
    x_post_id TEXT,
    x_post_url TEXT,
    author_handle TEXT,
    post_text TEXT,
    post_text_purged_at TEXT,
    parent_post_id TEXT,
    parent_post_url TEXT,
    worth_replying INTEGER CHECK (worth_replying IN (0, 1)),
    worth_reason TEXT,
    variants TEXT CHECK (variants IS NULL OR (json_valid(variants) AND json_type(variants) = 'array')),
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'replied', 'skipped')),
    created_at TEXT NOT NULL DEFAULT ${now},
    updated_at TEXT NOT NULL DEFAULT ${now}
  );
  CREATE INDEX replies_to_purge ON replies (created_at) WHERE post_text IS NOT NULL;
  CREATE INDEX replies_post ON replies (x_post_id);

  -- One row per service and day: Europe/Paris day for Mistral (EUR), UTC day for X (USD).
  CREATE TABLE spend (
    service TEXT NOT NULL CHECK (service IN ('mistral', 'x')),
    day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    mistral_input_tokens INTEGER NOT NULL DEFAULT 0,
    mistral_output_tokens INTEGER NOT NULL DEFAULT 0,
    mistral_connector_tokens INTEGER NOT NULL DEFAULT 0,
    web_search_calls INTEGER NOT NULL DEFAULT 0,
    x_posts_read INTEGER NOT NULL DEFAULT 0,
    x_users_read INTEGER NOT NULL DEFAULT 0,
    x_owned_reads INTEGER NOT NULL DEFAULT 0,
    cost_incl_vat REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (service, day)
  ) WITHOUT ROWID;

  -- Posts read from watched accounts. text and public_metrics are purged 24 h after fetched_at.
  CREATE TABLE x_posts (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL,
    url TEXT NOT NULL,
    posted_at TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    text TEXT,
    public_metrics TEXT CHECK (public_metrics IS NULL OR json_valid(public_metrics)),
    purged_at TEXT
  );
  CREATE INDEX x_posts_to_purge ON x_posts (fetched_at) WHERE text IS NOT NULL;
  CREATE INDEX x_posts_author ON x_posts (author_id, posted_at);

  -- Handle to numeric id, resolved once per watched account.
  CREATE TABLE x_users (
    user_id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
    resolved_at TEXT NOT NULL
  );

  -- Last since_id per stream: 'timeline:<user_id>' or 'mentions'.
  CREATE TABLE x_cursors (
    stream TEXT PRIMARY KEY,
    since_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) WITHOUT ROWID;

  -- Resources X bills, once per UTC day, mirroring its deduplication.
  CREATE TABLE x_reads (
    utc_day TEXT NOT NULL,
    resource TEXT NOT NULL CHECK (resource IN ('post', 'user', 'owned_post')),
    resource_id TEXT NOT NULL,
    PRIMARY KEY (utc_day, resource, resource_id)
  ) WITHOUT ROWID;

  CREATE TABLE feed_items (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('rss', 'hn')),
    feed TEXT NOT NULL,
    guid TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    published_at TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    UNIQUE (source, guid)
  );

  -- "Parler à Mistral" history, wiped by /reset. Pasted posts go to replies, not here.
  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY,
    network TEXT NOT NULL DEFAULT 'x',
    draft_id INTEGER REFERENCES drafts (id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${now}
  );
  `,
  `
  -- Items (x:<id>, rss:<id>, hn:<id>) grouped into the draft's topic, so they never trigger twice.
  ALTER TABLE drafts ADD COLUMN topic_items TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(topic_items) AND json_type(topic_items) = 'array');

  -- Hacker News: the thread URL, and engagement read at fetch time. url holds the linked article when there is one.
  ALTER TABLE feed_items ADD COLUMN discussion_url TEXT;
  ALTER TABLE feed_items ADD COLUMN score INTEGER;
  ALTER TABLE feed_items ADD COLUMN comments INTEGER;
  CREATE INDEX feed_items_published ON feed_items (published_at);

  -- Round-robin order when the X budget runs out mid-cycle.
  ALTER TABLE x_users ADD COLUMN last_polled_at TEXT;

  -- One row per slot, so a slot is handled once even across restarts and sleep.
  CREATE TABLE slot_runs (
    slot_at TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running', 'drafted', 'pending_draft', 'no_topic', 'failed', 'budget')),
    detail TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  ) WITHOUT ROWID;

  -- Last run of periodic jobs (poll, purge).
  CREATE TABLE job_runs (
    name TEXT PRIMARY KEY,
    last_run_at TEXT NOT NULL
  ) WITHOUT ROWID;
  `,
];
