# NDAP-8 - Narrowband Data-over-Audio Protocol, version 8 (revision 8.2)

**Revision 8.2 (2026-11-27) — a clean-slate break.** The wire format
changed freely: 8.2 does not decode 8.0/8.1 bursts and 8.0/8.1 do not
decode 8.2 bursts. Backward compatibility was dropped on purpose
(NDAP is being developed for the first time; nothing deployed
depends on 8.0/8.1). The mini-header's byte 2 is now a *wire
revision* marker, `0x82` (§8.1): a decoder that meets a CRC-valid
header announcing another revision raises a named error
(`RevisionError`) instead of guessing. What changed on the air:
rectangular (orthogonal) detector windows for A, B and sounding
phase 1; low-crest Schroeder-phase preamble and chirp-sign sounding;
a one-symbol payload preamble; shortened RS blocks sized to the
message; every section's exact stored length in the mini-header; RS(255,223) for B;
the tone mask on every mode (A included). What changed in the
receiver: correlation acquisition only (the 8.0 finder is gone),
per-section timing re-alignment for Mode A, and a chain that survives a failed
section. Measurements in §14.2; the story in `CHANGELOG.md`.
**Duplex is carried over and verified (§11).**

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

**Window.** A layout's symbol window is a Tukey window with
taper fraction τ: ones in the middle, raised-cosine ramps over
the first and last r = ⌊τ·sym/2⌋ samples,
`win[i] = 0.5 − 0.5·cos(π·i/r)` on the ramps. Rev 8.2 sets
**τ = 0 (rectangular) for Mode A, Mode B and sounding phase 1**,
and keeps τ = 0.25 for Mode C, the mini-header and sounding
phase 2. Reason (measured): tones spaced at exactly 1/T are
orthogonal only under a rectangular window; with the 8.1 taper
the augmented detector of §2 had condition number 32 (A) and 91
(B), which amplifies noise by about 10 and 17 dB — the whole of
the 8.1 A/B noise floor. The rectangular detector's condition
number is 1.0. C's 4×-oversampled layout (cond 1.15) and the
mini-header keep their taper.

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
8 symbols × 480 samples (10 ms), no guard, rectangular window
(§2), on GRID100, unit magnitude per tone. Every deterministic
symbol of the format uses **Schroeder phases** — a flat-spectrum
multisine whose crest factor is low (a chirp that sweeps the
band once per symbol): for N tones, `S_N[k] = π·k²/N`, k = 0..N−1.
Symbol n of phase 1 has absolute phases

```
φ1[n, k] = s1[n] · π·k²/77,    s1 = (+1, +1, +1, −1, −1, +1, −1, +1)
```

— an up- or down-chirp per symbol (the "dual-chirp" idea),
in a non-periodic order, so the sounding's autocorrelation has one
sharp peak with sidelobes ≲ ⅐ of it (no ambiguity at multiples
of 10 ms). Why Schroeder: the burst is peak-normalized to 0.85, so
a high-crest deterministic symbol sets the scale and pins every
data symbol below the speaker's headroom. In 8.1 the sounding and
preamble crest factors were 19–25 dB against 12–15 dB for data; the
8.2 sounding is ≈ 8 dB, and the data sections run 6–10 dB louder
at the same peak.

**Phase 2** (the C probe): 4 symbols at mode C's own timing
— 960 active + 480 guard samples per slot, Tukey τ = 0.25 — on
GRID200, `φ2[n, k] = s2[n] · π·k²/39`, k = 0..38,
`s2 = (+1, +1, −1, +1)`.

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
| Window taper τ | 0 (rectangular) | 0 (rectangular) | 0.25 |
| Modulation | diff. 8-PSK (3 bits/tone) | diff. QPSK (2) | diff. QPSK (2), soft |
| FEC | shortened RS, 16 parity (≤ RS(255,239)) | shortened RS, 32 parity (≤ RS(255,223)) | rate-⅓ conv. (§7.2) |
| Tone selection | optional mask (§5) | per-tone (§5) | per-tone (§5) |
| Segment cap (raw chunk) | 3,400 B | 1,200 B | 105 B |
| Raw stream rate | 2,925 B/s | 962 B/s (full grid) | 325 B/s coded |
| Body rate (after FEC, before repeated headers) | 2,742 B/s | 842 B/s (full grid) | ~108 B/s info |
| Timing plateau (decodes within ±) | ~3 samples | ~70 samples | ≥ 96 samples |

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
| A | ≥ 22.0 dB |
| B | ≥ 18.0 dB |
| C | ≥ 5.0 dB |
| else | USE_NDAP6 |

The p10 (not the median, which ignores deep fades; not the
worst tone, which is over-pessimistic) is the chosen
statistic. Thresholds are *effective* thresholds on
the §3 measure: break point plus a 3 dB safety margin.

**Rev 8.2 calibration, and its limit.** The 8.2 sounding reads a
tone's own SINR; in flat white noise the p10 reads about
(whole-burst SNR + 8) dB. The measured whole-burst break points
(§14.2) are ≈ 11 dB SNR for A and ≈ 7.5 dB for B, i.e. readings of
≈ 19 and ≈ 15.5 dB; with the 3 dB margin: **A = 22, B = 18**. C is
carried over from 8.1 unchanged (5 dB): it is the last resort
before USE_NDAP6 and its white-noise break (≈ −2 dB SNR, reading
≈ 8) is not margined by 5 — it is lenient. **All of this is
calibrated on white noise.** The 8.1 thresholds (A 16, B −12, C 5)
were set on simulated room channels (echoes, babble, device
chain) that are not in the tree; those channels were not re-run
for 8.2, so the selector's behaviour in echoey rooms is open work
(§14.1, §17). The change of direction is the safe one: B is no
longer recommended on noise it measurably fails (8.1's −12 dB
threshold recommended B at any reading above −12).

**Tone masks.** The sender computes the
session mask from its sounding analysis (modes B and C); the
mask travels in every mini-header (§8), so the receiver never
recomputes it. Rev 8.2 carries the mask for **every** mode: Mode
A's analysis-driven mask is still all-ones, but a sender that
knows its channel (a 250–4,200 Hz bandpass, say) may mask A
too (reference: `encode_adaptive(..., tone_mask=...)`).

- Mode B uses phase-1 values; mode C uses phase-2 values.
- A tone is *excluded* if its SINR is below the floor
  (B: 2.0 dB; C: 0.0 dB) or its rel_gain < 0.25.
- Never exclude more than 40%: if exclusions exceed 40% of
  the grid, keep the top 60% of tones by score
  `SINR_dB + 20·log10(max(rel_gain, 1e-3))` instead.
- *(Rev 8.1's "Mode B impairment cap" — B caps at 47 tones when
  the median phase-1 SINR is under 25 dB — is removed. It
  compensated for the ill-conditioned 8.1 detector; 77-tone B now
  decodes flat 18 dB white noise 4/4, §14.2.)*

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

Every payload section opens with a **single reference symbol**
at the section's own timing: absolute phase on tone k of
`π·k²/N` (Schroeder, §3; N = the session's active tone count).
Data symbols follow, differentially encoded per §2: the first
data symbol's step is measured against the reference symbol. (8.1
spent six symbols on a pattern preamble; differential decoding
needs one reference, and a low-crest one keeps the data scale up.)
A section's length is known exactly from the mini-header (`seglen`,
§8.1): the receiver projects exactly `1 + ⌈bits / bits-per-symbol⌉`
slots.

### 7.1 RS modes (A and B): framing

Framing, with an 'N8' magic (rev 8.2: *shortened, evenly split*
blocks):

1. Body = stored chunk ‖ CRC-32(stored), big-endian; let
   `L = len(stored) + 4`.
2. `nb = ⌈L / blk_data⌉` blocks (A: `blk_data` 239, 16 parity;
   B: 223, 32 parity), each of `k = ⌈L / nb⌉` data bytes — the
   body zero-padded at the end to `nb·k` bytes and cut into
   equal blocks. Each block is RS-encoded to `k + nsym` bytes (a
   *shortened* RS code: only those bytes are transmitted; the
   padding zeros are part of the codeword and the decoder
   verifies they decode as zeros). RS is a GF(2^8) code
   (primitive polynomial 0x11D, generator roots α^0..α^(nsym−1)).
   (8.1 always sent full 255-byte blocks: an 80-byte message cost
   ~280 bytes of air.)
3. Byte-interleave the blocks column-wise: stream byte
   order is, for byte index i = 0..k+nsym−1, for each block b,
   block[b][i].
4. Prepend an RS(25,9) header before every 400 stream
   bytes: header info (9 bytes) = 'N8' ‖ stored length
   (4 B BE) ‖ block count (2 B BE) ‖ flags (1 B; bit0 =
   compressed). Header parity is 16 bytes. A header is valid only
   if its block count equals `⌈(stored length + 4) / blk_data⌉`,
   its stored length is under 2^20, its flags use only bit 0, and
   its stored length equals the mini-header's `seglen`.
5. The section's bit stream is the framed bytes, MSB-first,
   mapped to per-tone Gray steps in row-major order (symbol
   by symbol, tone by tone, each tone's bits consecutive,
   high bit first). The stream length is
   `nb·(k+nsym) + 25·⌈nb·(k+nsym)/400⌉` bytes — a function of
   the stored length alone.

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
seglen field carries len(info) exactly. (Rev 8.2: RS modes now
also carry their *stored* length in `seglen` — 8.1 carried the raw
chunk length there — so every section's length in samples is
known from its mini-header.)

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
| 2 | WIRE REVISION = 0x82 (rev 8.2) |
| 3 | mode: 0=A, 1=B, 2=C |
| 4–5 | session ID (BE) |
| 6 | segment index |
| 7 | segment total |
| 8 | flags: bit0 FINAL, bit1 TOKEN-present, bits2–3 NEXT-SPEAKER |
| 9–12 | seglen (BE; §7.2 for its mode-dependent meaning) |
| 13–22 | tone mask, 10 bytes, MSB-first (bit i = grid tone i; **all modes**, rev 8.2) |
| 23–28 | house token (6 bytes; zeros when absent) |
| 29–30 | CRC-16 (BE) over bytes 0–28 |

CRC-16 is CRC-16/CCITT-FALSE (a.k.a. CRC-HQX): polynomial
0x1021, initial value 0xFFFF, no input reflection, no output
reflection, no final XOR. A mini-header whose CRC fails, whose magic
is wrong, whose mode byte is not 0–2, whose seglen is ≥ 2^20, whose
segment total is 0, whose segment index is not below the segment
total, whose flags set any of the reserved bits 4–7, or whose token
bytes are non-zero without the TOKEN flag, is invalid: the
receiver treats the burst as not found (loudly), never guesses
(no sender produces these; a receiver that accepted them could be
steered by a CRC-valid but nonsensical header).

**Wire revision (rev 8.2).** Byte 2 names the wire format. The
check order is: magic, CRC-16, *then* revision. A header that
passes magic and CRC but carries a revision other than `0x82` is
**not** invalid-and-ignored: the receiver raises a named error
(reference: `RevisionError`, a `ValueError`, carrying `.rev` and
`.expected`) from every decode entry point. 8.0/8.1 bursts carry 8
here. Future incompatible revisions must change this byte and keep
the magic / revision / CRC-16 positions. Honest scope: the named
error needs the header to be *found*. An 8.1 Mode A burst is found
(the 8.2 correlator still locks its sounding) and is reported with
its revision; an 8.1 Mode C burst is not locked and fails as "no
NDAP-8 burst found" — loud, never wrong bytes, but unnamed; and an
8.1 decoder shown an 8.2 burst fails loudly the same way (8.1
treats any byte-2 value other than 8 as "not a header").

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
mini-header overhead: measured examples in §14. Duplex is carried
over unchanged in structure and verified under 8.2 (A and B
byte-exact both directions; Python ↔ JS cross-checked for B). Two
rev 8.2 details apply to it: the sounding halves keep the
Schroeder phases of their tone indices, and the receiver locates
the mix with the full-sounding correlator (the sum of two halves
*is* the full sounding).

## 12. Receiver flow, resync, and NACK

Reference receiver flow. The format is what is normative; the
search is receiver-internal, except where marked **(strict)**,
which every receiver must do:

1. **Acquire by correlation.** The sounding
   (§3) is a fixed, known waveform. Let `ref` be the sounding
   audio (the 9,600 samples a sender emits, peak-normalized
   to 0.85; §3 — the rev 8.2 chirp-sign sounding), mean removed and scaled to unit norm, and `L` its
   length. For every offset `k` of the recording compute the
   normalized cross-correlation

       ncc[k] = Σ x[k+i]·ref[i] / sqrt( Σ (x[k+i] − mean_k)² )

   (the window mean is removed in the denominator; `ref` has zero
   mean, so the numerator needs no correction). Offsets must
   leave room for a mini-header after the sounding. Take the
   strongest peaks, at least 480 samples apart, with ncc ≥ 0.02,
   up to 6. For each peak, try the **offset retry ladder**
   0, −8, +8, −16, +16, −32, +32, −64, +64, −128, +128, −240,
   +240 samples: decode the mini-header at (peak + offset +
   9,600) and accept the first that validates with segment
   index 0. Work is bounded: at most 6 × 13 mini-header decodes.
   A raw correlation peak is not trusted to be the start:
   the ladder absorbs skew from filtering, and step 2 refines.
   (Idea credited to NDAP-8-P, whose receiver acquires by
   normalized cross-correlation with an offset retry ladder;
   here the template is NDAP-8's own sounding. With the rev 8.2
   sounding the peak is exact to the sample in clean recordings
   and within a few samples through moderate noise.)
2. **Refine the start.** Scan ±64 samples around the candidate
   — in steps of 4 samples for the unguarded Mode A (timing
   plateau ≈ ±3 samples), steps of 16 for B and C (plateaus ≥ ±70)
   — and keep the centre of the plateau over which segment 0's
   *payload section* decodes exactly. For Mode A the centre is only
   a coarse guess, so it is then replaced by the minimum of the
   **alignment metric** (below) within ±8 samples, provided segment 0
   still decodes there. (Cheaper refinements — mini-header
   soft-score refinement, header-only plateau checks, and the
   sounding correlation peak — were measured and found unreliable.)
   *Alignment metric:* for a candidate section start, project the
   first 64 data symbols (plus the reference symbol), take each
   tone's differential phase, and average the squared distance to
   the nearest constellation point. It needs no decode and has a
   sharp minimum at the true alignment (measured on Mode A,
   noiseless: 0.0000 at 0, 0.0016 at +1, 0.0047 at +2, 0.0150 at +4,
   0.0210 at +5 samples).
3. **(Rev 8.1's fall-back to the 8.0 energy-onset finder is removed
   in 8.2: there is nothing left to be compatible with.)**
4. **Walk the segments.** Each mini-header gives its section's
   exact length (§7, §8.1 seglen), so segment boundaries chain
   deterministically — *including past a failed section*: the
   next mini-header is expected exactly after it (8.1 had to resync
   after every failure). For an unguarded mode (A) each section's
   start is first re-aligned by the alignment metric within ±8
   samples, and the corrected position carries forward — this tracks
   sample-clock drift between sections (§13). If a mini-header
   fails mid-burst, resync with a bounded scan (the
   reference uses a 4 s window) plus soft-score refinement;
   segments that cannot be recovered are reported failed,
   not silently skipped. A CRC-valid header of another wire
   revision anywhere raises `RevisionError` (§8.1).
5. **Normalize the slow envelope (retry).** If the raw
   walk does not fully decode, repeat it with the slow gain
   envelope divided out (informative algorithm below). Phone
   AGC, a tremolo, or a deliberate slow envelope multiply the
   burst by a gain that varies over tens of milliseconds; the
   data is differential phase, so most of it survives, but the
   ripple inside a symbol window bends the least-squares
   projection. The reference measures the gain in 5 ms
   sub-windows of each slot's *active* window only (never the
   silent guards), as power corrected for the detector window's
   taper; smooths over three neighbouring sub-windows (~15 ms);
   interpolates linearly between sub-window centres; scales to
   unit median; clamps to [0.35, 2.5]; and divides the active
   samples by it before projection. It runs on the same slot grid
   the detector uses, so it needs no side information. It never
   replaces the raw attempt: a burst that decodes raw is never
   normalized.
6. **Gate (strict).** Reassemble, verify the §6 CRC-32 over the
   whole message, and report per-segment results. Every
   attempt above is gated by the same checks (mini-header
   CRC-16, per-segment RS/Viterbi + CRC-32, full-message
   CRC-32). The first attempt that fully decodes wins; if none
   does, the attempt with the most good segments is reported,
   with its failed indices. No attempt, fallback, or
   normalization may emit bytes that did not pass the gates:
   a wrong decode surfaces as failure, never as wrong bytes.

The Expression Layer (§19) places data-free audio before and
after the burst; correlation acquisition does not depend on
silence before the sounding, so bookends do not disturb it.

**NACK convention.** A receiver reports the failed segment
indices over whatever return channel exists; only those
segments are re-sent, re-wrapped as a new burst (new
session ID, same mode unless a fresh sounding says
otherwise).

## 13. Clock drift

Two different things go by this name. *Between* sections, Mode A
re-aligns every section by the §12 alignment metric (±8 samples)
and carries the correction forward, so drift accumulated over the
burst is tracked as long as a single section stays inside its
plateau. *Inside* a section nothing is tracked: Mode A's decode
plateau is only ≈ ±3 samples (5 ms symbols, no guard), so a 1.2 s
section tolerates roughly ±90 ppm of sample-clock mismatch.
Measured (4,000 random bytes = 2 segments, Mode A, resampled by
the stated ppm): **8.2 decodes at 0, +25, ±40, ±50, ±60, ±75, ±90
and −100 ppm and fails at +100; 8.1 decodes at 0 and fails from
25 ppm up.** Modes B
and C have guards and plateaus ≥ ±70 samples and each section is
re-located through its own mini-header. Beyond a mode's tolerance,
failures appear as named failed segments, loudest in mode A.
Sample-rate conversion, when needed, belongs in the recording path
and must be reported with any real-air result (§16). (The 8.1 text
claimed ~100 ppm for all modes; that figure was never measured for A.)

## 14. Test channels and measured results

### 14.1 Simulated room channels (rev 8.0/8.1 measurements — NOT re-run for 8.2)

**Status.** The table and notes in this subsection were measured with
the rev 8.0/8.1 formats and the mode thresholds of that time. The
channel generators behind them are not in the tree, so they were not
re-run for 8.2; read them as history, not as 8.2 results. A coarse
re-check with *rebuilt* echo channels is reported in §14.2 (not the
original matrix).

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

**Sample.** The release tree's `examples/ndap8-sample.wav` is a pure encoded burst — no voice intro — carrying the “Mary Had a Little Lamb” verses (233 bytes) as its payload, encoded for rev 8.2 by `encode_adaptive` with the clean-sounding analysis (mode A, session 11724; 0.86 s); it decodes byte-exact from the finished file. (The 8.0/8.1 sample was a foreign revision and was regenerated.)

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

- Mode A is a clean-channel mode, but a much less fragile one
  than in 8.1: it decodes white noise down to ≈ 12 dB SNR
  (§14.2) and tracks clock drift to ≈ ±90 ppm (§13). Its timing
  plateau is only ≈ ±3 samples, its guard is zero, and its
  echo tolerance on real air is unmeasured; the 22 dB
  selection threshold is calibrated on white noise only (§5).
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
- Correlation acquisition fixes *finding* the burst; the physical-layer
  floor is the modes' own. Rev 8.2 lowered the A/B floor by
  removing its cause (the ill-conditioned tapered detector and a
  high-crest preamble, §2–§3), not by adding redundancy; the
  measured floors are in §14.2: A ≈ 11–12 dB white-noise SNR,
  B ≈ 6–9 dB, C ≈ 0 dB. These are floors for a *flat* noise
  channel; rooms add echo and colored noise (§14.1) that 8.2 has
  not been re-measured against.
- The slow-envelope normalizer (§12 step 5) is a retry, and its
  measured rescue rate is small: once acquisition is by
  correlation, a 0.60–1.00 envelope at 25 Hz decodes raw in
  every mode. It cannot invent signal-to-noise ratio that a
  deep envelope removes, and in the guarded modes (B, C) it has
  only two to four sub-window measurements per slot, so envelopes
  faster than about 25 Hz are not tracked.
- `analyze_channel` has not been re-examined for band-limited
  channels. Under 8.1 a sounding that had passed through a
  250–4,200 Hz bandpass was recommended USE_NDAP6 and, for mode C,
  produced a tone mask above 3.4 kHz (the band the filter removed).
  Senders that know their channel is band-limited should mask to the
  passband themselves (every mode takes a mask in 8.2); the
  analyzer's behaviour on such a sounding was not re-run for 8.2.
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
post-projection constellation values of segment 0 rows 0
and 1 — the reference symbol and the first data symbol — for every tone), `corrupt-<mode>.wav` (the golden
with an injected noise burst *inside* the mode's
correction capacity — expected decode: EXACT), and
`broken-<mode>.wav` (corrupted beyond capacity — expected:
loud failure). Appendix B states the conformance criteria,
including why the corrupt vectors exist.

## 19. Expression Layer (optional; introduced in 8.1, carried into 8.2)

NDAP-8 bursts are not pleasant to hear, and people want to give
them character. The rule that makes this safe is one sentence:
**character lives only in layers that carry no data.** NDAP's data
is the differential phase of every tone from one 5 ms-class symbol
to the next, so anything that moves the burst's frequencies or
timing moves the data. Measured (the "R2" expression experiments):
a common pitch glide (equivalently a time warp) over a burst
destroyed decoding at *every* depth tried, 0.3 % to 1.0 %;
whistle bookends before and after the burst, and gentle amplitude
prosody over it, decoded byte-exact and scored identically to
plain bursts in noise tests.

**Permitted (sender side, optional):**

- *Bookend phrases.* Any audio before the sounding (the **pre**
  phrase) and after the last segment (the **post** phrase),
  separated from the burst by silence: whistles, notes, glides,
  a spoken word. The reference limits each phrase to ≤ 1.5 s,
  200–4,000 Hz, at most 0.85 of the burst's peak level, with
  0.10–1.0 s of silence between the phrase and the burst
  (reference default 0.15 s). Glides *inside a bookend* are fine —
  they are not part of the burst.
- *Amplitude prosody.* A slow gain contour over the burst, with
  gain in [1 − depth, 1]. The reference limits are depth ≤ 0.40
  (gain never below 0.60) and contour rate ≤ 8 Hz. The gain
  never exceeds 1, so the burst's peak level is preserved.
  Faster or deeper contours are the §12 step-5 regime and are
  not guaranteed.

**Prohibited:** any frequency or time warp of the burst itself —
pitch glide, vibrato, time stretch, resampling, speed change,
frequency shift, or any other common or per-tone modulation of
the tone frequencies or symbol clock between the first
sounding sample and the last payload sample. A burst so
treated is not an NDAP-8 burst; receivers owe it nothing, and
the reference implementation exposes no parameter that could
produce one.

**Receiver impact: none required.** A rev 8.2 receiver decodes an
expression-wrapped burst byte-exact in every mode (tested), because
correlation acquisition (§12) finds the sounding wherever it is. A receiver may ignore everything outside the
burst. A sender should not rely on listeners hearing the
bookends: a recording path may trim silence.

Reference helpers: `add_expression(samples, bookends=True,
pre=EXPR_PRE, post=EXPR_POST, prosody_depth=0.25,
prosody_hz=2.0, prosody_phase=0.0, gap_s=0.15,
bookend_level=0.6)` in `ndap.py`, mirrored in `js/src/ndap.js`;
the limits above are `EXPR_LIMITS`. Out-of-range arguments raise
rather than clip. The default bookends are a rising two-glide
phrase before the burst (660→880→1,175 Hz, 0.30 s) and a falling
one after (1,175→880→587 Hz, 0.34 s).

## 20. Roadmap (not part of this specification)

**Singing profile (common-mode-tracking decoder).** The R2
result suggests a path to a burst that *sings*: apply a common
pitch contour to every tone together, and have the receiver
estimate it. The idea: with all tones moved by the same factor
`(1+ε(t))`, the *average* phase drift across all tones is the
common-mode term, observable directly from the sounding-style
pilot structure or from the data tones themselves (the data phases
are uniformly distributed, so their circular mean carries the
common drift while the differential data averages out). A
decoder would track that common mode per symbol, subtract it, and
only then take differential phase. Open questions: how much
common-mode excursion the 5 ms symbols can absorb before inter-tone
projection leakage dominates; whether a known pilot tone is
needed to avoid data-dependent bias; and the mini-header, which
would need the same treatment or a flat (unsung) rendering. This
is a roadmap note, **not code and not a format** — until a
receiver exists and measures it, §19's prohibition on warping the
burst stands.

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

Rev 8.1/8.2 note: slow envelopes the sender did *not* announce (phone AGC,
tremolo, a purr from another house) are handled blind by §12 step 5;
this appendix is about announcing one so the receiver can fold it
into the detector exactly.

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
   constellation rows 0–1. The intermediates exist so a
   failure can be isolated to the PHY/projection layer vs
   the framing layer.
2. `corrupt-<mode>.wav` still decodes EXACTLY. This file is
   the point of the set: an implementation that transmits
   parity but never decodes it — a decoder that never RS-decodes
   — passes criterion 1 and fails this one.
   Measured correctable-burst sizes (rev 8.2): A 33 samples, B 300
   samples, C 7,920 samples of band-wide noise at section
   RMS, injected mid-section (exact placement in the JSON).
   Mode A's small figure is itself a datum: one shortened
   block with 16 parity bytes has little room for band-wide
   noise, which is one more reason A is a clean-channel mode.
3. `broken-<mode>.wav` fails LOUDLY (an error, or a report
   with ok = false and the failed segment indices).
   Producing wrong bytes is non-conformant under all
   circumstances.
