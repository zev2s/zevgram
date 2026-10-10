CREATE TABLE IF NOT EXISTS users (
  login TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  login TEXT NOT NULL REFERENCES users(login) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  author_login TEXT NOT NULL REFERENCES users(login),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  login TEXT NOT NULL REFERENCES users(login) ON DELETE CASCADE,
  PRIMARY KEY (post_id, login)
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_login TEXT NOT NULL REFERENCES users(login),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS friends (
  login TEXT NOT NULL REFERENCES users(login) ON DELETE CASCADE,
  friend_login TEXT NOT NULL REFERENCES users(login) ON DELETE CASCADE,
  PRIMARY KEY (login, friend_login)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_login TEXT NOT NULL REFERENCES users(login),
  to_login TEXT NOT NULL REFERENCES users(login),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS groups_ (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL REFERENCES users(login),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
  login TEXT NOT NULL REFERENCES users(login) ON DELETE CASCADE,
  PRIMARY KEY (group_id, login)
);
CREATE TABLE IF NOT EXISTS bookmarks (
  login TEXT NOT NULL REFERENCES users(login) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  PRIMARY KEY (login, post_id)
);
CREATE INDEX IF NOT EXISTS posts_created_idx ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS messages_pair_idx ON messages(from_login, to_login, created_at);
CREATE INDEX IF NOT EXISTS comments_post_idx ON comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

