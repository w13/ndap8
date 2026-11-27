// Actions for the NDAP Ear.
//
// The agent who owns this Space drives it through four actions:
//   get_state    — session state, peer, latest room analysis, transcript tail
//   queue_message— queue a text for the page to speak over the air
//   get_inbox    — fetch decoded incoming messages (marks them delivered)
//   set_session  — set the peer label and turn the session on/off
//
// The page itself uses three more:
//   poll_outbox    — pending texts to speak + session state (one round trip)
//   mark_spoken    — the page finished playing an outbox item
//   report_heard   — the page decoded an incoming burst (deduped here)
//   report_failed  — the page heard a burst it could not decode
//   save_analysis  — the page measured the room ("Sound the room")

import {
defineAction,
z,
type ActionsModule,
type Ctx,
} from "@hatch/space-sdk";
import { and, asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";

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
  recommended_mode: z.string().nullable(),
  analysis: z.string().nullable(),
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
  return {
    peer: s.peer,
    active: s.active,
    recommended_mode: s.recommendedMode,
    analysis: s.analysisJson,
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
      "Returns the Ear's session state: peer name, whether a session is live, the latest room analysis and recommended mode, and the recent transcript.",
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
          .set({ peer: args.peer, active: args.active, updatedAt: new Date() })
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
        .values({ text: args.text })
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
        await db
          .update(schema.messages)
          .set({ delivered: true })
          .where(
            and(
              eq(schema.messages.direction, "in"),
              eq(schema.messages.delivered, false),
            ),
          );
        ctx.invalidateQueries();
      }
      return {
        messages: rows.map((m) => ({
          id: m.id,
          text: m.text,
          mode: m.mode,
          created_at: m.createdAt.toISOString(),
        })),
      };
    },
  }),

  poll_outbox: defineAction({
    description:
      "For the Ear page: returns the session state and any queued texts waiting to be spoken, oldest first.",
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
      const pending = await db
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.status, "pending"))
        .orderBy(asc(schema.outbox.id))
        .limit(20);
      return {
        peer: s?.peer ?? "",
        active: s?.active ?? false,
        recommended_mode: s?.recommendedMode ?? null,
        pending: pending.map((p) => ({ id: p.id, text: p.text })),
      };
    },
  }),

  mark_spoken: defineAction({
    description:
      "For the Ear page: records that a queued text was played over the air, and adds it to the transcript as a sent message.",
    request: z.object({
      id: z.number().int().positive(),
      mode: z.string().max(20).nullable().default(null),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const row = (
        await db
          .select()
          .from(schema.outbox)
          .where(eq(schema.outbox.id, args.id))
          .limit(1)
      )[0];
      if (row && row.status === "pending") {
        await db
          .update(schema.outbox)
          .set({ status: "spoken", spokenAt: new Date() })
          .where(eq(schema.outbox.id, args.id));
        await db.insert(schema.messages).values({
          direction: "out",
          text: row.text,
          mode: args.mode,
          delivered: true,
        });
      }
      ctx.invalidateQueries();
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
        const dupe = await db
          .select()
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.direction, "in"),
              eq(schema.messages.sessionId, args.session_id),
              eq(schema.messages.payloadCrc, args.payload_crc),
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
      await db.insert(schema.messages).values({
        direction: "failed",
        text: args.note,
        mode: args.mode,
        delivered: true,
      });
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
