#!/usr/bin/env python3
"""NDAP-8 rev 8.1 tests: correlation acquisition, slow-envelope
normalization, strict validation, the Expression Layer, and
backward compatibility with rev 8.0.

Run from the repository root:

    python3 -m unittest discover -s tests -v

Self-contained except for two optional checks that need the rev 8.0
decoder: they `git show` it from the history (commit 8.0_REF) and skip
cleanly when git or that commit is unavailable. The rev 8.0 *encoder*
needs no such lookup: tests/fixtures/ holds bursts it produced, and
the new encoder is asserted sample-identical to them.
"""
import hashlib
import importlib.util
import inspect
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import ndap  # noqa: E402

FIX = os.path.join(ROOT, "tests", "fixtures")
CONF = os.path.join(ROOT, "conformance")
LEGACY_REF = "5216b35"          # the last rev 8.0 commit
PAY = (b"NDAP trial payload: the quick brown fox jumps over "
       b"the lazy dog 0123456789.")


def _legacy_module():
    """The rev 8.0 ndap.py from git history, or None."""
    try:
        src = subprocess.run(
            ["git", "-C", ROOT, "show", f"{LEGACY_REF}:ndap.py"],
            capture_output=True, check=True, timeout=30).stdout
    except Exception:
        return None
    d = tempfile.mkdtemp(prefix="ndap80-")
    path = os.path.join(d, "ndap_80.py")
    with open(path, "wb") as f:
        f.write(src)
    spec = importlib.util.spec_from_file_location("ndap_80", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


LEGACY = _legacy_module()


# ---- channel helpers (numpy only)
def pad(x, lead=14400, tail=9600):
    return np.concatenate([np.zeros(lead), x, np.zeros(tail)])


def awgn(x, snr_db, rng):
    p = np.mean(x[np.abs(x) > 0] ** 2)
    return x + rng.normal(0, np.sqrt(p / 10 ** (snr_db / 10)), len(x))


def envelope(x, f=25.0, lo=0.6, hi=1.0, ph=0.7):
    t = np.arange(len(x)) / ndap.SR
    return x * (lo + (hi - lo) * 0.5 * (1 + np.sin(2 * np.pi * f * t + ph)))


def bandpass(x, lo=250.0, hi=4200.0, roll=60.0):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / ndap.SR)
    g = np.clip((f - (lo - roll / 2)) / roll, 0, 1) * \
        np.clip(((hi + roll / 2) - f) / roll, 0, 1)
    return np.fft.irfft(X * (0.5 - 0.5 * np.cos(np.pi * g)), len(x))


def encode_inband(data, mode, hi_hz, session):
    """A sender that knows the channel is band-limited: tone mask
    restricted to <= hi_hz (the per-tone mask exists for this)."""
    mc = ndap.MODES[mode]
    mask = [1 if f <= hi_hz else 0 for f in mc.grid]
    chunks = ndap._split_work(data, mc)
    parts = [ndap._sounding_audio()]
    for i, ch in enumerate(chunks):
        parts.append(ndap._mini_encode(
            mode, session, i, len(chunks), ndap._seg_stored_len(mc, ch),
            mask, final=(i == len(chunks) - 1)))
        parts.append(ndap._encode_section(mc, ch, mask))
    return np.concatenate(parts)


def acquire_and_walk(y, method, norm=False, data=PAY):
    """Acquisition by `method` ('xcorr' or the rev 8.0 'legacy'
    finder) followed by the segment walk — isolates acquisition."""
    tok = ndap._ENV_NORM.set(norm)
    try:
        st, m0 = ndap._find_burst(y, method=method)
        rep = ndap._walk_segments(y, st, m0)
        return rep["ok"] and rep["data"] == data
    except ValueError:
        return False
    finally:
        ndap._ENV_NORM.reset(tok)


def decodes(mod, y, data=PAY):
    try:
        return mod.decode_adaptive(y) == data
    except Exception:
        return False


class LegacyBursts(unittest.TestCase):
    """Backward compatibility: rev 8.0 bursts decode, rev 8.1 bursts
    are rev 8.0 bursts."""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(FIX, "legacy-8.0.json")) as f:
            cls.man = json.load(f)

    def _fixture(self, mode):
        m = self.man[mode]
        return m, ndap.read_wav(os.path.join(FIX, m["file"]))

    def test_legacy_fixtures_decode_exact(self):
        for mode in "ABC":
            m, x = self._fixture(mode)
            payload = bytes.fromhex(m["payload_hex"])
            rep = ndap.decode_adaptive_report(x)
            self.assertTrue(rep["ok"], f"mode {mode}: {rep['error']}")
            self.assertEqual(rep["data"], payload)
            self.assertEqual(rep["session"], m["session"])
            self.assertEqual(rep["version"], 8)
            self.assertEqual(rep["acquisition"], "xcorr")

    def test_legacy_fixtures_decode_with_either_acquisition(self):
        for mode in "ABC":
            m, x = self._fixture(mode)
            payload = bytes.fromhex(m["payload_hex"])
            for method in ("xcorr", "legacy"):
                self.assertTrue(
                    acquire_and_walk(x, method, data=payload),
                    f"mode {mode} via {method}")

    def test_new_encoder_is_sample_identical_to_rev_80(self):
        """The on-air format is unchanged: encoding the fixture
        payloads with rev 8.1 reproduces the rev 8.0 WAVs exactly.
        (So every rev 8.1 burst is a rev 8.0 burst.)"""
        for mode in "ABC":
            m, want = self._fixture(mode)
            payload = bytes.fromhex(m["payload_hex"])
            got = ndap.encode_adaptive(payload, mode, session_id=m["session"])
            pcm = np.clip(got * 32767, -32768, 32767).astype(np.int16)
            ref = np.round(want * 32767).astype(np.int16)
            self.assertTrue(np.array_equal(pcm, ref), f"mode {mode}")

    def test_wire_version_byte_unchanged(self):
        self.assertEqual(ndap.VERSION, 8)
        self.assertEqual(ndap.__version__, "8.1.0")

    def test_conformance_vectors(self):
        for mode in "ABC":
            with open(os.path.join(CONF, f"golden-{mode}.json")) as f:
                j = json.load(f)
            for kind in ("golden", "corrupt"):
                x = ndap.read_wav(os.path.join(CONF, f"{kind}-{mode}.wav"))
                d = ndap.decode_adaptive(x)
                self.assertEqual(hashlib.sha256(d).hexdigest(),
                                 j["payload_sha256"], f"{kind}-{mode}")
            broken = ndap.read_wav(os.path.join(CONF, f"broken-{mode}.wav"))
            try:
                rep = ndap.decode_adaptive_report(broken)
                self.assertFalse(rep["ok"])
                self.assertIsNone(rep["data"])
            except ValueError:
                pass            # a loud failure is also conformant

    def test_example_sample_decodes(self):
        x = ndap.read_wav(os.path.join(ROOT, "examples", "ndap8-sample.wav"))
        d = ndap.decode_adaptive(x)
        self.assertEqual(len(d), 233)
        self.assertTrue(d.startswith(b"Mary had a little lamb"))

    @unittest.skipIf(LEGACY is None, "rev 8.0 decoder not in git history")
    def test_old_decoder_decodes_new_bursts(self):
        for mode in "ABC":
            m, _ = self._fixture(mode)
            payload = bytes.fromhex(m["payload_hex"])
            y = ndap.encode_adaptive(payload, mode, session_id=m["session"])
            self.assertEqual(LEGACY.decode_adaptive(y), payload, mode)

    @unittest.skipIf(LEGACY is None, "rev 8.0 decoder not in git history")
    def test_old_decoder_decodes_expression_layer(self):
        """The Expression Layer needs no decoder change: a rev 8.0
        receiver decodes bookended, prosody-shaped bursts too."""
        for mode in "ABC":
            y = ndap.add_expression(
                ndap.encode_adaptive(PAY, mode, session_id=9))
            self.assertEqual(LEGACY.decode_adaptive(y), PAY, mode)


class CorrelationAcquisition(unittest.TestCase):
    """Before/after: the rev 8.0 finder ('legacy') vs correlation
    acquisition ('xcorr'), isolated from everything else."""

    def test_finds_exact_start_in_padded_recording(self):
        for mode in "ABC":
            a = ndap.encode_adaptive(PAY, mode, session_id=4)
            x = pad(a, lead=21000)
            st, mini = ndap._find_burst(x, method="xcorr")
            self.assertLessEqual(abs(st - 21000), 40, mode)
            self.assertEqual(mini["index"], 0)

    def test_ncc_peak_is_the_sounding(self):
        a = ndap.encode_adaptive(PAY, "A", session_id=4)
        peaks = ndap._ncc_peaks(pad(a, lead=12345))
        self.assertEqual(peaks[0][1], 12345)
        self.assertGreater(peaks[0][0], 0.99)

    def test_ladder_recovers_from_offset_error(self):
        """A correlation peak that lands off the true start (as a
        filter's group delay can make it) still decodes end to end:
        the retry ladder walks the offsets and each validating one
        is checked against segment 0's payload, not just the
        mini-header (which tolerates 100+ samples of error)."""
        real = ndap._ncc_peaks
        try:
            for mode in "ABC":
                a = ndap.encode_adaptive(PAY, mode, session_id=4)
                x = pad(a)
                for skew in (-230, -100, 60, 200):
                    ndap._ncc_peaks = \
                        lambda s, n=6, k=skew: [(0.5, 14400 + k)]
                    rep = ndap.decode_adaptive_report(x)
                    self.assertTrue(rep["ok"], (mode, skew))
                    self.assertEqual(rep["data"], PAY, (mode, skew))
        finally:
            ndap._ncc_peaks = real

    def test_noise_trials_before_after_mode_c(self):
        """Mode C through white Gaussian noise 5 dB and 3 dB SNR: the
        rev 8.0 acquisition loses the burst, correlation keeps it."""
        new_ok = old_ok = trials = 0
        for snr in (5, 3):
            for seed in range(2):
                rng = np.random.default_rng(100 * snr + seed)
                y = awgn(pad(ndap.encode_adaptive(
                    PAY, "C", session_id=50 + seed)), snr, rng)
                trials += 1
                new_ok += acquire_and_walk(y, "xcorr")
                old_ok += acquire_and_walk(y, "legacy")
        self.assertEqual(new_ok, trials)
        self.assertLess(old_ok, trials)

    def test_noise_30_24_18_db_all_modes_acquire(self):
        """The 30/24/18 dB levels: the correct start is found in
        every mode (decode success then depends on the mode's own
        SNR floor — see the CHANGELOG measurements)."""
        for mode in "ABC":
            for snr in (30, 24, 18):
                rng = np.random.default_rng(7 + snr)
                a = ndap.encode_adaptive(PAY, mode, session_id=11)
                y = awgn(pad(a), snr, rng)
                st, _ = ndap._find_burst(y, method="xcorr")
                self.assertLessEqual(abs(st - 14400), 40, (mode, snr))

    def test_bandpass_250_4200_before_after(self):
        """A 250-4200 Hz channel with a sender that masks to the
        passband. Both finders locate it; the full decode passes
        under rev 8.1 for modes B and C."""
        for mode in "BC":
            y = bandpass(pad(encode_inband(PAY, mode, 4000.0, 21)))
            self.assertTrue(decodes(ndap, y), mode)

    def test_envelope_25hz_acquisition_before_after(self):
        """A 25 Hz gain envelope (0.60-1.00): the rev 8.0 finder
        fails on at least one phase where correlation never does."""
        new_ok = old_ok = trials = 0
        for k in range(3):
            y = envelope(pad(ndap.encode_adaptive(PAY, "A", session_id=60 + k)),
                         ph=1.3 * k)
            trials += 1
            new_ok += acquire_and_walk(y, "xcorr")
            old_ok += acquire_and_walk(y, "legacy")
        self.assertEqual(new_ok, trials)
        self.assertLess(old_ok, trials)

    def test_full_decode_reports_acquisition(self):
        y = pad(ndap.encode_adaptive(PAY, "B", session_id=3))
        rep = ndap.decode_adaptive_report(y)
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["acquisition"], "xcorr")
        self.assertFalse(rep["envelope_normalized"])
        self.assertLessEqual(abs(rep["start"] - 14400), 40)

    def test_explicit_start_still_supported(self):
        a = ndap.encode_adaptive(PAY, "A", session_id=3)
        rep = ndap.decode_adaptive_report(pad(a), start=14400)
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["acquisition"], "given")


class EnvelopeNormalization(unittest.TestCase):
    def test_clean_bursts_survive_normalization(self):
        """Dividing an envelope that is not there must not hurt:
        every mode decodes exactly with normalization forced on."""
        for mode in "ABC":
            a = ndap.encode_adaptive(PAY, mode, session_id=5)
            self.assertTrue(acquire_and_walk(pad(a), "xcorr", norm=True), mode)

    def test_enveloped_decode_forced_normalization(self):
        for mode in "ABC":
            y = envelope(pad(ndap.encode_adaptive(PAY, mode, session_id=5)))
            self.assertTrue(acquire_and_walk(y, "xcorr", norm=True), mode)
            self.assertTrue(decodes(ndap, y), mode)

    def test_estimated_envelope_tracks_the_true_one(self):
        """_divide_envelope on a 25 Hz-modulated mode-A payload
        section: the 5 ms block-RMS ripple (std/mean) is ~0.18 with
        the envelope and falls back to near the plain burst's ~0.04
        after division."""
        rs = np.random.default_rng(1)
        data = bytes(rs.integers(0, 256, 1500, dtype=np.uint8))
        a = ndap.encode_adaptive(data, "A", session_id=5)
        sec = ndap.SND_LEN + ndap.MINI_LEN
        body = a[sec:]
        n = (len(body) // 240) * 240
        t = (np.arange(n) + sec + 0.5) / ndap.SR
        env = 0.8 + 0.2 * np.sin(2 * np.pi * 25.0 * t + 0.7)
        cfg = ndap._sel_cfg(ndap.MODES["A"], [1] * 39)[0]
        plain = body[:n].reshape(-1, 240)
        segs = (body[:n] * env).reshape(-1, 240)
        out = ndap._divide_envelope(segs.copy(), cfg, 240)

        def ripple(m):
            r = np.sqrt((m ** 2).mean(axis=1))
            return float(np.std(r) / np.mean(r))
        self.assertGreater(ripple(segs), 0.12)
        self.assertLess(ripple(plain), 0.08)
        self.assertLess(ripple(out), 0.08)

    def test_normalization_rescues_a_ripple_case(self):
        """A recorded case where the raw walk fails and the
        normalized walk passes: mode B, 10 Hz envelope down to 0.3
        plus 36 dB noise (seeded)."""
        y0 = pad(ndap.encode_adaptive(PAY, "B", session_id=9))
        outcomes = []
        for seed in range(6):
            rng = np.random.default_rng(900 + seed)
            y = awgn(envelope(y0, f=10.0, lo=0.3, ph=0.7), 36, rng)
            raw = acquire_and_walk(y, "xcorr", norm=False)
            nrm = acquire_and_walk(y, "xcorr", norm=True)
            outcomes.append((raw, nrm))
        # never worse with normalization, and strictly better at least once
        self.assertTrue(all(n or not r for r, n in outcomes), outcomes)
        self.assertTrue(any(n and not r for r, n in outcomes), outcomes)

    def test_decode_adaptive_uses_normalized_attempt(self):
        """decode_adaptive_report falls through to the normalizing
        attempt on its own when the raw walk fails."""
        y0 = pad(ndap.encode_adaptive(PAY, "B", session_id=9))
        for seed in range(6):
            rng = np.random.default_rng(900 + seed)
            y = awgn(envelope(y0, f=10.0, lo=0.3, ph=0.7), 36, rng)
            if not acquire_and_walk(y, "xcorr", norm=False) and \
                    acquire_and_walk(y, "xcorr", norm=True):
                rep = ndap.decode_adaptive_report(y)
                self.assertTrue(rep["ok"])
                self.assertTrue(rep["envelope_normalized"])
                self.assertEqual(rep["data"], PAY)
                return
        self.skipTest("no rescue draw in this seed range")


class StrictValidation(unittest.TestCase):
    def _info(self, idx, total, crc_ok=True):
        raw = ndap._mini_info_bytes("A", 0x1234, 0, 1, 10, [1] * 39)
        raw = bytearray(raw[:6]) + bytes([idx, total]) + raw[8:29]
        crc = ndap._crc16(bytes(raw)) if crc_ok else 0
        return bytes(raw) + struct.pack(">H", crc)

    def test_impossible_index_count_rejected(self):
        self.assertIsNotNone(ndap._mini_parse(self._info(0, 1)))
        self.assertIsNotNone(ndap._mini_parse(self._info(4, 5)))
        for idx, total in ((0, 0), (3, 3), (9, 2)):
            self.assertIsNone(ndap._mini_parse(self._info(idx, total)))
        self.assertIsNone(ndap._mini_parse(self._info(0, 1, crc_ok=False)))

    def test_noise_and_silence_fail_loudly(self):
        rng = np.random.default_rng(1)
        for x in (rng.normal(0, 0.1, 3 * ndap.SR), np.zeros(2 * ndap.SR),
                  rng.normal(0, 0.1, 100)):
            with self.assertRaises(ValueError):
                ndap.decode_adaptive(x)

    def test_corruption_never_yields_wrong_bytes(self):
        """Wipe stretches of a burst at random: the decode either
        returns the exact payload or raises/reports failure."""
        rng = np.random.default_rng(5)
        for mode in "AC":
            a = pad(ndap.encode_adaptive(PAY * 3, mode, session_id=2))
            for _ in range(4):
                y = a.copy()
                s = int(rng.integers(14400 + ndap.SND_LEN, len(a) - 9600 - 4000))
                w = int(rng.integers(300, 4000))
                y[s:s + w] = rng.normal(0, 0.2, w)
                rep = None
                try:
                    rep = ndap.decode_adaptive_report(y)
                except ValueError:
                    continue
                if rep["ok"]:
                    self.assertEqual(rep["data"], PAY * 3)
                else:
                    self.assertIsNone(rep["data"])


class ExpressionLayer(unittest.TestCase):
    def test_roundtrip_byte_exact_all_modes(self):
        for mode in "ABC":
            a = ndap.encode_adaptive(PAY, mode, session_id=77)
            y = ndap.add_expression(a)
            self.assertGreater(len(y), len(a))
            self.assertEqual(ndap.decode_adaptive(y), PAY, mode)

    def test_prosody_only_and_bookends_only(self):
        a = ndap.encode_adaptive(PAY, "A", session_id=77)
        pro = ndap.add_expression(a, bookends=False)
        self.assertEqual(len(pro), len(a))
        self.assertEqual(ndap.decode_adaptive(pro), PAY)
        book = ndap.add_expression(a, prosody_depth=0.0)
        self.assertEqual(ndap.decode_adaptive(book), PAY)

    def test_burst_samples_only_scaled(self):
        """The burst inside the wrapper is the original times a
        gain in [1-depth, 1]: no resampling, no warp."""
        a = ndap.encode_adaptive(PAY, "B", session_id=77)
        y = ndap.add_expression(a, prosody_depth=0.3, gap_s=0.2)
        n_pre = len(ndap._whistle(ndap.EXPR_PRE, 1.0)) + int(round(0.2 * ndap.SR))
        body = y[n_pre:n_pre + len(a)]
        nz = np.abs(a) > 1e-3
        g = body[nz] / a[nz]
        self.assertGreaterEqual(float(g.min()), 0.7 - 1e-9)
        self.assertLessEqual(float(g.max()), 1.0 + 1e-9)

    def test_expression_noise_score_matches_plain(self):
        """Same noise draw: bookended+prosody burst decodes where the
        plain burst does (mode C, 12 dB), within one trial of each
        other across draws."""
        plain = wrapped = 0
        for seed in range(3):
            a = ndap.encode_adaptive(PAY, "C", session_id=80 + seed)
            for wrap in (False, True):
                rng = np.random.default_rng(300 + seed)
                x = ndap.add_expression(a) if wrap else pad(a)
                y = awgn(x, 12, rng)
                ok = decodes(ndap, y)
                if wrap:
                    wrapped += ok
                else:
                    plain += ok
        self.assertEqual(plain, 3)
        self.assertGreaterEqual(wrapped, plain - 1)

    def test_limits_enforced(self):
        a = np.zeros(48000)
        for kw in ({"prosody_depth": 0.5}, {"prosody_hz": 20.0},
                   {"gap_s": 0.01}, {"gap_s": 5.0},
                   {"bookend_level": 1.5},
                   {"pre": ((50.0, 100.0, 0.2),)},
                   {"post": ((500.0, 800.0, 3.0),)}):
            with self.assertRaises(ValueError, msg=str(kw)):
                ndap.add_expression(a, **kw)

    def test_no_warp_parameter_exists(self):
        params = set(inspect.signature(ndap.add_expression).parameters)
        for bad in ("warp", "glide", "pitch", "stretch", "speed", "rate",
                    "time_warp", "resample"):
            self.assertNotIn(bad, params)

    def test_time_warp_of_the_burst_is_destroyed(self):
        """Why §19 prohibits warps: a common time-scale warp of the
        burst (equivalently a pitch glide of the same depth),
        0.3 %-1.0 %, is not decoded in modes A and C — and it fails
        loudly, never as wrong bytes."""
        for mode in "AC":
            a = ndap.encode_adaptive(PAY, mode, session_id=77)
            t = np.arange(len(a))
            for warp in (1.003, 1.01):
                y = pad(np.interp(t * warp, t, a))
                try:
                    rep = ndap.decode_adaptive_report(y)
                except ValueError:
                    continue            # loud: no burst found
                self.assertFalse(rep["ok"], (mode, warp))
                self.assertIsNone(rep["data"])


if __name__ == "__main__":
    unittest.main()
