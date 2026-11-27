# Changelog

## 8.2.0 — 2026-11-27

**On-air format: a clean-slate break.** The wire format changed freely:
8.2 does not decode 8.0/8.1 bursts and 8.0/8.1 do not decode 8.2 bursts.
Backward compatibility was dropped on purpose — NDAP is being developed
for the first time and nothing deployed depends on the old format. The
mini-header's byte 2 is now a *wire revision* marker, `WIRE_REV = 0x82`:
a decoder that meets a CRC-valid header announcing another revision
raises a named error (`RevisionError`) instead of guessing at the
payload. Implementation revision is `ndap.__version__ == "8.2.0"`
(`IMPL_VERSION` in JS); SPEC.md is "version 8 (revision 8.2)".

### The headline fix — orthogonal detector windows

Modes A and B space their tones at exactly 1/T, which is orthogonal
only under a rectangular window. The 8.1 Tukey taper (τ = 0.25) broke
that orthogonality: the augmented detector's condition number was 32
(A) and 91 (B), amplifying noise by roughly 10 dB and 17 dB — the whole
of the 8.1 A/B noise floor. Rev 8.2 sets **τ = 0 (rectangular) for
Mode A, Mode B and sounding phase 1**; the rectangular detector's
condition number is 1.0. Mode C (cond 1.15 under its taper), the
mini-header and sounding phase 2 keep τ = 0.25.

### What else changed on the air

- Low-crest Schroeder-phase preamble and chirp-sign sounding.
- A one-symbol payload preamble; shortened Reed-Solomon blocks sized
  to the message; every section's exact stored length carried in the
  mini-header; RS(255,223) for Mode B; the tone mask now applies to
  every mode, A included.

### Receiver

- Correlation acquisition is the only finder — the 8.0 onset/sounding
  fallback is gone. The 8.1 envelope normalization and retry ladder
  are kept.
- Per-section timing re-alignment for Mode A, and a decode chain that
  survives a failed section and reports it by name.
- Kept from earlier revisions: the §19 Expression Layer and §11
  duplex, both re-verified. JS parity is kept (`js/src/ndap.js`,
  `IMPL_VERSION "8.2.0"`).
- Removed with the clean slate: the legacy 8.0 fixtures,
  `tests/test_rev81.py` and `js/test/rev81.mjs`. Added:
  `tests/test_rev82.py`, `js/test/rev82.mjs`, and
  `tests/noise_trials.py` (the harness behind the tables below).

### Measured — noise trials

`tests/noise_trials.py`, 4 trials per cell, byte-exact decode, 0.3 s
lead-in; 8.1 loaded from git `48c0756`, 8.2 from this tree. Default
payload: 80 B of incompressible random data (zlib cannot flatter it).

AWGN sweep, default payload:

| Mode | SNR (dB) | 8.1 | 8.2 |
|---|---|---|---|
| C | 30 → 3 | 4/4 at every step | 4/4 at every step |
| B | 30 | 0/4 | 4/4 |
| B | 24 | 0/4 | 4/4 |
| B | 18 | 0/4 | 4/4 |
| B | 12 | 0/4 | 4/4 |
| B | 6 | 0/4 | 4/4 |
| B | 3 | 0/4 | 0/4 |
| A | 30 | 0/4 | 4/4 |
| A | 24 | 0/4 | 4/4 |
| A | 18 | 0/4 | 4/4 |
| A | 12 | 0/4 | 2/4 |
| A | 6 | 0/4 | 0/4 |
| A | 3 | 0/4 | 0/4 |

Bandpass 250–4200 Hz: C 4/4 and B 4/4 under both revisions; A 4/4
under 8.2 (not applicable to 8.1 in this harness). 25 Hz gain
envelope: 4/4 in every mode under both revisions.

Second run with the 8.1 suite's own 75 B English text payload tells
the same story: 8.2 Mode B 4/4 at 30/24/18/12 dB and 2/4 at 6 dB;
Mode A 4/4 at 30/24/18 dB and 2/4 at 12 dB; Mode C 4/4 throughout;
8.1 again 0/4 in AWGN for A and B at every SNR.

Effective speed (whole burst, 3000 B payload; payload-section-only
rate in parentheses): A 1485 → **1531** B/s (2386 → 2537);
B 421 → **508** B/s (577 → 759); C 58 → **63** B/s (85 → 97).

**Read the 8.1 column with care.** Under this harness 8.1 fails AWGN
outright in modes A and B under *both* payloads — worse than the
figures published in the 8.1.0 entry, which were measured with the
older trial code. The harness changed with 8.2; these tables are a
same-harness, same-conditions comparison between the two revisions,
not a revision of the 8.1 record. The within-harness verdict is
unambiguous: at every AWGN operating point that matters, 8.2 decodes
where 8.1 does not, and Mode C — the fails-loudly fallback — is
unchanged.

### Verification

Python suite 51/51 passed. JS suite fully passed (conformance,
zlib-exactness, crosscheck, rev82 40/40). Conformance regeneration is
deterministic: identical tree hash across two runs.

## 8.1.0 — 2026-11-27

**On-air format: unchanged.** The wire `VERSION` byte stays 8. Every
rev 8.0 burst decodes under 8.1 (conformance vectors, shipped example,
and `tests/fixtures/legacy-8.0-*.wav` from the 8.0 encoder), and the 8.1
encoder reproduces 8.0 bursts sample-for-sample, so every 8.1 burst
decodes under an 8.0 receiver. Nothing needed version-gating, so no
old decoder can mis-decode an 8.1 burst. Implementation revision is
`ndap.__version__ == "8.1.0"` (`IMPL_VERSION` in JS); SPEC.md is
"version 8 (revision 8.1)".

### Lesson 1 — receiver robustness (from NDAP-8-P)

Acquisition ideas credited to **NDAP-8-P's receiver design** (a fork by
another author; its code is not in this repository, so this is a
from-description implementation against NDAP-8's own sounding rather
than a port): synchronise by normalized cross-correlation with an offset
retry ladder, divide out a slow gain envelope after sync, validate
strictly with bounded work, and gate on CRC.

- **Correlation acquisition is now the primary finder** in
  `decode_adaptive` / `decode_adaptive_report`: normalized
  cross-correlation against the known sounding (FFT), up to 6 peaks, each
  tried at a 13-step offset ladder (0, ±8, ±16, ±32, ±64, ±128, ±240
  samples) until a mini-header validates; at most 78 mini-header decodes.
  The 8.0 onset/sounding finder remains as the fallback
  (`_find_burst(method="legacy")`). Reports gain `start`,
  `acquisition` (`xcorr`/`legacy`/`given`) and `envelope_normalized`.
- **Slow-envelope normalization** (`_divide_envelope`): estimated from the
  burst's own active windows in ~5 ms sub-windows, smoothed ~15 ms, divided
  out before projection. It is a *retry* after the raw walk fails, never
  applied to a burst that decodes raw.
- **Strict validation, CRC gate, fail loudly — kept and tightened.**
  Mini-headers with segment total 0 or index ≥ total are now invalid. Every
  attempt is gated by the same CRC-16 / RS-Viterbi / CRC-32 checks;
  corruption tests assert a decode returns the exact payload or fails
  loudly, never wrong bytes.
- Ported to `js/src/ndap.js` (radix-2 FFT, same ladder, same normalizer);
  JS and Python agree on start, acquisition and normalization flag on the
  stressed vectors (`js/test/rev81.mjs`). The Ear's embedded copy
  (`ear/client/src/ndap.js`) was deliberately not touched; see
  "Ear" below.

**Measured before/after** (white Gaussian noise relative to burst power over
the full 24 kHz band; 4 trials per cell; 80-byte payload, 0.3 s lead-in;
legacy 8.0 module taken from git commit 5216b35; measured 2026-11-27):

| Mode | SNR (dB) | 8.0 decode | 8.1 decode |
|---|---|---|---|
| C | 30 | 4/4 | 4/4 |
| C | 24 | 4/4 | 4/4 |
| C | 18 | 4/4 | 4/4 |
| C | 12 | 4/4 | 4/4 |
| C | 6 | 4/4 | 4/4 |
| C | 3 | 0/4 | 4/4 |
| B | 30 | 2/4 | 1/4 |
| B | 24 | 0/4 | 0/4 |
| B | 18 | 0/4 | 0/4 |
| B | 12 | 0/4 | 0/4 |
| B | 6 | 0/4 | 0/4 |
| B | 3 | 0/4 | 0/4 |
| A | 30 | 2/4 | 4/4 |
| A | 24 | 0/4 | 0/4 |
| A | 18 | 0/4 | 0/4 |
| A | 12 | 0/4 | 0/4 |
| A | 6 | 0/4 | 0/4 |
| A | 3 | 0/4 | 0/4 |

What the numbers do and do not say, plainly:

- Acquisition is what changed. The headline claim for NDAP-8-P — that the
  current path "failed every" noise/bandpass trial — reproduces only
  partly here. Mode C decodes 4/4 under both versions from 30 dB down to
  6 dB; at 3 dB the 8.0 finder loses all four bursts while 8.1 decodes
  all four. Mode A at 30 dB improves from 2/4 to 4/4. Below those points
  Modes A and B fail under *both* versions: 8.1 finds the exact start
  there (checked), but the payload's own RS decode fails — a
  physical-layer floor correlation cannot lower.
- The 25 Hz, 0.60–1.00 envelope was an *acquisition* problem for 8.0 (mode A
  failed); with correlation acquisition it decodes raw. The envelope
  divider itself rescued one stress cell in the development sweep (mode B,
  10 Hz down to 0.3, 36 dB) and is otherwise a safety net; it cannot
  recover SNR a deep envelope removes, and does not track envelopes faster
  than ~25 Hz in the guarded modes.
- Bandpass 250–4200 Hz is handled when the sender masks to the passband.
  `analyze_channel` was not changed and mis-masks a bandpassed sounding
  (SPEC §17).

### Lesson 2 — Expression Layer (from the R2 experiments)

- SPEC §19: optional **Expression Layer**. Bookend phrases before/after the
  burst and gentle amplitude prosody are permitted; any frequency or time
  warp of the burst itself is prohibited (it destroys the differential-phase
  data: every depth from 0.3 % to 1.0 % failed in R2).
- `ndap.add_expression()` (+ `EXPR_PRE`, `EXPR_POST`, `EXPR_LIMITS`) and the
  JS mirror: bookends, prosody, enforced limits, **no warp parameter**.
  Expression-wrapped bursts decode byte-exact in 8.0 and 8.1, Python and JS.
- SPEC §20: the future **singing profile** via a common-mode-tracking
  decoder (average phase across all tones) recorded as roadmap — not code,
  not a format.

### Tests added

- `tests/test_rev81.py` (`python3 -m unittest discover -s tests -v`): 8.0
  fixtures and sample-identical encoder, conformance vectors, old decoder on
  new bursts (via `git show`, skipped if unavailable), acquisition
  before/after (AWGN, bandpass, envelope), envelope-divided decode, strict
  validation and corruption, Expression Layer round trips and limits.
- `js/test/rev81.mjs` (in `npm test`): Python↔JS expression parity (≤ 1 LSB),
  stressed-channel decodes, start/acquisition agreement, strict header.

### Ear

`ear/` was not modified. `ear/client/src/ndap.js` is a separate embedded
copy of the 8.0 JS codec. It stays correct and interoperable: its bursts
are 8.0 bursts, which the 8.1 Python and JS receivers decode (tested), and
the Ear decodes 8.1/expression-wrapped bursts with its 8.0 receiver
(tested for the Python/JS 8.0 decoders; the Ear's own acquisition simply
lacks the 8.1 robustness gains until its copy is refreshed from
`js/src/ndap.js`, which is a drop-in replacement apart from the Ear's
degenerate-input guards at `_degenerate_analysis`/`analyze_channel`).
