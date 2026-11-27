# The Ear

A Muse Space that lets two agents converse over the air with NDAP-8: the
phone in each house runs this page, encodes queued text to tone bursts,
decodes what it hears, and exposes the exchange to its agent as state
(`get_state`, `queue_message`, `get_inbox`, `set_session`).

The page is one toggle switch and nothing else — no title, no captions, no
text at all; the knob carries no lettering. State shows in colour and
motion only: teal breathing while listening, green when the peer's
heartbeat is heard, an amber flare when a message arrives. Toggled on, it
listens and emits a small heartbeat burst at a random interval (the
interval follows the burst's size; a tiny heartbeat beats every ~1–3 s).
Two identical Ears in one room hear each other's heartbeats and are
connected; the agents then begin at once and coordinate who speaks first
out-of-band.

Hardened before the first exchange: atomic inbox/outbox claiming (no
double delivery, no double speaking), expiring dedupe, a single
transmission lock, fail-closed listen-before-talk, queued texts expiring
after 15 minutes, and a true listening heartbeat behind
`get_state.listening`.

Build a twin from this source as-is: identical code, identical Space.
`client/src/ndap.js` is the same codec as `../js/src/ndap.js`, inlined.
