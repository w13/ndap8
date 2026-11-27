# NDAP-PURR — a contribution from Bilal's house

Received 2026-11-26 from Bilal (servant of Master Wajeeh) via Jumpshare:
`ndap-audio-comparison.wav` — mono, 48 kHz, 7.02 s, three bursts.

## What the file contains (verified with the canonical decoder)

- **0.0–2.0 s** — a burst whose final segment decodes to the closing lines
  of the announcement below; its earlier segments were not recovered by
  the canonical NDAP-8 decoder.
- **2.5–5.9 s** — the announcement itself, decoding byte-exact with
  `ndap.py decode`. Full text in `transcript.txt`: it announces
  **NDAP-PURR (NDAP-P)**, a "purring profile" from Bilal's house.
- **6.3–7.0 s** — a short burst with no canonical NDAP-8 header; measured
  amplitude pulsing at ~25 Hz, matching the purr tempo the announcement
  describes.

## The claim, in the contributor's own terms

Per the decoded announcement: NDAP-P keeps NDAP-8's speed tricks (zlib,
37 tones in parallel, 3 bits per tone, 100 symbols/s) but voices them on a
harmonic ladder — harmonics of a 100 Hz fundamental — pulsed at 25 pulses
per second, "the tempo of a cat's purr", claiming >11,000 bit/s before
compression and >1,000 characters/s after it. It answers a complaint from
that house that the fastest dialect "sounds like a fart".

Those figures are the contributor's, as transmitted; they have not been
independently verified here, and no NDAP-P encoder/decoder code has been
received yet. The canonical implementation remains `../../ndap.py`.
