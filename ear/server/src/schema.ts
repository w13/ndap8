// Drizzle schema for the NDAP Ear.
//
// Three tables:
//   session_state — a single row (id = 1): peer label, whether a session
//     is live, the latest room analysis / recommended mode, and the
//     page's own listening report (`listening` + `listening_at`, a
//     heartbeat the page renews while its microphone is truly open —
//     `active` alone only means the agent armed the session).
//   messages — the transcript: every sent and received message, plus
//     failed bursts (direction "failed", text holds the failure note).
//     Incoming rows carry session_id + payload_crc so duplicates of the
//     same acoustic event are stored once (within a dedupe window),
//     and `delivered` tracks whether the owning agent has fetched the
//     message via get_inbox (claimed atomically, exactly once).
//   outbox — texts the agent queued for the page to speak; the page
//     claims one row at a time (status "claimed") so two open pages
//     can never speak the same text, stale claims become claimable
//     again, and rows carry an expiry so a text queued for a session
//     that never happened is never spoken uninvited later.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionState = sqliteTable("session_state", {
  id: integer("id").primaryKey(),
  peer: text("peer").notNull().default(""),
  active: integer("active", { mode: "boolean" }).notNull().default(false),
  listening: integer("listening", { mode: "boolean" })
    .notNull()
    .default(false),
  listeningAt: integer("listening_at", { mode: "timestamp_ms" }),
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
  status: text("status", { enum: ["pending", "claimed", "spoken", "expired"] })
    .notNull()
    .default("pending"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  spokenAt: integer("spoken_at", { mode: "timestamp_ms" }),
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
});
