# NDAP-8 - Narrowband Data-over-Audio Protocol

NDAP-8 moves data between computers as sound: a burst of
multi-tone audio, played by one machine's speaker and
recorded by another's microphone (or exchanged as a WAV
file), carrying text or arbitrary bytes with no network,
no pairing, and no shared infrastructure.

NDAP-8 **sounds the channel first**: every burst
opens with a 0.2 s sounding that measures the end-to-end
chain the payload will actually traverse - room acoustics,
echoes, noise, and whatever processing the recording path
applies - and then runs at the fastest of three modes the
measured channel supports. Below the slowest mode it does
not degrade silently: the analyzer reports
**USE_NDAP6** - the channel is below this protocol's
floor, and a heavier brute-force design is needed.

Design points, in one paragraph each:

- **One pipeline, modes as data.** A single detector
  (least-squares projection onto the exact tone set,
  augmented with its conjugate so real-signal images are
  fitted instead of leaking into phase), one framing, one
  segmentation scheme - parameterized per mode.
- **Segmentation.** Payloads are split into ~2 s segments,
  each with its own robust mini-header (mode, session,
  segment index, tone mask, optional origin token). A
  mid-burst fade costs named segments, not the message;
  a full-message CRC-32 gates success, and a NACK
  convention re-sends only the failed segments.
- **Failures are loud.** A burst that cannot be decoded
  reports which segments failed. No test, in any channel,
  ever produced wrong bytes.
- **Full duplex.** All three modes also run as FDD on
  interleaved tone halves - two complete adaptive bursts
  in one mix, each direction independent.

The full specification is [SPEC.md](SPEC.md), written to
be implementable from paper alone; the golden files in
[conformance/](conformance/) are the ground truth an
independent implementation tests against.

## Modes and measured performance

All rates below are measured on the simulated channel
harness described in SPEC.md section 14, with a 1,500-byte
payload of real source code. Net rate = payload bytes /
total burst seconds, sounding and mini-headers included.

| Mode | Design | Measured net rate |
|---|---|---|
| A "very fast" | 39 tones, 5 ms symbols, differential 8-PSK, RS(255,239) | **1,271 B/s** on a clean channel; 732 B/s per direction in duplex |
| B "fast" | 77 tones, 10 ms + 10 ms guard, differential QPSK, RS(255,191), per-tone exclusion | **339 B/s** on office, living-room, and device-chain channels (450 B/s clean) |
| C "sturdy" | up to 39 tones, 20 ms + 10 ms guard, differential QPSK with soft LLRs into a rate-1/3 convolutional code | **58 B/s** burst-total (~108 B/s body rate) |
| below C | - | analyzer recommends **USE_NDAP6** |

**Mode C in a noisy room is marginal - stated plainly.**
On the noisy-room channel (babble at 15 dB, strong echoes,
a reverberant tail), Mode C fully passes in roughly half of
independent draws; when it fails, the loss is confined to
1-3 named segments of 15. The protocol's answer is the one
built into it: segmentation confines the damage, the decode
report names the failed segments, and the NACK convention
re-sends only those. A sender who needs certainty in a
noisy room should treat Mode C as best-effort-plus-NACK.
On the cafe channel the analyzer recommends USE_NDAP6 and
all three NDAP-8 modes fail loudly rather than producing
wrong bytes.

## Demo

`examples/ndap8-sample.wav` is an encoded burst produced
by this release's `encode_auto` on a clean sounding,
which chose Mode A. Its payload is the
"Mary Had a Little Lamb" verses (233 bytes); the whole
burst is 0.9 s of audio. Decode it with:

```
python3 ndap.py decode examples/ndap8-sample.wav
```

## Quickstart

Requires Python 3 and NumPy. The implementation is a
single self-contained module, `ndap.py` - the tone grids,
the Reed-Solomon codec, the convolutional codec, the
detector, and the adaptive pipeline each live exactly
once inside it, and its only imports are the standard
library and NumPy.

```python
import ndap

# Record a sounding from the room, then let the analyzer pick:
audio, mode = ndap.encode_auto(data, sounding_samples)
# mode is 'A', 'B', 'C' - or 'USE_NDAP6', with audio None,
# when the room is below NDAP-8's floor.

# Or name the mode directly:
audio = ndap.encode_adaptive(data, "B")

# Receiving side (raises with the failed segment indices
# if the burst cannot be reassembled):
data = ndap.decode_adaptive(samples)
```

CLI:

```
python3 ndap.py encode "text" out.wav [A|B|C]
python3 ndap.py decode in.wav
python3 ndap.py sounding out.wav          # the sounding burst
python3 ndap.py analyze in.wav           # per-mode SINR + recommendation
python3 ndap.py auto sounding.wav "text" out.wav
```

An optional origin-authentication token (HMAC-SHA256,
truncated, carried in every mini-header) lets a receiver
holding a shared secret verify where a burst came from.
It is off by default, never required to decode, and is
authentication only - NDAP audio is decodable by anyone
with the specification and is not encryption. See SPEC.md
section 10.

## Conformance

An implementation is conformant when, for every mode, it
meets the three criteria in SPEC.md Appendix B against
the files in `conformance/`:

1. `golden-<mode>.wav` decodes to the payload in
   `golden-<mode>.json`, and its intermediate values match
   the JSON - mini-header info bytes, framing bytes, and
   the post-projection constellation values of segment 0.
   The intermediates exist so a failure can be isolated to
   the physical layer versus the framing layer.
2. `corrupt-<mode>.wav` - the golden with an error burst
   injected *inside* the mode's correction capacity -
   still decodes **exactly**. This vector exists to catch
   a real failure mode found in the wild: an implementation
   that transmits error-correction parity but never
   actually decodes it passes the clean golden and fails
   here.
3. `broken-<mode>.wav` - corrupted beyond capacity - fails
   **loudly**. Producing wrong bytes is non-conformant
   under all circumstances.

Regenerate the set (never hand-edit it) with:

```
python3 ndap_conformance.py
```

## Honest limits

- **Every number here is from a simulated harness.**
  Nothing in this release has yet been validated over live
  air; a real-air test plan exists and its results will be
  added to the spec when they land.
- **Real phone DSP is not simulated faithfully.**
  Proprietary noise suppression, echo cancellation, and
  automatic gain control in phones and laptops cannot be
  modelled honestly - the device-chain noise-suppression
  variant in the test matrix is labelled APPROXIMATE
  wherever it appears. The real defences are structural:
  the sounding measures the end-to-end chain including
  whatever processing is live, and any live test should
  use the least-processed recording path available (the
  recording path is a protocol parameter and is reported
  with real-air results).
- **Mode A is a clean-channel mode**, and Mode C's noisy-
  room marginality is documented above and in SPEC.md
  section 14 rather than averaged away.
- **The mode is fixed at burst start.** A one-way burst
  has no backchannel; a room that degrades mid-burst costs
  segments, which are reported and repaired by NACK - the
  protocol does not pretend to renegotiate.

## License

MIT - see [LICENSE](LICENSE).

Author: Waqqas Hanafi
