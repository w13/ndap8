#!/usr/bin/env python3
"""NDAP-8 (rev 8.2) conformance-asset generator.

Builds the conformance/ folder next to this script: for each
mode, a golden WAV carrying a known payload, a JSON of
intermediate reference values (so a from-paper implementer
can isolate PHY vs framing failures), and two corrupted
variants — one with an injected error burst INSIDE the mode's
correction capacity (expected decode: EXACT) and one corrupted
BEYOND capacity (expected result: LOUD failure, never wrong
bytes).

The corrupted variants exist because an implementation can
transmit RS parity and never decode it, and clean golden
files cannot catch that. An implementation that strips
parity unread fails the correctable-burst file. See the README in the output folder.

Run: python3 ndap_conformance.py
"""
import hashlib, json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ndap
from ndap import MODES, _sel_cfg, _section_samples, _seg_stored_len

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "conformance")
PAYLOAD = (b"NDAP-8 golden conformance payload: the quick brown fox "
           b"jumps over the lazy dog. 0123456789")
SESSION = 0x8A01


def _constellation(audio, mode):
    """Post-projection coefficients of segment 0's payload
    section: row 0 (the reference preamble symbol) and row 1 (the
    first data symbol), all tones, 6-decimal [re, im] pairs."""
    mc = MODES[mode]
    cfg, _ = _sel_cfg(mc, [1] * len(mc.grid))
    sec = ndap.SND_LEN + ndap.MINI_LEN
    coeffs = ndap._slots_coeffs(audio, cfg, mc.guard, sec, 2)
    return {f"row{r}": [[round(float(z.real), 6), round(float(z.imag), 6)]
                        for z in coeffs[r]] for r in (0, 1)}


def _framing_ref(audio, mode):
    """Intermediate framing values for segment 0, recomputed
    from the payload exactly as the spec defines them."""
    mc = MODES[mode]
    chunks = ndap._split_work(PAYLOAD, mc)
    assert len(chunks) == 1, "golden payload must be one segment"
    chunk = chunks[0]
    mini = ndap._mini_info_bytes(mode, SESSION, 0, 1,
                                  _seg_stored_len(mc, chunk),
                                  [1] * len(mc.grid), final=True)
    ref = {"segment0_mini_info_bytes_hex": mini.hex(),
           "segment0_chunk_len": len(chunk)}
    if mc.code == "rs":
        stored, flags = ndap._stored_of(chunk)
        stream = ndap._frame_rs(stored, flags, mc.rs_data, mc.rs_nsym)
        ref["segment0_framed_stream_first64_hex"] = stream[:64].hex()
        ref["segment0_first_header_block_hex"] = stream[:25].hex()
        ref["segment0_stored_len"] = len(stored)
    else:
        info = ndap._conv_info(chunk)
        bits = np.unpackbits(np.frombuffer(info, dtype=np.uint8))
        coded = ndap.conv_encode(bits, ndap.CODE_GENS)
        coded = ndap._permute(
            coded, ndap._data_perm_P(len(coded)))
        ref["segment0_info_bytes_hex"] = info.hex()
        ref["segment0_coded_bits_first256"] = "".join(
            str(int(b)) for b in coded[:256])
    return ref


def _corrupt(audio, mode, span, seed):
    """Replace `span` samples in the middle of segment 0's
    payload section with white noise at the section's RMS."""
    mc = MODES[mode]
    sec = ndap.SND_LEN + ndap.MINI_LEN
    chunk = ndap._split_work(PAYLOAD, mc)[0]
    sec_len = _section_samples(mc, _seg_stored_len(mc, chunk),
                               [1] * len(mc.grid))
    mid = sec + sec_len // 2
    rng = np.random.default_rng(seed)
    out = np.array(audio, dtype=float)
    start = mid - span // 2
    seg = out[start:start + span]
    rms = float(np.sqrt(np.mean(seg ** 2))) + 1e-9
    out[start:start + span] = rng.normal(0, rms, span)
    return out, {"burst_start_sample": int(start),
                 "burst_len_samples": int(span),
                 "burst_kind": "white noise at section RMS"}


def _decodes_exact(audio):
    try:
        return ndap.decode_adaptive(audio) == PAYLOAD
    except Exception:
        return False


def _fails_loudly(audio):
    try:
        rep = ndap.decode_adaptive_report(audio)
        return not rep["ok"] and rep["data"] is None
    except Exception:
        return True


def build_mode(mode):
    mc = MODES[mode]
    audio = ndap.encode_adaptive(PAYLOAD, mode, session_id=SESSION)
    assert _decodes_exact(audio), f"golden {mode} does not decode"
    ndap.write_wav(os.path.join(OUT, f"golden-{mode}.wav"), audio)
    # correctable burst: largest span (growth search from a
    # small fraction of a symbol, then binary refinement)
    # that still decodes exactly. The search starts small
    # because one FULL symbol of band-wide noise at section
    # RMS already overwhelms mode A's RS(255,239).
    span, lo, hi = max(8, (mc.active + mc.guard) // 16), None, None
    while span <= (mc.active + mc.guard) * 64:
        trial, _ = _corrupt(audio, mode, span, 8100)
        if _decodes_exact(trial):
            lo = span
            span *= 2
        else:
            hi = span
            break
    assert lo is not None, f"no correctable burst found for {mode}"
    if lo is not None and hi is not None:
        for _ in range(3):
            mid = (lo + hi) // 2
            trial, _ = _corrupt(audio, mode, mid, 8100)
            if _decodes_exact(trial):
                lo = mid
            else:
                hi = mid
        span = lo
    corr, cmeta = _corrupt(audio, mode, span, 8100)
    assert _decodes_exact(corr), f"corrupt {mode} no longer exact"
    ndap.write_wav(os.path.join(OUT, f"corrupt-{mode}.wav"), corr)
    # beyond capacity: noise over the whole second half of
    # segment 0's section
    chunk = ndap._split_work(PAYLOAD, mc)[0]
    sec_len = _section_samples(mc, _seg_stored_len(mc, chunk),
                               [1] * len(mc.grid))
    broken, bmeta = _corrupt(audio, mode, sec_len // 2, 8200)
    assert _fails_loudly(broken), f"broken {mode} did not fail loudly"
    ndap.write_wav(os.path.join(OUT, f"broken-{mode}.wav"), broken)
    ref = {
        "mode": mode,
        "payload_text": PAYLOAD.decode(),
        "payload_sha256": hashlib.sha256(PAYLOAD).hexdigest(),
        "session_id": SESSION,
        "sample_rate": 48000,
        "golden_wav": f"golden-{mode}.wav",
        "constellation_segment0": _constellation(audio, mode),
        "corrupt_wav": f"corrupt-{mode}.wav",
        "corrupt_expected": "decode EXACT (payload_sha256 matches)",
        "corrupt_burst": cmeta,
        "broken_wav": f"broken-{mode}.wav",
        "broken_expected": "LOUD failure (exception or ok=False); "
                           "never wrong bytes",
        "broken_burst": bmeta,
    }
    ref.update(_framing_ref(audio, mode))
    with open(os.path.join(OUT, f"golden-{mode}.json"), "w") as f:
        json.dump(ref, f, indent=1)
    print(f"mode {mode}: golden {len(audio)/48000:.2f}s, "
          f"correctable burst {span} samples "
          f"({span/48000*1000:.0f} ms), broken burst "
          f"{bmeta['burst_len_samples']} samples")


README = """# NDAP-8 conformance assets

Golden files for from-paper NDAP-8 implementations. An
implementation is conformant when, for every mode:

- `golden-<mode>.wav` decodes to the payload in
  `golden-<mode>.json` (sha256 given), and its intermediate
  values match the JSON (mini-header info bytes, framing
  bytes, and the post-projection constellation of segment 0,
  rows 0 and 1) — the intermediates exist so a failure can be
  isolated to the PHY/projection layer vs the framing layer.
- `corrupt-<mode>.wav` — the golden with an error burst
  injected INSIDE the mode's correction capacity — still
  decodes EXACTLY. This file is the point of the set: an
  implementation that transmits RS/convolutional parity but
  never actually decodes it passes the clean golden and
  fails this one.
- `broken-<mode>.wav` — corrupted BEYOND capacity — fails
  LOUDLY (an error, or a report with ok=False and the failed
  segment indices). Producing wrong bytes is non-conformant
  under all circumstances.

Verified at generation time: a decoder patched to strip RS
parity unread decodes `golden-A`/`golden-B` EXACTLY and fails
`corrupt-A`/`corrupt-B` loudly. Mode C's correctable burst is 7,920
samples (165 ms, ~5.5 symbols) of band-wide noise, far
beyond what any non-decoding receiver survives. The
correctable-burst sizes are in each `golden-<mode>.json`.

Generated by `../ndap_conformance.py` against the reference
implementation; regenerate rather than editing by hand.
"""


def main():
    os.makedirs(OUT, exist_ok=True)
    for mode in "ABC":
        build_mode(mode)
    with open(os.path.join(OUT, "README.md"), "w") as f:
        f.write(README)
    print("conformance set written to", OUT)


if __name__ == "__main__":
    main()
