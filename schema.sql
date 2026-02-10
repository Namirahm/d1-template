CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_user_id INTEGER UNIQUE,
  github_login TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  github_owner TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  manifest_path TEXT NOT NULL DEFAULT 'comicyore/manifest.json',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(github_owner, github_repo),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS comics (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  cached_manifest_json TEXT,
  cached_at TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(repo_id, slug),
  FOREIGN KEY(repo_id) REFERENCES repos(id)
);

CREATE TABLE IF NOT EXISTS r2_objects (
  key TEXT PRIMARY KEY,
  owner_user_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_referenced_at TEXT,
  FOREIGN KEY(owner_user_id) REFERENCES users(id)
);
"