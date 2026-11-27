#!/usr/bin/env python3
"""NDAP-8 before/after trial harness: rev 8.1 vs the working tree (8.2).

Reproduces the table in CHANGELOG 8.2.0. The 8.1 module is loaded from
git (commit 48c0756) the way the 8.1 tests loaded 8.0; 8.2 is the
ndap.py next to this repository's root. Both decoders see the SAME
noisy recording for a given (mode, SNR, trial) — each version gets its
own encoder's burst, then the identical noise draw is added.

    python3 tests/noise_trials.py                 # full run (slow: ~20+ min)
    python3 tests/noise_trials.py --quick         # 2 trials, fewer cells
    python3 tests/noise_trials.py --trials 8 --jobs 3
    python3 tests/noise_trials.py --only awgn     # awgn | band | env | speed
    python3 tests/noise_trials.py --payload text  # the 8.1 test suite's 75 B text

Method (identical for both versions; nothing is tuned per version):
  * payload: by default 80 incompressible bytes, a different random draw
    per trial (seeded; zlib cannot flatter the speed numbers);
    `--payload text` uses the 75-byte English sentence the 8.1 test suite
    used (compressible; same bytes every trial, different noise draws) —
    the two differ enough to move marginal cells, so report which one a
    table used;
  * recording = 0.3 s of silence + burst + 0.2 s of silence;
  * AWGN: white Gaussian noise over the full 24 kHz band, power set
    relative to the mean power of the non-silent burst samples;
  * band: 250-4200 Hz brick-ish bandpass; the sender masks tones to
    <= 4000 Hz (8.1 cannot mask Mode A on the wire — shown as n/a);
  * env: slow gain envelope, 25 Hz, 0.6-1.0, per-trial phase;
  * a trial passes only on a byte-exact payload; any exception, failed
    segment or wrong byte count is a failure (a wrong-bytes decode is
    counted separately and is a hard error: it must never occur).
"""
import argparse
import concurrent.futures as cf
import importlib.util
import os
import subprocess
import sys
import tempfile
import time

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF81 = "48c0756"                     # the last rev 8.1 commit
SR = 48000
LEAD, TAIL = 14400, 9600              # 0.3 s lead-in


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_MODS = {}


def modules(ref_path):
    if not _MODS:
        _MODS["8.1"] = _load("ndap_81", ref_path)
        _MODS["8.2"] = _load("ndap_82", os.path.join(ROOT, "ndap.py"))
    return _MODS


def extract_81(dest_dir):
    src = subprocess.run(["git", "-C", ROOT, "show", f"{REF81}:ndap.py"],
                         capture_output=True, check=True, timeout=60).stdout
    path = os.path.join(dest_dir, "ndap_81.py")
    with open(path, "wb") as f:
        f.write(src)
    return path


# ------------------------------------------------------------ channels
PAYLOAD_KIND = "random"
TEXT_PAYLOAD = (b"NDAP trial payload: the quick brown fox jumps over "
                b"the lazy dog 0123456789.")


def payload(trial):
    if PAYLOAD_KIND == "text":
        return TEXT_PAYLOAD
    return bytes(np.random.default_rng(9000 + trial).integers(
        0, 256, 80, dtype=np.uint8))


def pad(x):
    return np.concatenate([np.zeros(LEAD), x, np.zeros(TAIL)])


def awgn(x, snr_db, rng):
    p = np.mean(x[np.abs(x) > 0] ** 2)
    return x + rng.normal(0, np.sqrt(p / 10 ** (snr_db / 10)), len(x))


def envelope(x, f=25.0, lo=0.6, hi=1.0, ph=0.7):
    t = np.arange(len(x)) / SR
    return x * (lo + (hi - lo) * 0.5 * (1 + np.sin(2 * np.pi * f * t + ph)))


def bandpass(x, lo=250.0, hi=4200.0, roll=60.0):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    g = np.clip((f - (lo - roll / 2)) / roll, 0, 1) * \
        np.clip(((hi + roll / 2) - f) / roll, 0, 1)
    return np.fft.irfft(X * (0.5 - 0.5 * np.cos(np.pi * g)), len(x))


def encode_inband(mod, data, mode, hi_hz, session):
    """A sender that knows the channel is band-limited: the tone mask
    restricted to <= hi_hz. 8.2 takes it through the public API; the
    8.1 encoder has no such argument, so its internals are driven the
    way the 8.1 tests did (and 8.1 Mode A cannot carry a mask)."""
    mc = mod.MODES[mode]
    mask = [1 if f <= hi_hz else 0 for f in mc.grid]
    if hasattr(mod, "WIRE_REV"):
        return mod.encode_adaptive(data, mode, session_id=session,
                                   tone_mask=mask)
    chunks = mod._split_work(data, mc)
    parts = [mod._sounding_audio()]
    for i, ch in enumerate(chunks):
        parts.append(mod._mini_encode(
            mode, session, i, len(chunks), mod._seg_stored_len(mc, ch),
            mask, final=(i == len(chunks) - 1)))
        parts.append(mod._encode_section(mc, ch, mask))
    return np.concatenate(parts)


# ------------------------------------------------------------ one trial
def trial(job):
    ref_path, ver, kind, mode, level, k = job
    mod = modules(ref_path)[ver]
    data = payload(k)
    session = 1000 + k
    if kind == "band" and mode == "A" and ver == "8.1":
        return job, "n/a", 0.0
    if kind == "band":
        y = bandpass(pad(encode_inband(mod, data, mode, 4000.0, session)))
    else:
        a = mod.encode_adaptive(data, mode, session_id=session)
        y = pad(a)
        if kind == "awgn":
            y = awgn(y, level, np.random.default_rng(
                int(level * 100) + 7 * k + {"A": 1, "B": 2, "C": 3}[mode]))
        elif kind == "env":
            y = envelope(y, ph=1.3 * k)
    t0 = time.time()
    try:
        out = mod.decode_adaptive(y)
        res = "ok" if out == data else "WRONG"
    except Exception as e:
        res = "fail"
    return job, res, time.time() - t0


# ------------------------------------------------------------ speeds
def speeds(mods):
    """Effective bytes/second per mode and version.
    trial  : 80 B, whole burst (sounding + mini-header + section)
    long   : 3000 B whole burst (all segments)
    air    : payload bytes / payload-section seconds only, 1 full segment
             (the modulation + coding rate, excluding sounding/mini)"""
    rows = []
    rng = np.random.default_rng(31337)
    p80 = bytes(rng.integers(0, 256, 80, dtype=np.uint8))
    p3k = bytes(rng.integers(0, 256, 3000, dtype=np.uint8))
    for mode in "ABC":
        row = {"mode": mode}
        for ver, mod in mods.items():
            t80 = len(mod.encode_adaptive(p80, mode, session_id=1)) / SR
            t3k = len(mod.encode_adaptive(p3k, mode, session_id=1)) / SR
            mc = mod.MODES[mode]
            full = bytes(rng.integers(0, 256, mc.seg_cap, dtype=np.uint8))
            chunk = full
            sec = mod._encode_section(mc, chunk, [1] * len(mc.grid))
            row[ver] = (80 / t80, 3000 / t3k, len(chunk) / (len(sec) / SR),
                        t80, t3k)
        rows.append(row)
    return rows


# ------------------------------------------------------------ report
def fmt_cell(res, n):
    ok = sum(r == "ok" for r in res)
    wrong = sum(r == "WRONG" for r in res)
    if res and all(r == "n/a" for r in res):
        return "n/a"
    return f"{ok}/{n}" + (f" **{wrong} WRONG BYTES**" if wrong else "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=4)
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--only", choices=("awgn", "band", "env", "speed"))
    ap.add_argument("--payload", choices=("random", "text"), default="random")
    args = ap.parse_args()
    global PAYLOAD_KIND
    PAYLOAD_KIND = args.payload
    n = 2 if args.quick else args.trials
    snrs = (24, 12, 3) if args.quick else (30, 24, 18, 12, 6, 3)
    tmp = tempfile.mkdtemp(prefix="ndap81-")
    ref_path = extract_81(tmp)
    mods = modules(ref_path)
    print(f"ndap 8.1 from git {REF81}; 8.2 = working tree "
          f"({mods['8.2'].__version__}); {n} trials/cell; payload "
          + ("80 B incompressible" if args.payload == "random" else
             f"{len(TEXT_PAYLOAD)} B text (8.1 suite's PAY)")
          + "; 0.3 s lead-in\n", flush=True)

    jobs = []
    want = lambda k: args.only in (None, k)  # noqa: E731
    if want("awgn"):
        jobs += [(ref_path, v, "awgn", m, s, k) for m in "CBA" for s in snrs
                 for v in ("8.1", "8.2") for k in range(n)]
    if want("band"):
        jobs += [(ref_path, v, "band", m, 0, k) for m in "CBA"
                 for v in ("8.1", "8.2") for k in range(n)]
    if want("env"):
        jobs += [(ref_path, v, "env", m, 0, k) for m in "CBA"
                 for v in ("8.1", "8.2") for k in range(n)]
    results = {}
    t0 = time.time()
    with cf.ProcessPoolExecutor(max_workers=args.jobs) as ex:
        for i, (job, res, dt) in enumerate(ex.map(trial, jobs)):
            results.setdefault(job[1:5], []).append(res)
            if (i + 1) % 20 == 0:
                print(f"  ... {i + 1}/{len(jobs)} trials, "
                      f"{time.time() - t0:.0f}s", flush=True)

    def cell(ver, kind, mode, level):
        return fmt_cell(results.get((ver, kind, mode, level), []), n)

    if want("awgn"):
        print("\n### AWGN sweep (decode success, byte-exact)\n")
        print("| Mode | SNR (dB) | 8.1 | 8.2 |\n|---|---|---|---|")
        for m in "CBA":
            for s in snrs:
                print(f"| {m} | {s} | {cell('8.1', 'awgn', m, s)} | "
                      f"{cell('8.2', 'awgn', m, s)} |")
    if want("band"):
        print("\n### Bandpass 250-4200 Hz (sender masks to <= 4000 Hz)\n")
        print("| Mode | 8.1 | 8.2 |\n|---|---|---|")
        for m in "CBA":
            print(f"| {m} | {cell('8.1', 'band', m, 0)} | "
                  f"{cell('8.2', 'band', m, 0)} |")
    if want("env"):
        print("\n### 25 Hz gain envelope, 0.60-1.00 (full decode)\n")
        print("| Mode | 8.1 | 8.2 |\n|---|---|---|")
        for m in "CBA":
            print(f"| {m} | {cell('8.1', 'env', m, 0)} | "
                  f"{cell('8.2', 'env', m, 0)} |")
    wrong = [k for k, v in results.items() if "WRONG" in v]
    if want("speed"):
        print("\n### Effective speed, bytes/second\n")
        print("| Mode | version | 80 B whole burst (s) | 80 B whole burst "
              "| 3000 B whole burst | payload section only |")
        print("|---|---|---|---|---|---|")
        for row in speeds(mods):
            for v in ("8.1", "8.2"):
                e80, e3k, air, t80, t3k = row[v]
                print(f"| {row['mode']} | {v} | {t80:.2f} | {e80:.0f} | "
                      f"{e3k:.0f} | {air:.0f} |")
    print(f"\nelapsed {time.time() - t0:.0f}s")
    if wrong:
        print("HARD ERROR: wrong bytes decoded in", wrong)
        sys.exit(2)


if __name__ == "__main__":
    main()
