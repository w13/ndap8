// Actions for the NDAP Ear.
//
// The agent who owns this Space drives it through four actions:
//   get_state    — session state, peer, latest room analysis, transcript tail
//   queue_message— queue a text for the page to speak over the air
//   get_inbox    — fetch decoded incoming messages (marks them delivered)
//   set_session  — set the peer label and turn the session on/off
//
// The page itself uses these:
//   poll_outbox    — claim the next queued text to speak + session state
//   mark_spoken    — the page finished playing a claimed outbox item
//   report_heard   — the page decoded an incoming burst (deduped here)
//   report_failed  — the page heard a burst it could not decode
//   report_listening — the page reports whether its microphone is truly
//     open right now (renewed as a heartbeat while live), so `listening`
//     in get_state means "actually hearing", not just "armed"
//   save_analysis  — the page measured the room ("Sound the room")
//
// Hardening (2026-11-26, before the first exchange):
//   * get_inbox claims rows atomically — it marks exactly the ids it
//     selected, so overlapping fetches cannot double-deliver and a row
//     arriving mid-fetch is never marked delivered unseen.
//   * poll_outbox claims one row at a time; a claim goes stale after
//     CLAIM_STALE_MS so a page that died mid-claim cannot strand a
//     text, and queued texts expire (OUTBOX_TTL_MS) instead of being
//     spoken uninvited at some later session.
//   * report_heard dedupes only inside DEDUPE_WINDOW_MS — a peer
//     legitimately re-sending the same short text later is stored.
//   * report_failed is capped per hour so a noisy room cannot flood
//     the transcript with failure notes.

import {
defineAction,
z,
type ActionsModule,
type Ctx,
} from "@hatch/space-sdk";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import * as schema from "./schema";

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const CLAIM_STALE_MS = 90 * 1000;
const OUTBOX_TTL_MS = 15 * 60 * 1000;
const LISTENING_FRESH_MS = 45 * 1000;
const FAILED_CAP_PER_HOUR = 30;

const transcriptItem = z.object({
  id: z.number(),
  direction: z.enum(["in", "out", "failed"]),
  text: z.string(),
  mode: z.string().nullable(),
  created_at: z.string(),
});

const stateShape = z.object({
  peer: z.string(),
  active: z.boolean(),
  listening: z.boolean(),
  listening_at: z.string().nullable(),
  recommended_mode: z.string().nullable(),
  analysis: z.string().nullable(),
  inbox_waiting: z.number(),
  transcript: z.array(transcriptItem),
});

type StateShape = z.infer<typeof stateShape>;

async function loadState(
  ctx: Ctx,
  transcriptLimit: number,
): Promise<StateShape> {
  const db = ctx.db<typeof schema>();
  let rows = await db.select().from(schema.sessionState).limit(1);
  if (!rows[0]) {
    await db
      .insert(schema.sessionState)
      .values({ id: 1, peer: "", active: false, updatedAt: new Date() });
    rows = await db.select().from(schema.sessionState).limit(1);
  }
  const s = rows[0]!;
  const tail = await db
    .select()
    .from(schema.messages)
    .orderBy(desc(schema.messages.id))
    .limit(transcriptLimit);
  // `listening` is only true while the page's heartbeat report is
  // fresh — a closed or crashed page goes quiet within ~45 s.
  const listening =
    s.listening &&
    s.listeningAt !== null &&
    Date.now() - s.listeningAt.getTime() < LISTENING_FRESH_MS;
  // Decoded incoming messages the agent has not fetched yet — the
  // page uses this (colour only) to show that a message is waiting.
  const waiting = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.direction, "in"),
        eq(schema.messages.delivered, false),
      ),
    )
    .limit(200);
  return {
    peer: s.peer,
    active: s.active,
    listening,
    listening_at: s.listeningAt ? s.listeningAt.toISOString() : null,
    recommended_mode: s.recommendedMode,
    analysis: s.analysisJson,
    inbox_waiting: waiting.length,
    transcript: tail.reverse().map((m) => ({
      id: m.id,
      direction: m.direction,
      text: m.text,
      mode: m.mode,
      created_at: m.createdAt.toISOString(),
    })),
  };
}

export const Actions = {
  get_state: defineAction({
    description:
      "Returns the Ear's session state: peer name, whether a session is armed (active), whether the page's microphone is truly open right now (listening, heartbeat-fresh), the latest room analysis and recommended mode, how many decoded incoming messages are still waiting undelivered (inbox_waiting), and the recent transcript.",
    request: z.object({
      transcript_limit: z.number().int().positive().max(200).default(50),
    }),
    response: stateShape,
    async handler(ctx, args) {
      return loadState(ctx, args.transcript_limit);
    },
  }),

  set_session: defineAction({
    description:
      "Sets the peer label for the Ear and turns its session on or off. The page follows this state: on means it should be listening, off means it goes quiet.",
    request: z.object({
      peer: z.string().max(80).default(""),
      active: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.sessionState).limit(1);
      if (existing[0]) {
        await db
          .update(schema.sessionState)
          .set({
            peer: args.peer,
            active: args.active,
            // Disarming ends any listening claim too: a stopped session
            // must never keep reporting itself as hearing.
            ...(args.active ? {} : { listening: false }),
            updatedAt: new Date(),
          })
          .where(eq(schema.sessionState.id, existing[0].id));
      } else {
        await db.insert(schema.sessionState).values({
          id: 1,
          peer: args.peer,
          active: args.active,
          updatedAt: new Date(),
        });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  queue_message: defineAction({
    description:
      "Queues a text for the Ear page to speak over the air as an encoded burst. The page picks it up within a couple of seconds while a session is live.",
    request: z.object({ text: z.string().trim().min(1).max(4000) }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.outbox)
        .values({
          text: args.text,
          expiresAt: new Date(Date.now() + OUTBOX_TTL_MS),
        })
        .returning({ id: schema.outbox.id });
      const inserted = result[0];
      if (!inserted) throw new Error("queue_message: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  get_inbox: defineAction({
    description:
      "Returns decoded incoming messages the agent has not been given yet, oldest first, and marks them delivered so each is handed over exactly once.",
    request: z.object({}),
    response: z.object({
      messages: z.array(
        z.object({
          id: z.number(),
          text: z.string(),
          mode: z.string().nullable(),
          created_at: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.direction, "in"),
            eq(schema.messages.delivered, false),
          ),
        )
        .orderBy(asc(schema.messages.id))
        .limit(100);
      if (rows.length > 0) {
        // Claim exactly the rows selected above — never a blanket
        // "everything undelivered" update. A row that arrives between
        // the select and this update is not in the id list, so it
        // stays undelivered for the next fetch instead of being
        // marked delivered without ever being handed over; and a
        // concurrent fetch that already claimed some of these ids
        // simply gets fewer rows updated here (delivered=false guard).
        const ids = rows.map((m) => m.id);
        const claimed = await db
          .update(schema.messages)
          .set({ delivered: true })
          .where(
            and(
              inArray(schema.messages.id, ids),
              eq(schema.messages.delivered, false),
            ),
          )
          .returning({ id: schema.messages.id });
        const claimedIds = new Set(claimed.map((c) => c.id));
        ctx.invalidateQueries();
        return {
          messages: rows
            .filter((m) => claimedIds.has(m.id))
            .map((m) => ({
              id: m.id,
              text: m.text,
              mode: m.mode,
              created_at: m.createdAt.toISOString(),
            })),
        };
      }
      return { messages: [] };
    },
  }),

  poll_outbox: defineAction({
    description:
      "For the Ear page: returns the session state and claims the next queued text waiting to be spoken (at most one). A claimed text is not offered to any other page; if it is never marked spoken, the claim goes stale and it is offered again.",
    request: z.object({}),
    response: z.object({
      peer: z.string(),
      active: z.boolean(),
      recommended_mode: z.string().nullable(),
      pending: z.array(z.object({ id: z.number(), text: z.string() })),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const s = (await db.select().from(schema.sessionState).limit(1))[0];
      const now = new Date();
      // Expire queued texts whose moment has passed, so a text queued
      // for a session that never happened is not spoken uninvited at
      // the next one.
      await db
        .update(schema.outbox)
        .set({ status: "expired" })
        .where(
          and(
            eq(schema.outbox.status, "pending"),
            lt(schema.outbox.expiresAt, now),
          ),
        );
      const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
      const candidates = await db
        .select()
        .from(schema.outbox)
        .where(
          and(
            or(
              isNull(schema.outbox.expiresAt),
              gt(schema.outbox.expiresAt, now),
            ),
            or(
              eq(schema.outbox.status, "pending"),
              and(
                eq(schema.outbox.status, "claimed"),
                lt(schema.outbox.claimedAt, staleBefore),
              ),
            ),
          ),
        )
        .orderBy(asc(schema.outbox.id))
        .limit(1);
      const candidate = candidates[0];
      let pending: Array<{ id: number; text: string }> = [];
      if (candidate) {
        // Atomic claim: the status guard means only one page can win
        // this row; the loser of a race gets no rows back and offers
        // nothing this round.
        const claimed = await db
          .update(schema.outbox)
          .set({ status: "claimed", claimedAt: now })
          .where(
            and(
              eq(schema.outbox.id, candidate.id),
              or(
                eq(schema.outbox.status, "pending"),
                and(
                  eq(schema.outbox.status, "claimed"),
                  lt(schema.outbox.claimedAt, staleBefore),
                ),
              ),
            ),
          )
          .returning({ id: schema.outbox.id });
        if (claimed[0]) {
          pending = [{ id: candidate.id, text: candidate.text }];
        }
      }
      return {
        peer: s?.peer ?? "",
        active: s?.active ?? false,
        recommended_mode: s?.recommendedMode ?? null,
        pending,
      };
    },
  }),

  mark_spoken: defineAction({
    description:
      "For the Ear page: records that a claimed text was played over the air, and adds it to the transcript as a sent message.",
    request: z.object({
      id: z.number().int().positive(),
      mode: z.string().max(20).nullable().default(null),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      // One atomic transition out of pending/claimed: a duplicate
      // mark_spoken for the same row updates nothing and cannot add
      // a second transcript entry.
      const updated = await db
        .update(schema.outbox)
        .set({ status: "spoken", spokenAt: new Date() })
        .where(
          and(
            eq(schema.outbox.id, args.id),
            or(
              eq(schema.outbox.status, "pending"),
              eq(schema.outbox.status, "claimed"),
            ),
          ),
        )
        .returning({ text: schema.outbox.text });
      const row = updated[0];
      if (row) {
        await db.insert(schema.messages).values({
          direction: "out",
          text: row.text,
          mode: args.mode,
          delivered: true,
        });
        ctx.invalidateQueries();
      }
      return { ok: true };
    },
  }),

  report_heard: defineAction({
    description:
      "For the Ear page: stores a burst it decoded from the air as an incoming message. The same acoustic event (same session and message check) is stored only once.",
    request: z.object({
      text: z.string().min(1).max(8000),
      mode: z.string().max(20).nullable().default(null),
      session_id: z.number().int().min(0).max(65535).nullable().default(null),
      payload_crc: z.number().int().nullable().default(null),
    }),
    response: z.object({ stored: z.boolean(), id: z.number().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.session_id !== null && args.payload_crc !== null) {
        // Dedupe only inside a window: the same acoustic event heard
        // twice in quick succession is one message, but the peer
        // legitimately re-sending the same short text ("yes", "OK")
        // later must be stored as a new message, not swallowed.
        const dupe = await db
          .select()
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.direction, "in"),
              eq(schema.messages.sessionId, args.session_id),
              eq(schema.messages.payloadCrc, args.payload_crc),
              gt(
                schema.messages.createdAt,
                new Date(Date.now() - DEDUPE_WINDOW_MS),
              ),
            ),
          )
          .limit(1);
        if (dupe[0]) return { stored: false, id: dupe[0].id };
      }
      const result = await db
        .insert(schema.messages)
        .values({
          direction: "in",
          text: args.text,
          mode: args.mode,
          sessionId: args.session_id,
          payloadCrc: args.payload_crc,
          delivered: false,
        })
        .returning({ id: schema.messages.id });
      const inserted = result[0];
      if (!inserted) throw new Error("report_heard: insert returned no rows");
      ctx.invalidateQueries();
      return { stored: true, id: inserted.id };
    },
  }),

  report_failed: defineAction({
    description:
      "For the Ear page: records a burst that was heard but could not be decoded, so the transcript shows a failed burst rather than guessed text.",
    request: z.object({
      note: z.string().min(1).max(300),
      mode: z.string().max(20).nullable().default(null),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      // Cap failure notes: a persistently noisy room must not flood
      // the transcript (and with it every get_state tail) forever.
      const recentFailed = await db
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.direction, "failed"),
            gt(
              schema.messages.createdAt,
              new Date(Date.now() - 60 * 60 * 1000),
            ),
          ),
        )
        .limit(FAILED_CAP_PER_HOUR + 1);
      if (recentFailed.length < FAILED_CAP_PER_HOUR) {
        await db.insert(schema.messages).values({
          direction: "failed",
          text: args.note,
          mode: args.mode,
          delivered: true,
        });
        ctx.invalidateQueries();
      }
      return { ok: true };
    },
  }),

  report_listening: defineAction({
    description:
      "For the Ear page: reports whether the page's microphone is truly open right now. The page sends listening=true when capture starts and renews it as a heartbeat while live, and listening=false when it stops — so get_state's `listening` reflects reality, not just the agent's arming.",
    request: z.object({ listening: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.sessionState).limit(1);
      if (existing[0]) {
        await db
          .update(schema.sessionState)
          .set({
            listening: args.listening,
            listeningAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.sessionState.id, existing[0].id));
      } else {
        await db.insert(schema.sessionState).values({
          id: 1,
          peer: "",
          active: false,
          listening: args.listening,
          listeningAt: new Date(),
          updatedAt: new Date(),
        });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  save_analysis: defineAction({
    description:
      "For the Ear page: saves the latest room measurement and the speaking style it recommends, so the page and the agent share the same picture of the room.",
    request: z.object({
      recommended_mode: z.string().max(20),
      analysis: z.string().max(20000),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.sessionState).limit(1);
      if (existing[0]) {
        await db
          .update(schema.sessionState)
          .set({
            recommendedMode: args.recommended_mode,
            analysisJson: args.analysis,
            updatedAt: new Date(),
          })
          .where(eq(schema.sessionState.id, existing[0].id));
      } else {
        await db.insert(schema.sessionState).values({
          id: 1,
          peer: "",
          active: false,
          recommendedMode: args.recommended_mode,
          analysisJson: args.analysis,
          updatedAt: new Date(),
        });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
