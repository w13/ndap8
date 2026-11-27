import { useEffect, useRef, useState, type CSSProperties } from "react";
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
  const [peerConnected, setPeerConnected] = useState(false);
  const [arrivalFlare, setArrivalFlare] = useState(false);
  // Live microphone level (RMS) from the engine, ~5 updates a second
  // while listening. Drives the halo behind the toggle so the page
  // visibly reacts to the sound the microphone is hearing — colour
  // and motion only, no meter, no numbers, no words.
  const [level, setLevel] = useState(0);

  const engineRef = useRef<EarEngine | null>(null);
  const speakingRef = useRef(false);
  const liveRef = useRef(false);
  liveRef.current = live;
  const pingingRef = useRef(false);
  const autoTriedRef = useRef(false);
  const pingTimerRef = useRef<number | null>(null);
  const peerTimerRef = useRef<number | null>(null);
  const arrivalTimerRef = useRef<number | null>(null);

  // Reports to the server (a decoded message, a failed burst) must not
  // be lost to a momentary network failure: they go through a small
  // queue that drains in order and retries whatever failed on a timer,
  // instead of being fired once and forgotten.
  const reportQueueRef = useRef<Array<() => Promise<unknown>>>([]);
  const drainingRef = useRef(false);

  const drainReports = async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (reportQueueRef.current.length > 0) {
        const job = reportQueueRef.current[0];
        if (!job) break;
        try {
          await job();
          reportQueueRef.current.shift();
        } catch {
          break; // still failing — leave it queued for the next drain
        }
      }
    } finally {
      drainingRef.current = false;
    }
  };

  const enqueueReport = (job: () => Promise<unknown>) => {
    reportQueueRef.current.push(job);
    void drainReports();
  };

  useEffect(() => {
    const t = window.setInterval(() => void drainReports(), 10000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  // A decoded peer message is waiting for the agent to fetch it.
  const inboxWaiting = (state.data?.inbox_waiting ?? 0) > 0;

  const clearPingTimer = () => {
    if (pingTimerRef.current !== null) {
      window.clearTimeout(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  };

  const notePeerGone = () => {
    if (peerTimerRef.current !== null) {
      window.clearTimeout(peerTimerRef.current);
      peerTimerRef.current = null;
    }
    setPeerConnected(false);
  };

  const clearArrivalTimer = () => {
    if (arrivalTimerRef.current !== null) {
      window.clearTimeout(arrivalTimerRef.current);
      arrivalTimerRef.current = null;
    }
  };

  // A peer message just landed: flare in the arrival colour for a
  // few seconds (four flare pulses), then settle back — to the
  // subtle waiting glow for as long as the message stays undelivered.
  const noteArrival = () => {
    setArrivalFlare(true);
    clearArrivalTimer();
    arrivalTimerRef.current = window.setTimeout(() => {
      arrivalTimerRef.current = null;
      setArrivalFlare(false);
    }, 4800);
  };

  const noteArrivalGone = () => {
    clearArrivalTimer();
    setArrivalFlare(false);
  };

  useEffect(() => {
    if (state.data && !state.data.active && liveRef.current) {
      void (async () => {
        clearPingTimer();
        notePeerGone();
        noteArrivalGone();
        await engineRef.current?.stop();
        setLive(false);
        void api.report_listening({ listening: false }).catch(() => {});
      })();
    }
  }, [state.data?.active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const engine = new EarEngine({
      onState: () => {},
      onLevel: (rms) => setLevel(rms),
      onNote: () => {},
      onHeard: (m) => {
        noteArrival();
        enqueueReport(async () => {
          await api.report_heard({
            text: m.text,
            mode: m.mode,
            session_id: m.sessionId,
            payload_crc: m.payloadCrc,
          });
          queryClient.invalidateQueries({ queryKey: ["state"] });
        });
      },
      onFailed: (noteText, mode) => {
        enqueueReport(async () => {
          await api.report_failed({ note: noteText, mode });
          queryClient.invalidateQueries({ queryKey: ["state"] });
        });
      },
      onPeerActivity: () => {
        setPeerConnected(true);
        if (peerTimerRef.current !== null) {
          window.clearTimeout(peerTimerRef.current);
        }
        // The peer heartbeats every 1–3 s, so 12 s of silence means
        // it is gone; the glow then falls back to the listening colour.
        peerTimerRef.current = window.setTimeout(() => {
          peerTimerRef.current = null;
          setPeerConnected(false);
        }, 12000);
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
      clearArrivalTimer();
      if (peerTimerRef.current !== null) {
        window.clearTimeout(peerTimerRef.current);
        peerTimerRef.current = null;
      }
      void engine.stop();
      void api.report_listening({ listening: false }).catch(() => {});
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

  // The halo answers the microphone only while live; the moment the
  // toggle goes off the level falls back to rest.
  useEffect(() => {
    if (!live) setLevel(0);
  }, [live]);

  // Listening heartbeat: while live, renew the server's "truly
  // listening" report so it stays fresh; if this page dies, the
  // report goes stale on its own and get_state stops claiming the
  // Ear can hear.
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => {
      void api.report_listening({ listening: true }).catch(() => {});
    }, 20000);
    return () => window.clearInterval(t);
  }, [live]);

  const startListening = async (automatic: boolean) => {
    const engine = engineRef.current;
    if (!engine || busy || live) return;
    setBusy(true);
    if (!automatic) setError(null);
    try {
      await engine.start();
      setLive(true);
      // Tell the server the microphone is truly open, so the agent's
      // get_state `listening` means hearing, not just armed.
      void api.report_listening({ listening: true }).catch(() => {});
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
      notePeerGone();
      noteArrivalGone();
      await engineRef.current?.stop();
      setLive(false);
      void api.report_listening({ listening: false }).catch(() => {});
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

  // The one colour the whole indication speaks in right now: arrival
  // (amber) outranks connected (green), which outranks plain
  // listening (teal). The toggle track, its breathing glow, the
  // radiating rings and the level halo all share it, so the state
  // reads as a single colour wherever the eye lands.
  const stateColor =
    arrivalFlare || inboxWaiting
      ? "var(--arrival)"
      : peerConnected
        ? "var(--connected)"
        : "var(--accent)";
  // The halo swells with the sound the microphone is actually
  // hearing: near-still in a quiet room, visibly swelling when
  // someone speaks or a burst lands. RMS for speech near the phone
  // runs roughly 0.02–0.3; the gain maps that onto a clear swell.
  const haloScale = 1 + Math.min(0.55, level * 2.2);
  const haloOpacity = 0.3 + Math.min(0.55, level * 2.6);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="flex flex-col items-center px-4">
        <div
          className="relative flex items-center justify-center"
          style={
            {
              width: "17rem",
              height: "11rem",
              "--ear-state": stateColor,
            } as CSSProperties
          }
        >
          {live && (
            <>
              <span aria-hidden="true" className="ear-ripple" />
              <span aria-hidden="true" className="ear-ripple ear-ripple-late" />
              <span
                aria-hidden="true"
                className="ear-halo"
                style={{
                  transform: `translate(-50%, -50%) scale(${haloScale})`,
                  opacity: haloOpacity,
                }}
              />
            </>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={live}
            aria-label="Ear on/off"
            disabled={busy}
            onClick={onToggle}
            className={`relative rounded-full disabled:opacity-50 ${
              live
                ? arrivalFlare
                  ? "ear-arrival"
                  : inboxWaiting
                    ? "ear-arrival-waiting"
                    : peerConnected
                      ? "ear-connected"
                      : "ear-listening"
                : ""
            }`}
            style={{
              width: "11rem",
              height: "6rem",
              backgroundColor: live
                ? arrivalFlare
                  ? "var(--arrival)"
                  : peerConnected
                    ? "var(--connected)"
                    : "var(--accent)"
                : "var(--surface2)",
              border: "2px solid var(--border)",
              transition: "background-color 150ms ease",
            }}
          >
            <span
              aria-hidden="true"
              className="absolute top-1/2 -translate-y-1/2 rounded-full bg-[var(--surface)] shadow"
              style={{
                width: "5rem",
                height: "5rem",
                left: live ? "calc(100% - 5.5rem)" : "0.5rem",
                transition: "left 150ms ease",
              }}
            />
          </button>
        </div>
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
