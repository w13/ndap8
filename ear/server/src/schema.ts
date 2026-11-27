// Drizzle schema for the NDAP Ear.
//
// Three tables:
//   session_state — a single row (id = 1): peer label, whether a session
//     is live, and the latest room analysis / recommended mode.
//   messages — the transcript: every sent and received message, plus
//     failed bursts (direction "failed", text holds the failure note).
//     Incoming rows carry session_id + payload_crc so duplicates of the
//     same acoustic event are stored once, and `delivered` tracks
//     whether the owning agent has fetched the message via get_inbox.
//   outbox — texts the agent queued for the page to speak; the page
//     polls for pending rows and marks them spoken.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionState = sqliteTable("session_state", {
  id: integer("id").primaryKey(),
  peer: text("peer").notNull().default(""),
  active: integer("active", { mode: "boolean" }).notNull().default(false),
  recommendedMode: text("recommended_mode"),
  analysisJson: text("analysis_json"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  direction: text("direction", { enum: ["in", "out", "failed"] }).notNull(),
  text: text("text").notNull(),
  mode: text("mode"),
  sessionId: integer("session_id"),
  payloadCrc: integer("payload_crc"),
  delivered: integer("delivered", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const outbox = sqliteTable("outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
  status: text("status", { enum: ["pending", "spoken"] })
    .notNull()
    .default("pending"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  spokenAt: integer("spoken_at", { mode: "timestamp_ms" }),
});
