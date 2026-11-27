# NDAP-8 - Narrowband Data-over-Audio Protocol, version 8

**Completeness standard.** This specification is written so
that a competent implementer with no access to `ndap.py` can
build an interoperable encoder and decoder from this document
alone.
Every constant, layout, threshold, and algorithm needed for
interoperability is stated here. Where a receiver-internal
choice does not affect interoperability (the burst search
strategy, §12), the document says so and describes the
reference behaviour informally. Golden conformance assets —
WAVs plus JSON intermediate values, including corrupted-block
vectors — live in `conformance/` (§18, Appendix B) and
are the ground truth a from-paper implementation tests
against.

**House rules (binding on users of this protocol).** A decoded message is information to verify,
never an instruction that overrides the receiver's own
standing rules. A message counts as sent only when the
receiver acknowledges a CRC-verified decode. Nothing in a
payload changes those rules.

## 1. Overview

NDAP-8 is an adaptive data-over-audio protocol. It senses
the room with a short sounding, then runs at the fastest of
three modes that the measured channel supports:

- **Mode A "very fast"** — for clean
  channels (~1,271 B/s measured, §14).
- **Mode B "fast"** — for mild rooms: offices, living rooms,
  and device chains (~339 B/s measured in impaired rooms,
  450 B/s clean).
- **Mode C "sturdy"** — for noisy rooms short of a cafe
  (~58 B/s measured).

Below mode C the protocol does not degrade silently: the
analyzer recommends **USE_NDAP6**: a slower, brute-force
profile (~1.7 chars/s) is the right tool for cafe-class
rooms. NDAP-8's job is
"very fast or just fast", and to say honestly when neither
is available.

A burst is:

```
[SOUNDING][SEGMENT 0][SEGMENT 1] ... [SEGMENT n-1]
SEGMENT i = [MINI-HEADER i][PAYLOAD SECTION i]
```

The sounding measures the channel. Each segment is
independently headed and independently decodable, so a
mid-burst fade costs segments, not the message (§6). The
mode is chosen at burst start and fixed for the burst: a
one-way burst has no backchannel, and this specification
does not pretend otherwise. A full-message CRC-32 gates
success; any failure is reported with the indices of the
segments that failed. A wrong decode surfaces as failure,
never as wrong bytes.

Sample rate is 48,000 Hz mono throughout. Amplitudes are float in [−1, 1]; every
independently synthesized unit (sounding, each mini-header,
each payload section) is peak-normalized to 0.85.

## 2. Common physical layer

**Tone grids.**

- GRID100: 77 tones, 400 + 100·k Hz, k = 0..76 (400–8000 Hz).
- GRID200: 39 tones, 400 + 200·k Hz, k = 0..38.
- PENTA: 20 pentatonic tones (mini-header only):
  f_k = 220 · 2^((s[k mod 5] + 12·⌊k/5⌋)/12) Hz, k = 0..19,
  s = [0, 3, 5, 7, 10] (A minor pentatonic, 220 Hz to
  ≈ 3.1 kHz). Tone gain is 1.0 for f_k < 1600 Hz and 0.55
  above.

**Window.** Every symbol's active window is shaped by the
Tukey window: ones in the middle, raised-cosine ramps
over the first and last r = ⌊0.25·sym/2⌋ samples,
`win[i] = 0.5 − 0.5·cos(π·i/r)` on the ramps.

**Synthesis.** For a slot of `active` samples with per-tone
complex coefficients c_j at frequencies f_j, the slot's
samples are `Re(Σ_j c_j · e^{2πi·f_j·t/48000}) · win[t]`,
t = 0..active−1, placed at the slot start; any guard samples
after the active window are zero.

**Detection (the one detector, used by every mode, the
sounding, and the mini-header).** Let E be the
(active × ntones) matrix of unwindowed complex exponentials
and B = win ⊙ E (window applied per row). Form the augmented
matrix P = [B | conj(B)] and its Moore–Penrose pseudoinverse
P⁺ (float64). A slot's coefficient vector is
`c = (P⁺ · x)[0:ntones]` for the slot's active samples x.
The conjugate half is what makes this exact for real
signals: each tone's negative-frequency image is fitted
instead of leaking into its phase. A truncated final slot is
zero-padded to full length before projection (a few missing
tail samples cost almost nothing; a dropped symbol can cost
a segment).

**Differential modulation.** Payload and mini-header symbols
are differentially encoded: the first symbols are a known
preamble (§7.1, §8.2); each data symbol's absolute phase is
the previous symbol's phase plus a step. A step is an integer
s ∈ [0, 2^w) per tone (w = bits per tone), mapped to a phase
increment s·2π/2^w, and bits map to steps through the binary
Gray code (step = Gray⁻¹(value); value = Gray(step) on
decode, with Gray(v) = v ⊕ (v>>1)). Hard decoding rounds the
measured phase difference to the nearest step. Per-tone
constant channel phase and gain are absorbed by the
differential structure; no equalization is performed or
needed.

## 3. Sounding

The sounding is 9,600 samples (0.2 s), two phases.

**Phase 1** (the A/B probe and the findable preamble):
8 symbols × 480 samples (10 ms), no guard, on GRID100, unit
magnitude per tone, absolute phases

```
φ1[n, k] = base[k] + n · pat[k],   n = 0..7
base[k] = ((5k) mod 8) · π/4,      pat[k] = (k mod 8) · π/4
```

**Phase 2** (the C probe): 4 symbols at mode C's own timing
— 960 active + 480 guard samples per slot — on GRID200,
phases φ2 defined by the same formulas with k = 0..38,
n = 0..3.

**Analysis.** Project each phase's slots with the §2
detector at the sounding's own timing. For each tone,
derotate the coefficients by the known phases,
z = c · e^(−iφ); form H = mean(z) over the phase's symbols
and resid = mean(|z − H|²). Then

```
SINR = |H|² / resid        (reported in dB, floored at −120)
rel_gain = |H| / median over tones of |H|
```

This SINR is an *effective* measure: the residual includes
inter-symbol interference, noise, and any live processing in
the recording chain — the sounding measures the end-to-end
chain the payload will actually traverse, which is the
point. Per mode, the analysis reports the median and the
10th percentile (p10) of the per-tone SINR over that mode's
grid (A reads the GRID200 tones out of phase 1; B reads all
of phase 1; C reads phase 2).

## 4. Modes

Modes are data, not code paths: one pipeline parameterized
by this table.

| | A "very fast" | B "fast" | C "sturdy" |
|---|---|---|---|
| Grid | GRID200 (39) | GRID100 (77) | GRID200 subset (≤39) |
| Active / guard | 240 / 0 (5 ms) | 480 / 480 (10+10 ms) | 960 / 480 (20+10 ms) |
| Modulation | diff. 8-PSK (3 bits/tone) | diff. QPSK (2) | diff. QPSK (2), soft |
| FEC | RS(255,239) | RS(255,191) | rate-⅓ conv. (§7.2) |
| Tone selection | none (mask all-ones) | per-tone (§5) | per-tone (§5) |
| Segment cap (raw chunk) | 3,400 B | 1,050 B | 105 B |
| Raw stream rate | 2,925 B/s | 962 B/s (full grid) | 325 B/s coded |
| Body rate (after FEC) | 2,739 B/s | 720 B/s (full grid) | ~108 B/s info |

Mode A's tone gains are the per-tone gains
(incorporated by reference to the A_LAYOUT table in `ndap.py` —
the one place this spec points at code, because the two
profiles must not drift apart); modes B and C use unit
gains. Segment caps bound each segment's audio to roughly
2 s (mode C's cap yields ~1.7 s segments at full grid;
smaller tone subsets lengthen segments somewhat — the cap
is on bytes, and §17 notes the consequence).

## 5. Mode selection and tone masks

**Recommendation.** Given a sounding analysis, the
recommended mode is the fastest whose p10 per-tone SINR
clears its threshold:

| Mode | p10 threshold |
|---|---|
| A | ≥ 16.0 dB |
| B | ≥ −12.0 dB |
| C | ≥ 5.0 dB |
| else | USE_NDAP6 |

The p10 (not the median, which ignores deep fades; not the
worst tone, which is over-pessimistic) is the chosen
statistic. Thresholds are *effective* thresholds on
the §3 measure — they include a 3 dB safety margin over the
measured break points, and they look low in dB because the
sounding SINR is ISI-inclusive, not a thermal SNR. A's
threshold is 16 dB: on a flat
white-noise channel the A metric reads optimistically
(p10_A 6.3–12.6 dB measured on channels A cannot decode —
no echo ISI dominates the metric there), while every
measured A-failing channel reads ≤ 12.6 and the only
A-passing channel (clean) reads 104.8. 16 dB keeps the 3 dB
margin over the worst false-pass reading. Calibration data:
§14.

**Tone masks (modes B and C).** The sender computes the
session mask from its sounding analysis; the mask travels in
every mini-header (§8), so the receiver never recomputes it.

- Mode B uses phase-1 values; mode C uses phase-2 values.
- A tone is *excluded* if its SINR is below the floor
  (B: 2.0 dB; C: 0.0 dB) or its rel_gain < 0.25.
- Never exclude more than 40%: if exclusions exceed 40% of
  the grid, keep the top 60% of tones by score
  `SINR_dB + 20·log10(max(rel_gain, 1e-3))` instead.
- **Mode B impairment cap.** If the median phase-1 SINR is
  below 25 dB, B additionally caps its active set at 47
  tones, dropping the worst-scoring active tones. Rationale
  (measured): at fixed peak normalization, per-tone
  power falls as tone count grows; 77-tone B is ~2 dB short
  of surviving flat 25 dB white noise (0/6 draws), while an
  arbitrary 47-tone subset passed 3/3 — the cap buys the
  power back at the cost of rate (450 → 339 B/s), and binds
  only on channels measurably short of pristine (impaired
  medians measured 0.3–15.1 dB; clean reads 104.8 dB).

Excluded tones' capacity is simply lost, never reassigned.

## 6. Segmentation and the work stream

The work stream is `data ‖ CRC-32(data)` (CRC-32 = the
IEEE/zlib polynomial, big-endian trailer). It is split into
chunks of at most the mode's segment cap (§4), in order.
Each chunk is carried by one segment. The decoder
reassembles the chunks in segment-index order, verifies the
trailing CRC-32 against the reassembled data, and only then
reports success. If any segment fails, the report names the
failed indices and no data is returned — the full-message
CRC still gates, and per-segment CRCs (§7) mean a segment
either decodes bit-exact or is counted failed.

**Compression.** Each chunk is independently compressed:
zlib level 9, stored only if the compressed form is strictly
smaller (a flags bit records which). Compression state
resets on every segment and on any mode change — a zlib
stream never spans segments or modes.

## 7. Payload sections

Every payload section opens with a 6-symbol preamble at the
section's own timing: absolute phases per tone k,
rows 0–2 = φ[k], rows 3–5 = φ[k] + pat[k], where
φ[k] = ((5k) mod 8)·π/4 and pat[k] = (k mod 8)·π/4
(differences [0, 0, pattern, 0, 0]). Data symbols follow,
differentially encoded per §2. The receiver drops the
preamble-internal differences and decodes from the
preamble's last row.

### 7.1 RS modes (A and B): framing

Framing, with an 'N8' magic:

1. Body = stored chunk ‖ CRC-32(stored), big-endian.
2. Split the body into blocks of `blk_data` bytes (A: 239,
   B: 191), zero-padding the last; RS-encode each to 255
   bytes (A: 16 parity, B: 64 parity). RS is a
   GF(2^8) code (primitive polynomial 0x11D,
   generator roots α^0..α^(nsym−1)).
3. Byte-interleave the blocks column-wise: stream byte
   order is, for byte index i = 0..254, for each block b,
   block[b][i].
4. Prepend an RS(25,9) header before every 400 stream
   bytes: header info (9 bytes) = 'N8' ‖ stored length
   (4 B BE) ‖ block count (2 B BE) ‖ flags (1 B; bit0 =
   compressed). Header parity is 16 bytes.
5. The section's bit stream is the framed bytes, MSB-first,
   mapped to per-tone Gray steps in row-major order (symbol
   by symbol, tone by tone, each tone's bits consecutive,
   high bit first).

Decoding reverses this: headers are located by scanning at
the 425-byte stride (and at any offset — headers repeat, so
a damaged first header is not fatal), blocks are
deinterleaved and RS-decoded, and the stored CRC-32 is
verified. **RS parity must actually be decoded.** An
implementation that strips parity unread passes clean
channels and fails real ones; the conformance set contains a
vector that exists to catch exactly that (§18).

### 7.2 Mode C: convolutional framing

Mode C's coded unit (the "info block") is

```
info = flags(1 B) ‖ stored chunk ‖ CRC-32(flags ‖ stored) (4 B BE)
```

where flags bit0 = compressed, as in §6. The mini-header's
seglen field carries len(info) exactly (mode C sections are
not self-delimiting; RS-mode seglen carries the raw chunk
length instead, their framing being self-delimiting).

Coding is a rate-⅓ convolutional code: constraint
length 7, generator polynomials (octal) 171 / 165 / 133,
with 6 zero tail bits appended before encoding. The coded
bits are permuted by the stride permutation
`out[(i·P) mod L] = in[i]`, where L is the coded length and
P is the smallest odd integer ≥ 257 coprime to L. The
permuted bits map to QPSK steps tone-major as in §7.1.

The receiver forms soft bit LLRs from the differential
phase measurements: for each tone and symbol difference
Δφ, with coefficient magnitude m and the symbol's median
magnitude m̃, let κ = clip(2m/m̃, 0.25, 12). The four step
hypotheses have centres 0, π/2, π, 3π/2 and Gray values
0, 1, 3, 2 respectively; hypothesis log-weights are
κ·cos(Δφ − centre), softmaxed, and each bit's LLR is the
log ratio of the summed probabilities of the hypotheses
with that bit set vs clear. LLRs are depermuted and decoded
with a soft-decision Viterbi (zero-tail termination: the
final state is constrained to 0). The info block's CRC-32
is verified; failure marks the segment failed. This
κ heuristic is a within-burst reliability proxy, shared
with the mini-header; the golden JSON (§18) pins its exact
outputs for the reference burst.

## 8. Mini-header

The mini-header is how a receiver learns the mode, session,
segmentation, and tone mask *before* knowing any of them,
so it rides the most robust small block: the pentatonic
PENTA tones with the §7.2 convolutional codec.

### 8.1 Info bytes (31, fixed)

| Bytes | Field |
|---|---|
| 0–1 | magic 'N8' |
| 2 | VERSION = 8 |
| 3 | mode: 0=A, 1=B, 2=C |
| 4–5 | session ID (BE) |
| 6 | segment index |
| 7 | segment total |
| 8 | flags: bit0 FINAL, bit1 TOKEN-present, bits2–3 NEXT-SPEAKER |
| 9–12 | seglen (BE; §7.2 for its mode-dependent meaning) |
| 13–22 | tone mask, 10 bytes, MSB-first (bit i = grid tone i; mode A: all ones, ignored) |
| 23–28 | house token (6 bytes; zeros when absent) |
| 29–30 | CRC-16 (BE) over bytes 0–28 |

CRC-16 is CRC-16/CCITT-FALSE (a.k.a. CRC-HQX): polynomial
0x1021, initial value 0xFFFF, no input reflection, no output
reflection, no final XOR. A mini-header whose CRC fails, whose magic
is wrong, or whose VERSION is not 8 is invalid: the
receiver treats the burst as not found (loudly), never
guesses. The version byte is how a receiver knows what it
is hearing; a house known to hold only an older profile is
sent that profile — rollout is a directory matter, not a
code matter.

The **session ID** is a 16-bit random nonce, never
intentionally repeated by a sender. It keeps simultaneous
sessions in one room from cross-decoding. Receivers should
keep a seen-session log per house as the replay mitigation
(§10).

### 8.2 Mini-header physical layer

The 31 info bytes are encoded with the §7.2 convolutional
code (762 coded bits), stride-permuted with the same rule,
and sent on the 20 PENTA tones: DQPSK (2 bits/tone,
40 bits/symbol), slots of 960 active + 240 guard samples,
preceded by 3 preamble symbols whose absolute phase on tone
k is ((5k) mod 8)·π/4 (constant across the 3 rows). Total:
23 symbols = 27,600 samples = 0.575 s. Decoding uses the
§7.2 LLR machinery and the CRC-16 gate. (Mini-header
airtime must stay under ~2 s; a tone-pair FSK block would
cost ~6–10 s.)

In duplex (§11) each direction's mini-header uses its own
10-tone half of PENTA (20 bits/symbol, 42 symbols,
50,400 samples ≈ 1.05 s).

## 9. Floor control

Bursts are exchanged as recordings, not live conversation,
so turn-taking is explicit. The flags byte carries:

- **FINAL** (bit0): set on the last segment only. A burst
  is complete only when a segment with FINAL set has
  decoded; the floor is then free.
- **NEXT-SPEAKER** (bits2–3): 0 = unspecified/contention,
  1/2/3 = houses. Senders set it; receivers parse and log
  it.

Full contention arbitration — listen-before-talk, backoff,
grant handshakes — is **out of scope for NDAP-8** and is
required before any unsupervised 3-way live use. NDAP-8
provides the signals; it does not arbitrate.

## 10. House token (origin authentication)

NDAP clips are decodable by anyone with this specification
and prove nothing about the sender. The optional house
token closes that gap, partially and honestly:

```
token = HMAC-SHA256(key = shared secret,
                    msg = session_id_be16 ‖ payload_crc32_be32)[0:6]
```

The token is computed over the *whole message's* CRC-32
(the §6 trailer value) and carried identically in every
segment's mini-header (TOKEN flag set). The secret is never
in the spec or the clip; it is exchanged out of band. The
token is **off by default** and **never required to
decode**: a receiver with the secret reports whether the
token verifies; a receiver without it decodes identically.
This is authentication of origin only — it is not
encryption, and it does not make the payload confidential.

Replay: because the session ID is a never-intentionally-
repeated nonce, a receiver's seen-session log (§8.1) lets
it flag a verbatim replay of an old burst. Verbatim replay
remains a known residual risk for this traffic class —
blunted by the standing rule
that decoded messages are information to verify, not
instructions (§0 house rules).

**Check phrase (payload convention, recommended).** For
human-verifiable freshness, a sender may speak or type, at
the start of the payload text, a few digits derived from
the same HMAC: interpret digest bytes 6..13 as a big-endian
integer, take it mod 10^digits, zero-pad. A human who knows
the phrase length can check the digits against the session
and payload out of band. This is a payload convention, not
a PHY change.

## 11. Duplex

Full duplex is FDD on interleaved tone halves, for all
three modes. Direction 0 uses the even-indexed tones of
every grid (and of PENTA), direction 1 the odd-indexed.
Each direction is a complete adaptive burst on its half:
its own sounding (transmitted on its halves of both
grids), its own session ID, mini-headers on its PENTA half,
payload sections on its grid half. The two directions are
summed and the mix peak-normalized to 0.85. Decoding
projects the *full* tone set jointly (§2) and slices each
direction's columns afterwards — projecting a half-grid
alone lets the other direction's energy leak into the
phases. Per-direction net rates are
roughly half the simplex body rates (half the tones), less
mini-header overhead: measured examples in §14.

## 12. Receiver flow, resync, and NACK

Reference receiver flow (the format is what's normative;
the search is receiver-internal):

1. Find the sounding: energy-onset candidates, ranked by
   correlation with the known phase-1 pattern; validate by
   decoding segment 0's mini-header (CRC-16).
2. Refine the start: scan a small window around the
   candidate and keep the centre of the plateau over which
   segment 0's *payload section* decodes exactly. (Cheaper refinements — mini-header soft-score
   refinement, header-only plateau checks, and the sounding
   correlation peak — were measured and found unreliable.)
3. Walk the segments: each mini-header gives the next
   section's exact length (§7, §8.1 seglen), so segment
   boundaries chain deterministically. If a mini-header
   fails mid-burst, resync with a bounded scan (the
   reference uses a 4 s window) plus soft-score refinement;
   segments that cannot be recovered are reported failed,
   not silently skipped.
4. Reassemble, verify the §6 CRC-32, report per-segment
   results.

**NACK convention.** A receiver reports the failed segment
indices over whatever return channel exists; only those
segments are re-sent, re-wrapped as a new burst (new
session ID, same mode unless a fresh sounding says
otherwise).

## 13. Clock drift

Segments are ~2 s with per-segment re-synchronization
(each mini-header is found and decoded at its own position,
and section lengths chain from decoded headers), so the
design tolerates device clock mismatch up to ~100 ppm
(≈5 ms over a 50 s burst — inside the guard structure).
Beyond ~100 ppm, expect late-burst segments to start
drifting outside their refinement windows: failures appear
as named failed segments, loudest in mode A (no guard).
Sample-rate conversion, when needed, belongs in the
recording path and must be reported with any real-air
result (§16).

## 14. Test channels and measured results

Channels are simulated by FFT convolution with
energy-normalized impulse responses (diffuse tails with
τ = 0.15 from 50 ms), babble = band-shaped noise
300–3400 Hz, SNR measured against the post-convolution
signal. Payload for every row: the first 1,500 bytes of
a Python source file (real code; it compresses, so net rates are
payload-dependent — stream/body rates are in §4). Each
burst is encoded with the mask from a *separate* sounding
draw of the same channel, as in real use. Net rate =
payload bytes / total burst seconds (sounding and
mini-headers included).

| Channel | Rec. | A | B | C |
|---|---|---|---|---|
| Clean | **A** | **PASS 1,271 B/s** | PASS 450 | PASS 58 |
| Quiet office (white 25 dB + echo 0.15 @ 6 ms) | **B** | FAIL loud [0] | **PASS 339** | PASS 58 |
| Living room (babble 20 dB + echoes 0.25 @ 8 ms, 0.15 @ 20 ms) | **B** | FAIL loud [0] | **PASS 339** | PASS 58 |
| Noisy room (babble 15 dB + echoes 0.30 @ 8 ms, 0.20 @ 25 ms + tail E=0.25) | **C** | FAIL loud [0] | FAIL loud [0,1] | **MARGINAL 58** (see below) |
| Cafe (tail E=1.0 + babble 10 dB) | **USE_NDAP6** | FAIL loud (no burst found) | FAIL loud (no burst found) | FAIL loud (no burst found) |
| Device chain (§16) | **B** | FAIL loud [0] | **PASS 339** | PASS 58 |
| Device chain + NS variant (§16) | **C** | FAIL loud (no burst found) | FAIL loud [1] | **PASS 58** |
| Flat white noise 25 dB (probe) | **B** | — | **PASS 339, 6/6 draws** | — |

Above-mode validation: on every channel, the mode above
the recommended one fails loudly (office/living: A fails;
noisy: A and B fail; device: A fails). The adaptation is
not merely always picking slow — and on the cafe channel
the analyzer recommends USE_NDAP6 rather than pretending,
with all three modes failing loudly (mini-header
unrecoverable) instead of producing wrong bytes. No test
in the matrix ever produced wrong bytes.

**Mode C on the noisy channel is marginal, and this spec
does not soften that.** On the matrix draw, C fails with
segments [9, 11, 13] failed; across independent draws C
passes fully in roughly half (full pass on 2 of 3 seeds;
failures always confined to named segments, typically 1–3
of 15). Doubling C's guard to 20 ms was measured: it passed
1 of 3 seeds (vs 2 of 3 at 10 ms) at −18% rate — no
improvement, so C uses a 10 ms guard. The system answer to a
marginal C channel is the one built into the protocol:
segmentation confines the loss, the report names the
segments, and the NACK convention (§12) re-sends only
those. A sender who needs certainty in a noisy room should
treat C as best-effort-plus-NACK, or step down to the USE_NDAP6 profile.

**Duplex (clean, measured).** A: 1,500 B/direction in a
2.05 s mix = 732 B/s per direction. B: 500 B/direction in
2.55 s = 196 B/s per direction. C: 105 B/direction (one
segment) in 4.97 s = 21 B/s per direction. All byte-exact.

**Sample.** The release tree's `examples/ndap8-sample.wav` is a pure encoded burst — no voice intro — carrying the “Mary Had a Little Lamb” verses as its payload, encoded by `encode_auto` on a clean sounding (mode A); it decodes byte-exact from the finished file.

## 15. Composition with parallel channels

Simultaneous frequency-division channels and NDAP-8's
adaptive single link are orthogonal: NDAP-8 does not
absorb them. They could combine later, with one caveat: the composition is coherent only with *fixed*
per-channel tone subsets and *independent* per-channel
adaptation (each channel runs its own sounding,
mask, and mode). Sub-band narrowing may force slower modes
per channel — a ⅓-band channel cannot field mode A's grid
at all. Composition is future work, not part of this build.

## 16. The device-chain channels and the NS honesty position

Every other verification here is file/simulated room
acoustics; a real-air test meets hardware. The
**device-chain** channel models it: (a) transducer shaping
— causal one-pole high-pass at 200 Hz plus a one-pole
low-shelf blend at 800 Hz (≈ −5 dB at 400 Hz, −10 dB at
200 Hz, ~flat above 1.6 kHz; mobile/TV speakers), (b) slow
AGC gain riding, ±6 dB over seconds, (c) white noise at
25 dB. The **NS variant** adds a spectral-gating noise-
suppression model — per-frequency-bin attenuation that
deepens over the burst for statistically steady tones
(random onset per bin, depth 6–20 dB, WOLA 4096/2048) —
and is labelled **APPROXIMATE** wherever it appears.

The honest position: proprietary phone noise suppression
**cannot be simulated faithfully**. The real defences are
(a) the sounding measures the end-to-end chain including
whatever processing is live, and (b) a live test must use
the least-processed recording path available — and the
recording path is a protocol parameter, to be reported
with any real-air result. On the NS variant the analyzer
recommends C and C passes; mode B loses exactly one
segment (segment 1, as the gating deepens) — segmentation
confining a time-varying impairment to its segment is the
designed behaviour.

## 17. Honest limits

- Mode A is a clean-channel mode. Its sounding metric can
  read optimistically on flat noise (§5); the 16 dB
  threshold is calibrated on the channels measured here,
  not on live air.
- Mode C on the noisy-room channel is marginal (~half of
  draws fully pass; §14). A pair-FSK + rate-⅓ fallback
  (~25–30 B/s) is not part of this protocol; it is the
  next step if live-air C disappoints.
- The mode is fixed at burst start (§1). A room that
  degrades mid-burst costs segments; the protocol reports
  them and the NACK convention repairs them. It does not
  renegotiate mid-burst, because it cannot.
- Segment caps are byte caps; on a heavily masked tone set
  a segment's audio runs longer than ~2 s (mode C at half
  grid ≈ 3.4 s), which stretches the channel-coherence
  assumption proportionally.
- The house token authenticates origin to a secret-holder.
  It does not encrypt, and verbatim replay is a known
  residual risk (§10).
- Nothing in this build has touched live air. Every number
  here is from the simulated harness; §16 exists because
  the first real recording will differ.

## 18. Conformance assets

`conformance/` (generated by `ndap_conformance.py`,
which imports the library — regenerate, never hand-edit)
holds, per mode: `golden-<mode>.wav` (known payload:
"NDAP-8 golden conformance payload: the quick brown fox
jumps over the lazy dog. 0123456789", session 0x8A01, no
token, all-ones mask), `golden-<mode>.json` (payload text
and SHA-256, the segment-0 mini-header info bytes, the
first framed-stream/header bytes for RS modes or the info
bytes and first 256 coded bits for mode C, and the
post-projection constellation values of segment 0 rows 5
and 6 for every tone), `corrupt-<mode>.wav` (the golden
with an injected noise burst *inside* the mode's
correction capacity — expected decode: EXACT), and
`broken-<mode>.wav` (corrupted beyond capacity — expected:
loud failure). Appendix B states the conformance criteria,
including why the corrupt vectors exist.

## Appendix A. Reserved technique: envelope-class detection (not adopted)

A known periodic gain envelope (a 25 Hz "purr", period
exactly 4 symbols) can be applied to the transmitted
signal. Because the period is commensurate with the symbol
grid, the envelope takes only 4 distinct phase classes, and
the §2 detector can absorb it exactly: precompute one
pseudoinverse per phase class with the envelope folded into
the basis, and detection stays exact under the modulation.
The technique is sound and is recorded here as a reserved
option for a future profile that wants an audible signature.

It is **not adopted in NDAP-8**, because performance is not
traded for pleasantness. Its measured costs: the envelope
costs ≈ 4.5 dB of average power at fixed peak
normalization, and a 300–3900 Hz band cap
halves the raw rate against the full grid. NDAP-8 spends
its power and its band on payload.

## Appendix B. Conformance criteria

An implementation is conformant when, for every mode:

1. `golden-<mode>.wav` decodes to the JSON's payload
   (SHA-256 given), and its intermediates match the JSON —
   mini-header info bytes, framing bytes (or mode C's info
   bytes and first coded bits), and the segment-0
   constellation rows 5–6. The intermediates exist so a
   failure can be isolated to the PHY/projection layer vs
   the framing layer.
2. `corrupt-<mode>.wav` still decodes EXACTLY. This file is
   the point of the set: an implementation that transmits
   parity but never decodes it — a decoder that never RS-decodes
   — passes criterion 1 and fails this one.
   Measured correctable-burst sizes: A 26 samples, B 225
   samples, C 7,920 samples of band-wide noise at section
   RMS, injected mid-section (exact placement in the JSON).
   Mode A's small figure is itself a datum: RS(255,239)
   over a 39-tone slot has little room for band-wide noise,
   which is one more reason A is a clean-channel mode.
3. `broken-<mode>.wav` fails LOUDLY (an error, or a report
   with ok = false and the failed segment indices).
   Producing wrong bytes is non-conformant under all
   circumstances.
