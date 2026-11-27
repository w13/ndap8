#!/usr/bin/env python3
"""NDAP-8 rev 8.2 tests: the clean-slate wire format.

Run from the repository root:

    python3 -m unittest discover -s tests -v

Self-contained except for the checks that need the rev 8.1 module (the
revision-mismatch tests): they `git show` it from history (commit
REF81) and skip cleanly when git or that commit is unavailable.
The before/after measurements live in tests/noise_trials.py.
"""
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

CONF = os.path.join(ROOT, "conformance")
REF81 = "48c0756"
PAY = (b"NDAP trial payload: the quick brown fox jumps over "
       b"the lazy dog 0123456789.")
RAND80 = bytes(np.random.default_rng(82).integers(0, 256, 80, dtype=np.uint8))


def _module_81():
    try:
        src = subprocess.run(
            ["git", "-C", ROOT, "show", f"{REF81}:ndap.py"],
            capture_output=True, check=True, timeout=30).stdout
    except Exception:
        return None
    d = tempfile.mkdtemp(prefix="ndap81-")
    path = os.path.join(d, "ndap_81.py")
    with open(path, "wb") as f:
        f.write(src)
    spec = importlib.util.spec_from_file_location("ndap_81", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


NDAP81 = _module_81()


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


def decodes(y, data=PAY):
    try:
        return ndap.decode_adaptive(y) == data
    except Exception:
        return False


def walk(y, norm=False, data=PAY):
    """Acquisition + segment walk only (isolates the receiver front)."""
    tok = ndap._ENV_NORM.set(norm)
    try:
        st, m0 = ndap._find_burst(y)
        rep = ndap._walk_segments(y, st, m0)
        return rep["ok"] and rep["data"] == data
    except ValueError:
        return False
    finally:
        ndap._ENV_NORM.reset(tok)


class Format(unittest.TestCase):
    def test_versions(self):
        self.assertEqual(ndap.__version__, "8.2.0")
        self.assertEqual(ndap.WIRE_REV, 0x82)

    def test_roundtrip_byte_exact_all_modes(self):
        for mode in "ABC":
            for data in (PAY, RAND80, b"x"):
                a = ndap.encode_adaptive(data, mode, session_id=11)
                self.assertEqual(ndap.decode_adaptive(pad(a)), data,
                                 (mode, len(data)))

    def test_multi_segment_roundtrip(self):
        """Segments chain through the mini-header's exact section
        length. C: 4 segments; B/A: a payload over their segment cap."""
        rng = np.random.default_rng(3)
        for mode, n in (("C", 330), ("B", 1300), ("A", 3500)):
            data = bytes(rng.integers(0, 256, n, dtype=np.uint8))
            a = ndap.encode_adaptive(data, mode, session_id=12)
            rep = ndap.decode_adaptive_report(pad(a))
            self.assertTrue(rep["ok"], (mode, rep["error"]))
            self.assertEqual(rep["data"], data)
            self.assertGreaterEqual(len(rep["segments"]), 2, mode)

    def test_detector_is_orthogonal_for_dense_layouts(self):
        """The 8.2 invariant: A and B project with a rectangular
        window, so the detector matrix is perfectly conditioned (8.1:
        cond 32 and 91, ~10 and ~17 dB of lost noise margin)."""
        for mode in "AB":
            mc = ndap.MODES[mode]
            cfg, _ = ndap._sel_cfg(mc, [1] * len(mc.grid))
            self.assertLess(cfg.cond(), 1.05, mode)
        self.assertLess(ndap._snd1_cfg.cond(), 1.05)

    def test_shortened_rs_sends_only_what_it_needs(self):
        stored = bytes(range(84))
        for mode in "AB":
            mc = ndap.MODES[mode]
            fr = ndap._frame_rs(stored, 0, mc.rs_data, mc.rs_nsym)
            self.assertEqual(len(fr), ndap._rs_stream_len(
                len(stored), mc.rs_data, mc.rs_nsym))
            # one block: 84 + 4 CRC + nsym parity (+25 header) — not 255
            self.assertEqual(len(fr), 88 + mc.rs_nsym + ndap.HDR_LEN)
            got, flags = ndap._unframe_rs(fr, mc.rs_data, mc.rs_nsym,
                                          len(stored))
            self.assertEqual((got, flags), (stored, 0))

    def test_rs_frame_corrects_within_capacity_and_fails_beyond(self):
        mc = ndap.MODES["B"]
        stored = bytes(np.random.default_rng(1).integers(
            0, 256, 700, dtype=np.uint8))
        fr = bytearray(ndap._frame_rs(stored, 0, mc.rs_data, mc.rs_nsym))
        ok = bytearray(fr)
        for i in range(30, 30 + 3 * 17, 17):        # a few byte errors
            ok[i] ^= 0x5A
        got, _ = ndap._unframe_rs(bytes(ok), mc.rs_data, mc.rs_nsym,
                                  len(stored))
        self.assertEqual(got, stored)
        bad = bytearray(fr)
        for i in range(30, len(bad) - 30, 3):       # ruin a third
            bad[i] ^= 0xFF
        with self.assertRaises(ValueError):
            ndap._unframe_rs(bytes(bad), mc.rs_data, mc.rs_nsym,
                             len(stored))

    def test_header_length_must_match_mini_header(self):
        mc = ndap.MODES["A"]
        fr = ndap._frame_rs(bytes(range(50)), 0, mc.rs_data, mc.rs_nsym)
        with self.assertRaises(ValueError):
            ndap._unframe_rs(fr, mc.rs_data, mc.rs_nsym, 51)

    def test_section_length_is_exact_from_the_mini_header_alone(self):
        for mode in "ABC":
            mc = ndap.MODES[mode]
            mask = [1] * len(mc.grid)
            chunk = RAND80
            sec = ndap._encode_section(mc, chunk, mask)
            n = ndap._section_samples(mc, ndap._seg_stored_len(mc, chunk),
                                      mask)
            self.assertEqual(len(sec), n, mode)

    def test_payload_preamble_is_one_symbol_and_low_crest(self):
        self.assertEqual(ndap.PREAMBLE, 1)
        for mode in "ABC":
            mc = ndap.MODES[mode]
            a = ndap.encode_adaptive(RAND80, mode, session_id=5)
            sec = a[ndap.SND_LEN + ndap.MINI_LEN:]
            pre = sec[:mc.active]
            crest = np.abs(pre).max() / pre.std()
            self.assertLess(20 * np.log10(crest), 11.0, mode)
        snd = ndap.sounding_burst()
        self.assertLess(20 * np.log10(np.abs(snd).max() / snd.std()), 11.0)

    def test_tone_mask_on_every_mode_travels_on_the_wire(self):
        """8.1 forced Mode A to all tones; 8.2 carries the mask for A
        too (a sender that knows its channel is band-limited)."""
        mc = ndap.MODES["A"]
        mask = [1 if f <= 4000 else 0 for f in mc.grid]
        a = ndap.encode_adaptive(PAY, "A", session_id=6, tone_mask=mask)
        rep = ndap.decode_adaptive_report(pad(a))
        self.assertTrue(rep["ok"])
        _, m0 = ndap._find_burst(pad(a))
        self.assertEqual(m0["mask"], mask)
        with self.assertRaises(ValueError):
            ndap.encode_adaptive(PAY, "A", tone_mask=[1] * 5)

    def test_house_token_roundtrip(self):
        secret = b"hunter2-shared-secret"
        a = ndap.encode_adaptive(PAY, "A", session_id=21,
                                 house_secret=secret)
        rep = ndap.decode_adaptive_report(pad(a), house_secret=secret)
        self.assertTrue(rep["ok"])
        self.assertTrue(rep["house_token_ok"])
        rep = ndap.decode_adaptive_report(pad(a), house_secret=b"wrong")
        self.assertTrue(rep["ok"])
        self.assertFalse(rep["house_token_ok"])

    def test_duplex_roundtrip(self):
        da, db = bytes(range(60)), bytes(range(100, 170))
        for mode in "AB":
            mix = ndap.encode_duplex(da, db, mode, session_a=1,
                                     session_b=2)
            a, b = ndap.decode_duplex(pad(mix), mode=mode)
            self.assertEqual((a, b), (da, db), mode)


class RevisionMarker(unittest.TestCase):
    def _foreign(self, rev):
        real = ndap.WIRE_REV
        ndap.WIRE_REV = rev
        try:
            return ndap.encode_adaptive(PAY, "A", session_id=9)
        finally:
            ndap.WIRE_REV = real

    def test_foreign_revision_is_a_named_error(self):
        for rev in (0x08, 0x83, 0x00, 0xFF):
            y = pad(self._foreign(rev))
            with self.assertRaises(ndap.RevisionError) as cm:
                ndap.decode_adaptive(y)
            self.assertEqual(cm.exception.rev, rev)
            self.assertEqual(cm.exception.expected, 0x82)
            self.assertIn("revision", str(cm.exception))
            with self.assertRaises(ndap.RevisionError):
                ndap.decode_adaptive_report(y)

    def test_revision_error_is_a_value_error_never_wrong_bytes(self):
        self.assertTrue(issubclass(ndap.RevisionError, ValueError))

    def test_mini_parse_names_the_mismatch_after_crc(self):
        raw = bytearray(ndap._mini_info_bytes("A", 1, 0, 1, 10, [1] * 39))
        raw[2] = 0x83
        raw[29:31] = struct.pack(">H", ndap._crc16(bytes(raw[:29])))
        with self.assertRaises(ndap.RevisionError):
            ndap._mini_parse(bytes(raw))
        raw[2] = 0x83                  # CRC now wrong too: plain reject
        raw[29] ^= 0xFF
        self.assertIsNone(ndap._mini_parse(bytes(raw)))

    @unittest.skipIf(NDAP81 is None, "rev 8.1 module unavailable (git)")
    def test_rev81_burst_is_rejected_loudly_by_82(self):
        """Mode A shows the named error; every 8.1 burst fails loudly
        (never wrong bytes) — an 8.1 sounding that the 8.2 correlator
        cannot lock is reported as no burst found."""
        for mode in "ABC":
            y = pad(NDAP81.encode_adaptive(PAY, mode, session_id=3))
            with self.assertRaises(ValueError) as cm:
                ndap.decode_adaptive(y)
            if mode == "A":
                self.assertIsInstance(cm.exception, ndap.RevisionError)

    @unittest.skipIf(NDAP81 is None, "rev 8.1 module unavailable (git)")
    def test_rev82_burst_fails_loudly_in_81(self):
        for mode in "AC":
            y = pad(ndap.encode_adaptive(PAY, mode, session_id=3))
            with self.assertRaises(ValueError):
                NDAP81.decode_adaptive(y)


class Acquisition(unittest.TestCase):
    def test_finds_exact_start_in_padded_recording(self):
        for mode in "ABC":
            a = ndap.encode_adaptive(PAY, mode, session_id=4)
            st, mini = ndap._find_burst(pad(a, lead=21000))
            self.assertLessEqual(abs(st - 21000), 8, mode)
            self.assertEqual(mini["index"], 0)

    def test_ncc_peak_is_the_sounding_and_unambiguous(self):
        a = ndap.encode_adaptive(PAY, "A", session_id=4)
        peaks = ndap._ncc_peaks(pad(a, lead=12345))
        self.assertEqual(peaks[0][1], 12345)
        self.assertGreater(peaks[0][0], 0.99)
        if len(peaks) > 1:      # sidelobes of the chirp-sign sounding
            self.assertLess(peaks[1][0], 0.6 * peaks[0][0])

    def test_sounding_only_recording_is_locatable(self):
        snd = ndap.sounding_burst()
        self.assertEqual(ndap._find_sounding_offset(
            np.concatenate([np.zeros(5000), snd, np.zeros(2000)])), 5000)

    def test_ladder_recovers_from_offset_error(self):
        """A correlation peak that lands off the true start (as a
        filter's group delay can make it) still decodes end to end:
        the retry ladder walks the offsets and each validating one is
        checked against segment 0's payload."""
        real = ndap._ncc_peaks
        try:
            for mode in "ABC":
                a = ndap.encode_adaptive(PAY, mode, session_id=4)
                x = pad(a)
                for skew in (-230, -100, 60, 200):
                    ndap._ncc_peaks = \
                        lambda s, n=6, tail=None, k=skew: [(0.5, 14400 + k)]
                    rep = ndap.decode_adaptive_report(x)
                    self.assertTrue(rep["ok"], (mode, skew))
                    self.assertEqual(rep["data"], PAY, (mode, skew))
        finally:
            ndap._ncc_peaks = real

    def test_report_names_acquisition(self):
        y = pad(ndap.encode_adaptive(PAY, "B", session_id=3))
        rep = ndap.decode_adaptive_report(y)
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["acquisition"], "xcorr")
        rep = ndap.decode_adaptive_report(y, start=rep["start"])
        self.assertEqual(rep["acquisition"], "given")

    def test_no_legacy_finder_remains(self):
        for name in ("_find_burst_legacy", "_onset_candidates",
                     "_refined_candidates", "_sounding_score"):
            self.assertFalse(hasattr(ndap, name), name)
        self.assertNotIn("method",
                         inspect.signature(ndap._find_burst).parameters)


class ClockDrift(unittest.TestCase):
    def test_mode_a_tracks_60_ppm_across_segments(self):
        """Mode A's decode plateau is only ~+-3 samples wide, so it
        re-aligns every section (8.2). 4,000 random bytes = 2 segments
        (~2.2 s); +-60 ppm of sample-clock mismatch is ~6 samples at the
        end of the burst. (Measured limit: +-90 ppm pass, +100 fails —
        the drift inside one 1.2 s section is not tracked.)"""
        data = bytes(np.random.default_rng(6).integers(0, 256, 4000,
                                                       dtype=np.uint8))
        y = pad(ndap.encode_adaptive(data, "A", session_id=8))
        t = np.arange(len(y))
        for ppm in (60, -60):
            z = np.interp(t * (1 + ppm * 1e-6), t, y)
            rep = ndap.decode_adaptive_report(z)
            self.assertTrue(rep["ok"], (ppm, rep["error"]))
            self.assertEqual(rep["data"], data)
            self.assertEqual(len(rep["segments"]), 2)

    def test_alignment_metric_has_its_minimum_at_the_true_start(self):
        mc = ndap.MODES["A"]
        mask = [1] * 39
        a = ndap.encode_adaptive(RAND80, "A", session_id=8)
        x = pad(a)
        sec = 14400 + ndap.SND_LEN + ndap.MINI_LEN
        self.assertEqual(ndap._align_offset(mc, x, sec + 5, mask), -5)
        self.assertEqual(ndap._align_offset(mc, x, sec - 4, mask), 4)
        self.assertEqual(ndap._align_offset(mc, x, sec, mask), 0)


class Envelope(unittest.TestCase):
    def test_clean_bursts_survive_normalization(self):
        for mode in "ABC":
            a = ndap.encode_adaptive(PAY, mode, session_id=5)
            self.assertTrue(walk(pad(a), norm=True), mode)

    def test_25hz_envelope_full_decode_all_modes(self):
        for mode in "ABC":
            y = envelope(pad(ndap.encode_adaptive(PAY, mode, session_id=5)))
            self.assertTrue(walk(y, norm=True), mode)
            self.assertTrue(decodes(y), mode)

    def test_estimated_envelope_tracks_the_true_one(self):
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
        self.assertLess(ripple(out), ripple(segs) / 1.5)


class Bandpass(unittest.TestCase):
    def test_bandpass_250_4200_all_modes_with_masked_sender(self):
        for mode in "ABC":
            mc = ndap.MODES[mode]
            mask = [1 if f <= 4000.0 else 0 for f in mc.grid]
            a = ndap.encode_adaptive(PAY, mode, session_id=21,
                                     tone_mask=mask)
            self.assertTrue(decodes(bandpass(pad(a))), mode)


class Noise(unittest.TestCase):
    """The 8.2 targets, as regression tests (full tables: noise_trials.py)."""

    def _trials(self, mode, snr, n, base=0):
        ok = 0
        for k in range(n):
            a = ndap.encode_adaptive(RAND80, mode, session_id=40 + k)
            rng = np.random.default_rng(1000 * base + 100 * int(snr) + k)
            ok += decodes(awgn(pad(a), snr, rng), RAND80)
        return ok

    def test_mode_a_24_db_and_30_db(self):
        self.assertGreaterEqual(self._trials("A", 24, 3), 3)
        self.assertGreaterEqual(self._trials("A", 30, 3), 3)

    def test_mode_b_24_and_18_db(self):
        self.assertGreaterEqual(self._trials("B", 24, 3), 3)
        self.assertGreaterEqual(self._trials("B", 18, 3), 3)

    def test_mode_c_3_db(self):
        self.assertGreaterEqual(self._trials("C", 3, 3), 3)

    def test_noise_and_silence_fail_loudly(self):
        rng = np.random.default_rng(1)
        for x in (rng.normal(0, 0.1, 3 * ndap.SR), np.zeros(2 * ndap.SR),
                  rng.normal(0, 0.1, 100)):
            with self.assertRaises(ValueError):
                ndap.decode_adaptive(x)

    def test_hopeless_noise_never_yields_wrong_bytes(self):
        for mode in "AB":
            a = ndap.encode_adaptive(RAND80, mode, session_id=2)
            for snr in (6, 0):
                y = awgn(pad(a), snr, np.random.default_rng(snr + 1))
                try:
                    rep = ndap.decode_adaptive_report(y)
                except ValueError:
                    continue
                if rep["ok"]:
                    self.assertEqual(rep["data"], RAND80)
                else:
                    self.assertIsNone(rep["data"])


class StrictValidation(unittest.TestCase):
    def _info(self, idx, total, flags=0, crc_ok=True, rev=None):
        raw = bytearray(ndap._mini_info_bytes("A", 0x1234, 0, 1, 10,
                                              [1] * 39))
        raw[6], raw[7], raw[8] = idx, total, flags
        if rev is not None:
            raw[2] = rev
        crc = ndap._crc16(bytes(raw[:29])) if crc_ok else 0
        return bytes(raw[:29]) + struct.pack(">H", crc)

    def test_impossible_index_count_rejected(self):
        self.assertIsNotNone(ndap._mini_parse(self._info(0, 1)))
        self.assertIsNotNone(ndap._mini_parse(self._info(4, 5)))
        for idx, total in ((0, 0), (3, 3), (9, 2)):
            self.assertIsNone(ndap._mini_parse(self._info(idx, total)))
        self.assertIsNone(ndap._mini_parse(self._info(0, 1, crc_ok=False)))

    def test_reserved_flag_bits_rejected(self):
        self.assertIsNone(ndap._mini_parse(self._info(0, 1, flags=0x10)))
        self.assertIsNone(ndap._mini_parse(self._info(0, 1, flags=0x80)))

    def test_corruption_never_yields_wrong_bytes(self):
        """Wipe stretches of a burst at random: the decode returns the
        exact payload or raises/reports failure, in every mode."""
        rng = np.random.default_rng(5)
        data = PAY * 3
        for mode in "ABC":
            a = pad(ndap.encode_adaptive(data, mode, session_id=2))
            for _ in range(4):
                y = a.copy()
                s = int(rng.integers(14400 + ndap.SND_LEN,
                                     len(a) - 9600 - 4000))
                w = int(rng.integers(300, 4000))
                y[s:s + w] = rng.normal(0, 0.2, w)
                try:
                    rep = ndap.decode_adaptive_report(y)
                except ValueError:
                    continue
                if rep["ok"]:
                    self.assertEqual(rep["data"], data, mode)
                else:
                    self.assertIsNone(rep["data"], mode)

    def test_failed_section_does_not_break_the_chain(self):
        """8.2: the mini-header gives every section's exact length, so
        a wiped middle segment fails alone and the others still decode."""
        data = bytes(np.random.default_rng(8).integers(
            0, 256, 330, dtype=np.uint8))
        a = ndap.encode_adaptive(data, "C", session_id=2)
        mc = ndap.MODES["C"]
        seg = ndap._seg_stored_len(mc, ndap._split_work(data, mc)[0])
        one = ndap.MINI_LEN + ndap._section_samples(mc, seg, [1] * 39)
        y = pad(a)
        s = 14400 + ndap.SND_LEN + one + ndap.MINI_LEN + 2000
        y[s:s + 20000] = np.random.default_rng(1).normal(0, 0.2, 20000)
        rep = ndap.decode_adaptive_report(y)
        self.assertFalse(rep["ok"])
        self.assertEqual(rep["failed_segments"], [1])
        self.assertIn(0, rep["ok_segments"])
        self.assertIn(2, rep["ok_segments"])
        with self.assertRaises(ndap.SegmentError):
            ndap.decode_adaptive(y)


class Analysis(unittest.TestCase):
    def test_clean_channel_recommends_a_and_auto_roundtrips(self):
        snd = pad(ndap.sounding_burst())
        ana = ndap.analyze_channel(snd)
        self.assertEqual(ana["recommendation"], "A")
        audio, mode = ndap.encode_auto(PAY, snd)
        self.assertEqual(mode, "A")
        self.assertEqual(ndap.decode_adaptive(pad(audio)), PAY)

    def test_noisy_channel_steps_down(self):
        snd = pad(ndap.sounding_burst())
        rank = {"A": 3, "B": 2, "C": 1, "USE_NDAP6": 0}
        last = 4
        for snr in (30, 12, 3, -12):
            y = awgn(snd, snr, np.random.default_rng(snr + 20))
            rec = ndap.analyze_channel(y)["recommendation"]
            self.assertLessEqual(rank[rec], last, (snr, rec))
            last = rank[rec]
        self.assertEqual(rec, "USE_NDAP6")

    def test_degenerate_recordings_are_usable_answers(self):
        for x in (np.zeros(100), np.zeros(48000),
                  np.random.default_rng(0).normal(0, 0.1, 20000)):
            self.assertEqual(ndap.analyze_channel(x)["recommendation"],
                             "USE_NDAP6")


class Conformance(unittest.TestCase):
    def test_vectors(self):
        for mode in "ABC":
            with open(os.path.join(CONF, f"golden-{mode}.json")) as f:
                ref = json.load(f)
            payload = ref["payload_text"].encode()
            g = ndap.read_wav(os.path.join(CONF, ref["golden_wav"]))
            self.assertEqual(ndap.decode_adaptive(g), payload, mode)
            c = ndap.read_wav(os.path.join(CONF, ref["corrupt_wav"]))
            self.assertEqual(ndap.decode_adaptive(c), payload, mode)
            b = ndap.read_wav(os.path.join(CONF, ref["broken_wav"]))
            try:
                rep = ndap.decode_adaptive_report(b)
                self.assertFalse(rep["ok"])
                self.assertIsNone(rep["data"])
            except ValueError:
                pass

    def test_golden_is_reproducible_from_the_encoder(self):
        for mode in "ABC":
            with open(os.path.join(CONF, f"golden-{mode}.json")) as f:
                ref = json.load(f)
            a = ndap.encode_adaptive(ref["payload_text"].encode(), mode,
                                     session_id=ref["session_id"])
            g = ndap.read_wav(os.path.join(CONF, ref["golden_wav"]))
            self.assertEqual(len(a), len(g))
            self.assertLess(float(np.max(np.abs(a - g))), 2e-4)

    def test_shipped_example_decodes(self):
        """examples/ndap8-sample.wav was regenerated for 8.2 (the 8.0/8.1
        sample is a foreign revision and would raise RevisionError)."""
        p = os.path.join(ROOT, "examples", "ndap8-sample.wav")
        out = ndap.decode_adaptive(ndap.read_wav(p))
        self.assertEqual(len(out), 233)
        self.assertTrue(out.startswith(b"Mary had a little lamb,"))


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
        a = ndap.encode_adaptive(PAY, "B", session_id=77)
        y = ndap.add_expression(a, prosody_depth=0.3, gap_s=0.2)
        n_pre = len(ndap._whistle(ndap.EXPR_PRE, 1.0)) + \
            int(round(0.2 * ndap.SR))
        body = y[n_pre:n_pre + len(a)]
        nz = np.abs(a) > 1e-3
        g = body[nz] / a[nz]
        self.assertGreaterEqual(float(g.min()), 0.7 - 1e-9)
        self.assertLessEqual(float(g.max()), 1.0 + 1e-9)

    def test_expression_noise_score_matches_plain(self):
        plain = wrapped = 0
        for seed in range(3):
            a = ndap.encode_adaptive(PAY, "C", session_id=80 + seed)
            for wrap in (False, True):
                rng = np.random.default_rng(300 + seed)
                x = ndap.add_expression(a) if wrap else pad(a)
                ok = decodes(awgn(x, 12, rng))
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

    def test_time_warp_of_the_burst_is_destroyed_loudly(self):
        """Why §19 prohibits warps: a 0.3 %-1.0 % common time-scale warp
        is not decoded in modes A and C — and never as wrong bytes."""
        for mode in "AC":
            a = ndap.encode_adaptive(PAY, mode, session_id=77)
            t = np.arange(len(a))
            for warp in (1.003, 1.01):
                y = pad(np.interp(t * warp, t, a))
                try:
                    rep = ndap.decode_adaptive_report(y)
                except ValueError:
                    continue
                self.assertFalse(rep["ok"], (mode, warp))
                self.assertIsNone(rep["data"])


if __name__ == "__main__":
    unittest.main()
