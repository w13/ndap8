DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE session_state (
  id INTEGER PRIMARY KEY,
  peer TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 0,
  recommended_mode TEXT,
  analysis_json TEXT,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO session_state (id, peer, active, updated_at) VALUES (1, '', 0, 0);
--> statement-breakpoint
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  text TEXT NOT NULL,
  mode TEXT,
  session_id INTEGER,
  payload_crc INTEGER,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  spoken_at INTEGER
);
