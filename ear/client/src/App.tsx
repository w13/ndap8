import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api } from "./api";
import { EarEngine } from "./ear-engine";

function randomPingDelayMs() {
  // The heartbeat burst is very small, so it beats faster: jittered 1–3 s.
  return 1000 + Math.floor(Math.random() * 2001);
}

export function App() {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<EarEngine | null>(null);
  const speakingRef = useRef(false);
  const liveRef = useRef(false);
  liveRef.current = live;
  const pingingRef = useRef(false);
  const autoTriedRef = useRef(false);
  const pingTimerRef = useRef<number | null>(null);

  const state = useQuery({
    queryKey: ["state"],
    queryFn: () => api.get_state({ transcript_limit: 1 }),
    refetchInterval: 2000,
  });

  const outbox = useQuery({
    queryKey: ["outbox"],
    queryFn: () => api.poll_outbox({}),
    refetchInterval: 2000,
  });

  const peer = state.data?.peer ?? "";

  const clearPingTimer = () => {
    if (pingTimerRef.current !== null) {
      window.clearTimeout(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (state.data && !state.data.active && liveRef.current) {
      void (async () => {
        clearPingTimer();
        await engineRef.current?.stop();
        setLive(false);
      })();
    }
  }, [state.data?.active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const engine = new EarEngine({
      onState: () => {},
      onLevel: () => {},
      onNote: () => {},
      onHeard: (m) => {
        void (async () => {
          await api.report_heard({
            text: m.text,
            mode: m.mode,
            session_id: m.sessionId,
            payload_crc: m.payloadCrc,
          });
          queryClient.invalidateQueries({ queryKey: ["state"] });
        })();
      },
      onFailed: (noteText, mode) => {
        void (async () => {
          await api.report_failed({ note: noteText, mode });
          queryClient.invalidateQueries({ queryKey: ["state"] });
        })();
      },
    });
    engineRef.current = engine;
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void engine.reacquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearPingTimer();
      void engine.stop();
      engineRef.current = null;
    };
  }, [queryClient]);

  useEffect(() => {
    const next = outbox.data?.pending[0];
    if (!live || !next || speakingRef.current) return;
    speakingRef.current = true;
    void (async () => {
      try {
        const mode = await engineRef.current!.speak(next.text);
        await api.mark_spoken({ id: next.id, mode });
        queryClient.invalidateQueries({ queryKey: ["state"] });
        queryClient.invalidateQueries({ queryKey: ["outbox"] });
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "A message could not be spoken.",
        );
      } finally {
        speakingRef.current = false;
      }
    })();
  }, [outbox.data, live, queryClient]);

  const setSession = useMutation({
    mutationFn: async (args: { peer: string; active: boolean }) =>
      await api.set_session(args),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const saveAnalysis = useMutation({
    mutationFn: async (args: { recommended_mode: string; analysis: string }) =>
      await api.save_analysis(args),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const doPing = async () => {
    const engine = engineRef.current;
    if (!engine || pingingRef.current || !liveRef.current) return;
    pingingRef.current = true;
    try {
      await engine.ping();
      const analysis = engine.lastAnalysis;
      if (analysis) {
        saveAnalysis.mutate({
          recommended_mode: analysis.recommendation,
          analysis: JSON.stringify({
            recommendation: analysis.recommendation,
            A: analysis.A,
            B: analysis.B,
            C: analysis.C,
            degenerate: analysis.degenerate ?? false,
            source: "ping",
          }),
        });
      }
    } catch {
      // Heartbeat is best-effort; listening continues.
    } finally {
      pingingRef.current = false;
    }
  };

  // Heartbeat: while ON, ping every random 1–3 seconds.
  useEffect(() => {
    clearPingTimer();
    if (!live) return;
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      pingTimerRef.current = window.setTimeout(() => {
        void (async () => {
          if (cancelled || !liveRef.current) return;
          if (!speakingRef.current) {
            await doPing();
          }
          schedule();
        })();
      }, randomPingDelayMs());
    };
    schedule();
    return () => {
      cancelled = true;
      clearPingTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const startListening = async (automatic: boolean) => {
    const engine = engineRef.current;
    if (!engine || busy || live) return;
    setBusy(true);
    if (!automatic) setError(null);
    try {
      await engine.start();
      setLive(true);
      if (!state.data?.active) {
        setSession.mutate({ peer, active: true });
      }
    } catch (e) {
      if (!automatic) {
        setError(
          e instanceof Error
            ? `The microphone could not be opened (${e.message}). Check microphone permission, then try again.`
            : "The microphone could not be opened. Check microphone permission, then try again.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const stopListening = async () => {
    if (busy) return;
    setBusy(true);
    try {
      clearPingTimer();
      await engineRef.current?.stop();
      setLive(false);
      setSession.mutate({ peer, active: false });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!state.data) return;
    if (!state.data.active) {
      autoTriedRef.current = false;
      return;
    }
    if (live || autoTriedRef.current || !engineRef.current) return;
    autoTriedRef.current = true;
    void startListening(true);
  }, [state.data, live]); // eslint-disable-line react-hooks/exhaustive-deps

  const onToggle = () => {
    if (busy) return;
    if (live) {
      void stopListening();
    } else {
      void startListening(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="flex flex-col items-center px-4">
        <button
          type="button"
          role="switch"
          aria-checked={live}
          aria-label="Ear on/off"
          disabled={busy}
          onClick={onToggle}
          className="relative rounded-full disabled:opacity-50"
          style={{
            width: "11rem",
            height: "6rem",
            backgroundColor: live ? "var(--accent)" : "var(--surface2)",
            border: "2px solid var(--border)",
            transition: "background-color 150ms ease",
          }}
        >
          <span
            aria-hidden="true"
            className="absolute top-1/2 flex -translate-y-1/2 items-center justify-center rounded-full bg-[var(--surface)] font-semibold shadow"
            style={{
              width: "5rem",
              height: "5rem",
              left: live ? "calc(100% - 5.5rem)" : "0.5rem",
              transition: "left 150ms ease",
              color: "var(--text)",
              fontSize: "1.125rem",
            }}
          >
            {live ? "ON" : "OFF"}
          </span>
        </button>
        {error && (
          <p
            role="alert"
            className="mt-4 w-full max-w-xs rounded-lg border border-[var(--danger)] bg-[var(--surface)] px-3 py-3 text-sm"
          >
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
