ALTER TABLE session_state ADD COLUMN listening INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE session_state ADD COLUMN listening_at INTEGER;
--> statement-breakpoint
ALTER TABLE outbox ADD COLUMN claimed_at INTEGER;
--> statement-breakpoint
ALTER TABLE outbox ADD COLUMN expires_at INTEGER;
